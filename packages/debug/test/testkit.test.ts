import { beforeEach, describe, expect, it } from 'vitest';
import { assertConformance, fakeAdapter, runAdapterConformance } from '../src/adapter/testkit';

function page(): { host: HTMLElement; child: HTMLElement } {
    document.body.innerHTML = '<div id="host"><span id="child"></span></div>';
    return { host: document.getElementById( 'host' )!, child: document.getElementById( 'child' )! };
}

describe( 'fakeAdapter', () => {
    beforeEach( () => void ( document.body.innerHTML = '' ) );

    it( 'lists the component first and exposes members', () => {
        const { host } = page();
        const adapter = fakeAdapter();
        const dir = adapter.world.unit( { name: 'Tooltip', kind: 'directive', element: host } );
        const comp = adapter.world.unit( { name: 'Card', element: host, inputs: { title: 'x' }, properties: { n: 1 } } );
        expect( adapter.units.at( host ) ).toEqual( [comp, dir] );
        expect( adapter.units.describe( comp ) ).toEqual( { name: 'Card', kind: 'component', element: host } );
        expect( adapter.units.members( comp ).map( m => [m.group, m.name, m.read()] ) ).toEqual( [['inputs', 'title', 'x'], ['properties', 'n', 1]] );
    } );

    it( 'gives each unit one live instance that shows members and own state', () => {
        const { host } = page();
        const adapter = fakeAdapter();
        const unit = adapter.world.unit( { name: 'Card', element: host, inputs: { title: 'x' }, state: { secret: 1 } } );
        const instance = adapter.units.instance!( unit ) as Record<string, unknown>;
        expect( adapter.units.instance!( unit ) ).toBe( instance );
        expect( [instance.title, instance.secret, 'title' in instance, 'nope' in instance] ).toEqual( ['x', 1, true, false] );
        unit.inputs.title = 'y';
        expect( instance.title ).toBe( 'y' );
        expect( Object.keys( instance ).sort() ).toEqual( ['secret', 'title'] );
    } );

    it( 'provides only the requested capabilities', () => {
        const adapter = fakeAdapter( { capabilities: ['addressing'] } );
        expect( adapter.reactivity ).toBeUndefined();
        expect( adapter.forms ).toBeUndefined();
        expect( adapter.profiler ).toBeUndefined();
        expect( adapter.addressing ).toBeDefined();
    } );

    it( 'propagates writes through computed values and counts template runs', () => {
        const { host } = page();
        const adapter = fakeAdapter();
        const { world } = adapter;
        const a = world.signal( 1, 'a' );
        const double = world.computed( () => a.peek() * 2, [a], 'double' );
        const template = world.template( host, [double] );
        const writes: unknown[] = [];
        adapter.reactivity!.onWrite( node => writes.push( node ) );

        template.run();
        expect( [double.peek(), template.runs, template.dirty] ).toEqual( [2, 1, false] );
        a.set( 5 );
        expect( writes ).toEqual( [a] );
        expect( [a.version, double.dirty, template.dirty, double.peek()] ).toEqual( [1, true, true, 2] );
        template.run();
        expect( double.peek() ).toBe( 10 );
        a.set( 5 );
        expect( a.version ).toBe( 1 );
    } );

    it( 'builds form state from the tree', () => {
        const { host } = page();
        const { world } = fakeAdapter();
        const name = world.control( 'name', { value: 'a' } );
        const age = world.control( 'age', { value: 3 } );
        const root = world.group( 'form', [name, age] );
        world.addForm( root, host );
        const events: string[] = [];
        root.watch( ev => void events.push( `${ev.kind}:${ev.node.key}` ) );
        name.errors.push( ['required', true] );
        age.setValue( 4 );
        expect( root.state().value ).toEqual( { name: 'a', age: 4 } );
        expect( root.state().status ).toBe( 'invalid' );
        expect( root.state().dirty ).toBe( true );
        expect( events ).toEqual( ['value:age'] );
    } );

    it( 'delivers profile events only while listening', () => {
        const adapter = fakeAdapter();
        const seen: string[] = [];
        adapter.world.span( 'render', undefined );
        const stop = adapter.profiler!.start( ev => void seen.push( `${ev.phase}:${ev.kind}` ) );
        expect( adapter.world.profilerActive ).toBe( true );
        adapter.world.span( 'render', undefined );
        stop();
        adapter.world.span( 'render', undefined );
        expect( seen ).toEqual( ['begin:render', 'end:render'] );
        expect( adapter.world.profilerActive ).toBe( false );
    } );
} );

describe( 'runAdapterConformance', () => {
    function world() {
        const { host, child } = page();
        const adapter = fakeAdapter();
        const sig = adapter.world.signal( 1, 'count' );
        const unit = adapter.world.unit( { name: 'Card', element: host, inputs: { count: sig } } );
        adapter.world.unit( { name: 'Dir', kind: 'directive', element: host } );
        adapter.world.template( host, [sig] );
        return { adapter, host, child, sig, unit };
    }

    it( 'passes for the fake adapter', () => {
        const { adapter, host, child, sig, unit } = world();
        const report = runAdapterConformance( adapter, {
            elements: [host, child],
            mutate: () => sig.set( 2 ),
            emitProfile: () => adapter.world.span( 'render', unit ),
            profilerHookInstalled: () => adapter.world.profilerActive
        } );
        assertConformance( report );
        expect( report.passed ).toEqual( expect.arrayContaining( ['contract', 'identity', 'instance', 'no-throw', 'units-order', 'node-symmetry', 'version-monotonic', 'addressing', 'profiler-balance', 'profiler-zero-cost'] ) );
    } );

    it( 'skips checks of absent capabilities', () => {
        const adapter = fakeAdapter( { capabilities: [] } );
        const report = runAdapterConformance( adapter, { elements: [] } );
        assertConformance( report );
        expect( report.skipped ).toEqual( expect.arrayContaining( ['addressing', 'profiler-balance'] ) );
    } );

    it( 'reports an unsupported contract', () => {
        const report = runAdapterConformance( fakeAdapter( { contract: 99 } ), { elements: [] } );
        expect( report.failures.map( f => f.check ) ).toEqual( ['contract'] );
        expect( () => assertConformance( report ) ).toThrow( /contract 99/ );
    } );

    it( 'finds unbalanced profile events, unstable identity and a hook that stays', () => {
        const { adapter, host } = world();
        const broken = {
            ...adapter,
            units: { ...adapter.units, at: () => [{}] },
            profiler: { start: () => () => undefined }
        };
        const report = runAdapterConformance( broken, {
            elements: [host],
            emitProfile: () => undefined,
            profilerHookInstalled: () => true
        } );
        const failed = report.failures.map( f => f.check );
        expect( failed ).toContain( 'identity' );
        expect( failed ).toContain( 'profiler-zero-cost' );
    } );

    it( 'finds a broken producer/consumer symmetry', () => {
        const { adapter, host, sig } = world();
        sig.consumerNodes.length = 0;
        const report = runAdapterConformance( adapter, { elements: [host] } );
        expect( report.failures.map( f => f.check ) ).toContain( 'node-symmetry' );
    } );
} );
