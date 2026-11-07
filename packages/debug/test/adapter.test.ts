import { describe, expect, it, vi } from 'vitest';
import {
    ADAPTER_CONTRACT, checkAdapter, defineAdapter, guardAdapter, type FrameworkAdapter, type ReactiveNode
} from '../src/adapter';

const boom = (): never => {
    throw new Error( 'boom' );
};

const base = (): FrameworkAdapter => defineAdapter( {
    meta: { contract: ADAPTER_CONTRACT, id: 'x', name: 'X' },
    env: { isDev: () => true },
    units: { at: () => [], describe: () => ( { name: 'U', kind: 'component', element: null } ), members: () => [] }
} );

describe( 'checkAdapter', () => {
    it( 'accepts the current contract', () => {
        expect( checkAdapter( base() ) ).toBeUndefined();
    } );

    it( 'names the mismatch', () => {
        const adapter = { ...base(), meta: { contract: 99, id: 'old', name: 'Old' } };
        expect( checkAdapter( adapter ) ).toBe( `adapter "old" implements contract 99, core supports ${ADAPTER_CONTRACT}` );
    } );

    it( 'rejects something that is not an adapter', () => {
        expect( checkAdapter( undefined ) ).toMatch( /lacks/ );
        expect( checkAdapter( { meta: base().meta } as unknown as FrameworkAdapter ) ).toMatch( /lacks/ );
    } );
} );

describe( 'guardAdapter', () => {
    it( 'keeps absent capabilities and methods absent', () => {
        const guarded = guardAdapter( base() );
        expect( guarded.reactivity ).toBeUndefined();
        expect( guarded.forms ).toBeUndefined();
        expect( guarded.profiler ).toBeUndefined();
        expect( guarded.addressing ).toBeUndefined();
        expect( guarded.env.runOutside ).toBeUndefined();
        expect( guarded.units.sections ).toBeUndefined();
    } );

    it( 'turns throws into neutral values', () => {
        const guarded = guardAdapter( {
            ...base(),
            env: { isDev: boom, onRender: boom, taskSource: boom },
            units: { at: boom, describe: boom, members: boom, owner: boom, sections: boom },
            addressing: { of: boom, resolve: boom },
            profiler: { start: boom }
        } );
        expect( guarded.env.isDev() ).toBe( false );
        expect( guarded.env.taskSource!() ).toBeUndefined();
        expect( () => guarded.env.onRender!( () => undefined )() ).not.toThrow();
        expect( guarded.units.at( document.body ) ).toEqual( [] );
        expect( guarded.units.describe( {} ).name ).toBe( '?' );
        expect( guarded.units.members( {} ) ).toEqual( [] );
        expect( guarded.units.owner!( document.body ) ).toBeUndefined();
        expect( guarded.units.sections!( document.body ) ).toEqual( [] );
        expect( guarded.addressing!.of( {}, document.body ) ).toBeUndefined();
        expect( guarded.addressing!.resolve( 'a' ) ).toBeUndefined();
        expect( () => guarded.profiler!.start( () => undefined )() ).not.toThrow();
    } );

    it( 'does not let a throwing render callback reach the framework', () => {
        let fire = (): void => undefined;
        const guarded = guardAdapter( { ...base(), env: { isDev: () => true, onRender: cb => ( fire = cb, () => undefined ) } } );
        guarded.env.onRender!( boom );
        expect( fire ).not.toThrow();
    } );

    it( 'guards instance and keeps it absent when the adapter has none', () => {
        expect( guardAdapter( base() ).units.instance ).toBeUndefined();
        const guarded = guardAdapter( { ...base(), units: { ...base().units, instance: boom } } );
        expect( guarded.units.instance!( {} ) ).toBeUndefined();
    } );

    it( 'guards sections lazily', () => {
        const guarded = guardAdapter( {
            ...base(),
            units: { ...base().units, sections: () => [{ id: 's', label: 'S', read: boom, list: boom }] }
        } );
        const [section] = guarded.units.sections!( document.body );
        expect( section.read() ).toBeUndefined();
        expect( section.list!() ).toEqual( [] );
    } );

    it( 'wraps reactive nodes once, with safe reads', () => {
        const raw: ReactiveNode = {
            kind: 'signal', holdsValue: true, version: 3, dirty: false,
            producers: () => [], consumers: () => [raw], peek: () => 7
        };
        const throwing = {
            get version(): number { return boom(); },
            kind: 'computed', holdsValue: true, dirty: false, producers: boom, consumers: boom, peek: () => 1
        } as unknown as ReactiveNode;
        const listeners: Array<( node: ReactiveNode ) => void> = [];
        const guarded = guardAdapter( {
            ...base(),
            reactivity: { nodeOf: v => v === 1 ? raw : v === 2 ? throwing : boom(), onWrite: cb => ( listeners.push( cb ), () => undefined ) }
        } );
        const node = guarded.reactivity!.nodeOf( 1 )!;
        expect( guarded.reactivity!.nodeOf( 1 ) ).toBe( node );
        expect( node.version ).toBe( 3 );
        expect( node.peek() ).toBe( 7 );
        expect( node.consumers()[0] ).toBe( node );
        expect( guarded.reactivity!.nodeOf( 3 ) ).toBeUndefined();

        const bad = guarded.reactivity!.nodeOf( 2 )!;
        expect( bad.version ).toBe( 0 );
        expect( bad.producers() ).toEqual( [] );

        const seen = vi.fn();
        guarded.reactivity!.onWrite( seen );
        listeners[0]( raw );
        expect( seen ).toHaveBeenCalledWith( node );
    } );

    it( 'wraps form nodes', () => {
        const child = { raw: {}, key: 'c', kind: 'control', model: 'm', children: () => [], state: () => ( { value: 1, status: 'valid', errors: [], touched: false, dirty: false } ) } as const;
        const root = { raw: {}, key: 'r', kind: 'group', model: 'm', children: () => [child], state: boom, actions: () => [{ id: 'a', label: 'A', run: boom }] } as const;
        const guarded = guardAdapter( { ...base(), forms: { scan: () => [{ root: root as never }] } } );
        const [binding] = guarded.forms!.scan();
        expect( binding.root.children()[0].key ).toBe( 'c' );
        expect( binding.root.state().status ).toBe( 'valid' );
        expect( () => binding.root.actions!()[0].run() ).not.toThrow();
        expect( guarded.forms!.scan()[0].root ).toBe( binding.root );
    } );
} );
