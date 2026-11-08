import { createOverlay, type Overlay } from '@kiwi-js/panels';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enableDebug, resetDebug } from '../src';
import { guardAdapter } from '../src/adapter';
import { fakeAdapter, type FakeAdapter } from '../src/adapter/testkit';
import { DEFAULT_ACTIONS } from '../src/core/builtin-actions';
import { createDebugContext } from '../src/core/context';
import type { EffectiveOptions } from '../src/core/types';
import { layoutGraph, MAX_WIDTH, MIN_WIDTH, NODE_HEIGHT } from '../src/features/graph/layout';
import { buildGraph, connectedTo, describeNode, elementsOf, GRAPH_LIMIT, idOf, indexOwners } from '../src/features/graph/model';
import { changesOf, createOrigins, createRecorder, locationOf, MAX_FRAMES, stateAt } from '../src/features/graph/recorder';

let fake: FakeAdapter;
let overlay: Overlay | undefined;

/** count → doubled → template, in a component; and a nameless computed that only the template reads. */
function world( withContext = true ) {
    document.body.innerHTML = '<main id="app"><section id="card"></section></main>';
    const element = document.getElementById( 'card' )!;
    const count = fake.world.signal( 1, 'count' );
    const doubled = fake.world.computed( () => count.peek() * 2, [count], 'doubled' );
    const hidden = fake.world.computed( () => doubled.get() + 1, [doubled] );
    const template = fake.world.template( element, [doubled, hidden] );
    const unit = fake.world.unit( { name: 'Card', element, inputs: { count }, properties: { doubled } } );
    const ctx = withContext ? context() : undefined;
    const guarded = ( node: object ) => ctx?.adapter.reactivity?.nodeOf( node ) as never;
    return { element, count, doubled, hidden, template, unit, ctx: ctx!, g: ctx ? { count: guarded( count ), doubled: guarded( doubled ), hidden: guarded( hidden ), template: guarded( template ), of: guarded } : undefined! };
}

function context() {
    overlay = createOverlay( { storage: false } );
    const options = { adapter: fake, key: 'Alt', trackedColors: [], actions: DEFAULT_ACTIONS, valueDetail: 'summary', profileRenders: false, scope: undefined, features: [], overlay: {} } as unknown as EffectiveOptions;
    return createDebugContext( { overlay, adapter: guardAdapter( fake ), options } ).ctx;
}

beforeEach( () => void ( fake = fakeAdapter() ) );
afterEach( () => overlay?.dispose() );

describe( 'graph model', () => {
    it( 'names nodes after the member that holds them, and the render node template', () => {
        const w = world();
        const owners = indexOwners( w.ctx );
        expect( describeNode( w.g.count, owners ) ).toEqual( { name: 'count', context: 'Card' } );
        expect( describeNode( w.g.doubled, owners ) ).toEqual( { name: 'doubled', context: 'Card' } );
        expect( describeNode( w.g.template, owners ) ).toEqual( { name: 'template', context: 'Card' } );
    } );

    it( 'names a nameless node after the nearest consumer that has an owner', () => {
        const w = world();
        const owners = indexOwners( w.ctx );
        expect( describeNode( w.g.hidden, owners ) ).toEqual( { name: 'template ▸ computed', context: 'Card internal' } );
    } );

    it( 'builds up, down and both from a root, without the siblings of the root', () => {
        const w = world();
        const owners = indexOwners( w.ctx );
        const names = ( direction: 'up' | 'down' | 'both' ) => buildGraph( [w.g.doubled], direction, owners ).nodes.map( n => n.name ).sort();
        expect( names( 'up' ) ).toEqual( ['count', 'doubled'] );
        expect( names( 'down' ) ).toEqual( ['doubled', 'template', 'template ▸ computed'] );
        expect( names( 'both' ) ).toHaveLength( 4 );
        const graph = buildGraph( [w.g.doubled], 'both', owners );
        expect( graph.edges ).toHaveLength( 4 );
        expect( graph.nodes.find( n => n.name === 'doubled' )!.root ).toBe( true );
        expect( graph.truncated ).toBe( false );
    } );

    it( 'keeps ids stable, shows values only for nodes that hold one, and does not follow siblings', () => {
        const w = world();
        const owners = indexOwners( w.ctx );
        const other = fake.world.computed( () => 0, [w.count], 'other' );
        const graph = buildGraph( [w.g.doubled], 'both', owners );
        expect( graph.nodes.some( n => n.node === other ) ).toBe( false );
        expect( graph.nodes.find( n => n.node === w.g.count )!.id ).toBe( idOf( w.g.count ) );
        expect( graph.nodes.find( n => n.name === 'count' )!.valueText ).toBe( '1' );
        expect( graph.nodes.find( n => n.name === 'template' )!.valueText ).toBeUndefined();
    } );

    it( 'stops at the limit and says so', () => {
        const root = fake.world.signal( 0, 'root' );
        for ( let i = 0; i < GRAPH_LIMIT + 20; i++ ) {
            fake.world.computed( () => i, [root], `c${i}` );
        }
        const graph = buildGraph( [root], 'down', new Map() );
        expect( [graph.nodes.length, graph.truncated] ).toEqual( [GRAPH_LIMIT, true] );
    } );

    it( 'finds the elements of a node: its owner, or the render nodes that read it', () => {
        const w = world();
        const owners = indexOwners( w.ctx );
        expect( elementsOf( w.g.count, owners ) ).toEqual( [w.element] );
        const service = fake.world.signal( 0, 'service' );
        fake.world.template( w.element, [service] );
        expect( elementsOf( w.g.of( service ) ) ).toEqual( [w.element] );
    } );

    it( 'finds what is connected to a node, up and down but not sideways', () => {
        const edges = [{ from: 1, to: 2 }, { from: 2, to: 3 }, { from: 1, to: 4 }];
        expect( Array.from( connectedTo( 2, edges ) ).sort() ).toEqual( [1, 2, 3] );
    } );
} );

describe( 'graph layout', () => {
    it( 'puts producers left of their consumers and keeps nodes apart', () => {
        const nodes = [1, 2, 3, 4].map( id => ( { id, lines: [`node ${id}`] } ) );
        const layout = layoutGraph( nodes, [{ from: 1, to: 3 }, { from: 2, to: 3 }, { from: 3, to: 4 }] );
        const box = ( id: number ) => layout.boxes.get( id )!;
        expect( box( 1 ).x ).toBeLessThan( box( 3 ).x );
        expect( box( 3 ).x ).toBeLessThan( box( 4 ).x );
        expect( box( 1 ).y ).not.toBe( box( 2 ).y );
        expect( layout.width ).toBeGreaterThan( box( 4 ).x + box( 4 ).w );
    } );

    it( 'sizes a node by its longest line, within limits', () => {
        const layout = layoutGraph( [{ id: 1, lines: ['a'] }, { id: 2, lines: ['x'.repeat( 200 )] }], [] );
        expect( layout.boxes.get( 1 )!.w ).toBe( MIN_WIDTH );
        expect( layout.boxes.get( 2 )!.w ).toBe( MAX_WIDTH );
    } );

    it( 'pulls a source next to the node that reads it, instead of the left edge', () => {
        const nodes = [1, 2, 3, 4].map( id => ( { id, lines: [`n${id}`] } ) );
        // 1 → 2 → 3, and 4 is only read by 3.
        const layout = layoutGraph( nodes, [{ from: 1, to: 2 }, { from: 2, to: 3 }, { from: 4, to: 3 }] );
        expect( layout.boxes.get( 4 )!.x ).toBe( layout.boxes.get( 2 )!.x );
        expect( layout.boxes.get( 1 )!.x ).toBeLessThan( layout.boxes.get( 2 )!.x );
    } );

    it( 'orders the nodes of a column so that edges do not cross', () => {
        const nodes = [1, 2, 3, 4].map( id => ( { id, lines: [`n${id}`] } ) );
        // 1 feeds 4 and 2 feeds 3: in the order of the input they would cross.
        const layout = layoutGraph( nodes, [{ from: 1, to: 4 }, { from: 2, to: 3 }] );
        const y = ( id: number ) => layout.boxes.get( id )!.y;
        expect( ( y( 1 ) - y( 2 ) ) * ( y( 4 ) - y( 3 ) ) ).toBeGreaterThan( 0 );
    } );

    it( 'keeps a value that only one node reads close to that node, and does not let it pull the reader away', () => {
        // 1 → 2 → 3 → 4 (the reader), 5 → 4 (the lone value), and a few more nodes that crowd the columns.
        const ids = [1, 2, 3, 4, 5, 6, 7, 8];
        const nodes = ids.map( id => ( { id, lines: [`n${id}`] } ) );
        const layout = layoutGraph( nodes, [{ from: 1, to: 2 }, { from: 2, to: 3 }, { from: 3, to: 4 }, { from: 5, to: 4 }, { from: 6, to: 3 }, { from: 7, to: 3 }, { from: 8, to: 2 }] );
        const center = ( id: number ) => layout.boxes.get( id )!.y + layout.boxes.get( id )!.h / 2;
        expect( Math.abs( center( 5 ) - center( 4 ) ) ).toBeLessThanOrEqual( NODE_HEIGHT * 2 );
        expect( Math.abs( center( 4 ) - center( 3 ) ) ).toBeLessThanOrEqual( NODE_HEIGHT * 2 );
    } );

    it( 'lays out a cart the way a person would: one spine, straight side chains, the long line on the outside', () => {
        const names = ['coupon', 'subtotal', 'discount', 'freeShipping', 'shipping', 'tax', 'total', 'label', 'template', 'currency', 'taxRate', 'lt1', 'lt2', 'lt3', 'qty1', 'qty2', 'qty3', 'draft'];
        const id = ( name: string ): number => names.indexOf( name ) + 1;
        const pairs: Array<[string, string]> = [
            ['qty1', 'lt1'], ['qty2', 'lt2'], ['qty3', 'lt3'], ['lt1', 'subtotal'], ['lt2', 'subtotal'], ['lt3', 'subtotal'],
            ['coupon', 'discount'], ['subtotal', 'freeShipping'], ['discount', 'freeShipping'], ['freeShipping', 'shipping'],
            ['subtotal', 'tax'], ['discount', 'tax'], ['taxRate', 'tax'],
            ['subtotal', 'total'], ['discount', 'total'], ['tax', 'total'], ['shipping', 'total'],
            ['total', 'label'], ['currency', 'label'], ['label', 'template'], ['total', 'draft'], ['coupon', 'draft']
        ];
        const layout = layoutGraph( names.map( name => ( { id: id( name ), lines: [name] } ) ), pairs.map( ( [from, to] ) => ( { from: id( from ), to: id( to ) } ) ) );
        const y = ( name: string ): number => layout.boxes.get( id( name ) )!.y;
        const same = ( ...group: string[] ): void => group.forEach( name => expect( y( name ) ).toBeCloseTo( y( group[0] ), 0 ) );
        // The spine, through the middle one of the three line totals.
        same( 'qty2', 'lt2', 'subtotal', 'freeShipping', 'shipping', 'total', 'label', 'template' );
        // Straight side chains: the others around the spine, one above and one below.
        same( 'qty1', 'lt1' );
        same( 'qty3', 'lt3' );
        expect( y( 'qty1' ) ).toBeLessThan( y( 'qty2' ) );
        expect( y( 'qty3' ) ).toBeGreaterThan( y( 'qty2' ) );
        same( 'discount', 'tax' );
        // The longest line, from the coupon to the draft, is on the outside, beyond the other chains.
        same( 'coupon', 'draft' );
        expect( y( 'coupon' ) ).toBeGreaterThan( y( 'discount' ) );
        // A value that only feeds the label is above the spine, and the tax rate is between two lines, not on one.
        expect( y( 'currency' ) ).toBeLessThan( y( 'label' ) );
        expect( y( 'taxRate' ) ).toBeGreaterThan( y( 'discount' ) );
        expect( y( 'taxRate' ) ).toBeLessThan( y( 'coupon' ) );
    } );

    describe( 'placement rules', () => {
        const place = ( count: number, edges: Array<[number, number]> ) => {
            const layout = layoutGraph( Array.from( { length: count }, ( _, i ) => ( { id: i + 1, lines: [`n${i + 1}`] } ) ), edges.map( ( [from, to] ) => ( { from, to } ) ) );
            return { layout, center: ( id: number ) => layout.boxes.get( id )!.y + layout.boxes.get( id )!.h / 2, box: ( id: number ) => layout.boxes.get( id )! };
        };

        it( 'puts the longest chain on one axis, with the others around it', () => {
            // 1 → 2 → 3 → 4 is the longest; 5 and 6 merge into it.
            const { center, box } = place( 6, [[1, 2], [2, 3], [3, 4], [5, 3], [6, 2]] );
            for ( const id of [2, 3, 4] ) {
                expect( center( id ) ).toBeCloseTo( center( 1 ), 2 );
            }
            // The others do not overlap the axis nodes.
            for ( const id of [5, 6] ) {
                expect( Math.abs( center( id ) - center( 1 ) ) ).toBeGreaterThanOrEqual( box( id ).h );
            }
        } );

        it( 'puts a consumer level with its main producer, not at the average of its producers', () => {
            // 1 → 2 → 4, and 3 → 4 where 3 stands alone: 2 is the main producer of 4.
            const { center } = place( 5, [[1, 2], [2, 4], [3, 4], [5, 3]] );
            expect( center( 4 ) ).toBeCloseTo( center( 2 ), 0 );
        } );

        it( 'moves a lone producer aside a little, so that it does not block the straight way of a longer chain', () => {
            // 1 → 2 → 3 → 4 → 5 is the spine; 6 feeds 5 late, in the column of 4.
            const { center, box } = place( 6, [[1, 2], [2, 3], [3, 4], [4, 5], [6, 5]] );
            expect( center( 5 ) ).toBeCloseTo( center( 4 ), 0 );
            const gap = Math.abs( center( 6 ) - center( 4 ) );
            expect( gap ).toBeGreaterThanOrEqual( box( 6 ).h );
            expect( gap ).toBeLessThanOrEqual( box( 6 ).h * 2 );
        } );
    } );

    it( 'survives a cycle', () => {
        const layout = layoutGraph( [{ id: 1, lines: ['a'] }, { id: 2, lines: ['b'] }], [{ from: 1, to: 2 }, { from: 2, to: 1 }] );
        expect( layout.boxes.size ).toBe( 2 );
    } );
} );

describe( 'recorder', () => {
    it( 'stores only differences, and nothing when there are none', () => {
        const w = world();
        const owners = indexOwners( w.ctx );
        let time = 0;
        const recorder = createRecorder( () => time );
        const graph = () => buildGraph( [w.g.doubled], 'both', owners );
        expect( recorder.capture( graph(), 'a' ) ).toBe( true );
        time = 40;
        expect( recorder.capture( graph(), 'a' ) ).toBe( false );
        w.count.set( 5 );
        w.doubled.get();
        time = 80;
        expect( recorder.capture( graph(), 'a' ) ).toBe( true );
        const timeline = recorder.compile();
        expect( timeline.frames ).toHaveLength( 2 );
        expect( timeline.frames[1].time ).toBe( 80 );
        const changed = Array.from( timeline.frames[1].changed.keys() ).map( id => timeline.nodes.get( id )!.name );
        expect( changed ).toContain( 'count' );
        expect( changed ).toContain( 'doubled' );
        expect( changed ).not.toContain( 'template' );
    } );

    it( 'replays the state at every frame and says what changed', () => {
        const w = world();
        const owners = indexOwners( w.ctx );
        const recorder = createRecorder( () => 0 );
        const graph = () => buildGraph( [w.g.count], 'down', owners );
        recorder.capture( graph(), 'x' );
        w.count.set( 2 );
        w.doubled.get();
        recorder.capture( graph(), 'x', new Map( [[idOf( w.g.count ), { trigger: 'click on <button>' }]] ) );
        const timeline = recorder.compile();
        const first = stateAt( timeline, 0 );
        const second = stateAt( timeline, 1 );
        expect( first.nodes.get( idOf( w.g.count ) )!.version ).toBe( 0 );
        expect( second.nodes.get( idOf( w.g.count ) )!.version ).toBe( 1 );
        expect( changesOf( timeline, 0 ) ).toEqual( [] );
        const lines = changesOf( timeline, 1 );
        expect( lines.find( l => l.text.startsWith( 'count' ) )!.cause?.trigger ).toBe( 'click on <button>' );
        expect( lines.find( l => l.text.startsWith( 'doubled' ) )!.via ).toBe( 'count' );
    } );

    it( 'notes edges only when the structure changes, and lays out everything once', () => {
        const w = world();
        const owners = indexOwners( w.ctx );
        const recorder = createRecorder( () => 0 );
        recorder.capture( buildGraph( [w.g.count], 'down', owners ), 'one' );
        fake.world.computed( () => 0, [w.count], 'late' );
        w.count.set( 9 );
        recorder.capture( buildGraph( [w.g.count], 'down', owners ), 'two' );
        const timeline = recorder.compile();
        expect( timeline.frames[0].edgesAdded.length ).toBeGreaterThan( 0 );
        expect( timeline.frames[1].edgesAdded ).toHaveLength( 1 );
        expect( timeline.layout.boxes.size ).toBe( timeline.nodes.size );
        expect( timeline.size.width ).toBeGreaterThan( 0 );
    } );

    it( 'stops itself at the frame limit', () => {
        const signal = fake.world.signal( 0, 's' );
        const recorder = createRecorder( () => 0 );
        for ( let i = 0; i <= MAX_FRAMES + 5; i++ ) {
            signal.set( i + 1 );
            recorder.capture( buildGraph( [signal], 'both', new Map() ) );
        }
        expect( recorder.limited ).toBe( true );
        expect( recorder.frameCount ).toBe( MAX_FRAMES );
        expect( recorder.compile().limited ).toBe( true );
    } );
} );

describe( 'origins', () => {
    it( 'notes the trigger of a write of a known node, once, and hands it over', () => {
        const w = world();
        const origins = createOrigins( w.ctx, node => node === w.g.count );
        origins.start();
        w.count.set( 2 );
        w.count.set( 3 );
        w.doubled.get();
        const taken = origins.take();
        expect( Array.from( taken.keys() ) ).toEqual( [idOf( w.g.count )] );
        expect( taken.get( idOf( w.g.count ) )!.trigger ).toBe( 'unknown, outside of an event or task' );
        expect( origins.take().size ).toBe( 0 );
        origins.stop();
        w.count.set( 4 );
        expect( origins.take().size ).toBe( 0 );
    } );

    it( 'finds the first frame that is not the framework\'s', () => {
        const error = new Error();
        error.stack = 'Error\n    at set (/fw/signal.ts:1:1)\n    at onClick (/app/card.ts:10:5)';
        expect( locationOf( { trigger: 't', error }, /\/fw\// ) ).toBe( 'at onClick (/app/card.ts:10:5)' );
        expect( locationOf( { trigger: 't', error }, /./ ) ).toBe( 'framework internal' );
        expect( locationOf( { trigger: 't' } ) ).toBeUndefined();
    } );
} );

describe( 'graph panel', () => {
    const shadow = (): ShadowRoot => document.querySelector( 'kiwi-panels' )!.shadowRoot!;
    const panelEl = (): HTMLElement => shadow().querySelector( '.kp-panel[data-panel="graph"]' )!;
    const key = ( type: 'keydown' | 'keyup', init: KeyboardEventInit ): void => {
        document.dispatchEvent( new KeyboardEvent( type, { bubbles: true, cancelable: true, composed: true, ...init } ) );
    };
    const toolButton = ( text: string ): HTMLButtonElement => Array.from( panelEl().querySelectorAll<HTMLButtonElement>( '.kd-graph-tools button' ) ).find( b => b.textContent === text )!;
    /** The record button lives in the header, so that it stays when the panel is folded. */
    const headerButton = ( text: string ): HTMLButtonElement => Array.from( panelEl().querySelectorAll<HTMLButtonElement>( '.kp-header button' ) ).find( b => b.textContent === text )!;
    const replayButton = ( text: string ): HTMLButtonElement => Array.from( panelEl().querySelectorAll<HTMLButtonElement>( '.kd-replay-controls button' ) ).find( b => b.textContent === text )!;

    /** Mounts the overlay and opens the graph over the card with the hotkey. */
    function openGraph(): ReturnType<typeof world> {
        const w = world( false );
        enableDebug( { adapter: fake, features: ['graph'], overlay: { storage: false as never } } );
        vi.spyOn( document, 'elementFromPoint' ).mockReturnValue( document.getElementById( 'card' ) );
        key( 'keydown', { key: 'Alt', code: 'AltLeft', altKey: true } );
        key( 'keydown', { key: 'g', code: 'KeyG', altKey: true } );
        return w;
    }

    beforeEach( () => {
        localStorage.clear();
        overlay = undefined;
        fake = fakeAdapter();
        vi.spyOn( console, 'info' ).mockImplementation( () => undefined );
        vi.spyOn( console, 'group' ).mockImplementation( () => undefined );
        vi.spyOn( console, 'log' ).mockImplementation( () => undefined );
        vi.spyOn( console, 'groupEnd' ).mockImplementation( () => undefined );
    } );
    afterEach( () => {
        resetDebug();
        vi.useRealTimers();
        vi.restoreAllMocks();
    } );

    it( 'is only there when the adapter has reactivity', () => {
        world( false );
        enableDebug( { adapter: fake, features: ['graph'], overlay: { storage: false as never } } );
        expect( shadow().querySelector( '.kp-tray [data-panel="graph"]' ) ).toBeTruthy();
        resetDebug();
        enableDebug( { adapter: fakeAdapter( { capabilities: [] } ), features: ['graph'], overlay: { storage: false as never } } );
        expect( document.querySelector( 'kiwi-panels' )?.shadowRoot?.querySelector( '.kp-tray [data-panel="graph"]' ) ?? null ).toBeNull();
    } );

    it( 'opens over the element under the pointer on the hotkey, draws its graph, and closes on the hotkey again', () => {
        openGraph();
        expect( panelEl().classList.contains( 'kp-open' ) ).toBe( true );
        expect( panelEl().querySelector( '.kp-title' )!.textContent ).toContain( 'Signal graph · ' );
        const names = Array.from( panelEl().querySelectorAll( '.kd-gname' ), t => t.textContent );
        expect( names ).toEqual( expect.arrayContaining( ['count', 'doubled', 'template'] ) );
        expect( panelEl().querySelectorAll( '.kd-gedge' ).length ).toBeGreaterThan( 0 );
        key( 'keydown', { key: 'g', code: 'KeyG', altKey: true } );
        expect( panelEl().classList.contains( 'kp-open' ) ).toBe( false );
    } );

    it( 'follows a write: the value changes and the node pulses', () => {
        vi.useFakeTimers();
        const w = openGraph();
        expect( panelEl().textContent ).toContain( 'v0 = 1' );
        w.count.set( 7 );
        vi.advanceTimersByTime( 600 );
        expect( panelEl().textContent ).toContain( 'v1 = 7' );
        expect( panelEl().querySelector( '.kd-pulse' ) ).toBeTruthy();
    } );

    it( 'changes the direction', () => {
        openGraph();
        expect( toolButton( '↔' ).classList.contains( 'kp-on' ) ).toBe( true );
        toolButton( '←' ).click();
        expect( toolButton( '←' ).classList.contains( 'kp-on' ) ).toBe( true );
        expect( toolButton( '↔' ).classList.contains( 'kp-on' ) ).toBe( false );
        expect( panelEl().querySelectorAll( '.kd-gnode' ).length ).toBeGreaterThan( 0 );
    } );

    it( 'records, stops, and replays frame by frame with the trigger of a change', () => {
        vi.useFakeTimers();
        const w = openGraph();
        headerButton( '● Rec' ).click();
        expect( headerButton( '■ Stop' ) ).toBeTruthy();
        expect( panelEl().classList.contains( 'kp-collapsed' ) ).toBe( true );
        w.count.set( 5 );
        w.doubled.get();
        vi.advanceTimersByTime( 120 );
        w.count.set( 6 );
        w.doubled.get();
        vi.advanceTimersByTime( 120 );
        headerButton( '■ Stop' ).click();
        expect( panelEl().classList.contains( 'kp-collapsed' ) ).toBe( false );
        expect( panelEl().querySelector( '.kd-replay-label' )!.textContent ).toMatch( /^1 \/ 3/ );
        replayButton( '›' ).click();
        expect( panelEl().querySelector( '.kd-replay-label' )!.textContent ).toMatch( /^2 \/ 3/ );
        expect( panelEl().querySelector( '.kd-replay-list' )!.textContent ).toContain( 'count: version 0 → 1' );
        expect( panelEl().querySelector( '.kd-replay-list' )!.textContent ).toContain( '← unknown, outside of an event or task' );
        expect( panelEl().querySelector( '.kd-changed' ) ).toBeTruthy();
        replayButton( 'Live' ).click();
        expect( panelEl().querySelector( '.kd-replay-controls' ) ).toBeNull();
    } );

    it( 'keeps the stop button in the header while the panel is folded at the top center', () => {
        vi.useFakeTimers();
        openGraph();
        headerButton( '● Rec' ).click();
        expect( panelEl().classList.contains( 'kp-collapsed' ) ).toBe( true );
        expect( panelEl().style.top ).toBe( '8px' );
        expect( Number.parseInt( panelEl().style.left ) ).toBeGreaterThan( 0 );
        expect( panelEl().querySelector( '.kp-title' )!.textContent ).toContain( 'Recording' );
        headerButton( '■ Stop' ).click();
        expect( panelEl().classList.contains( 'kp-collapsed' ) ).toBe( false );
        expect( panelEl().style.top ).toBe( '8px' );
    } );

    it( 'starts and stops a recording with the hotkey plus shift, opening the panel if it is closed', () => {
        vi.useFakeTimers();
        world( false );
        enableDebug( { adapter: fake, features: ['graph'], overlay: { storage: false as never } } );
        vi.spyOn( document, 'elementFromPoint' ).mockReturnValue( document.getElementById( 'card' ) );
        key( 'keydown', { key: 'Alt', code: 'AltLeft', altKey: true } );
        key( 'keydown', { key: 'G', code: 'KeyG', altKey: true, shiftKey: true } );
        expect( panelEl().classList.contains( 'kp-open' ) ).toBe( true );
        expect( panelEl().classList.contains( 'kp-collapsed' ) ).toBe( true );
        expect( panelEl().style.top ).toBe( '8px' );
        key( 'keydown', { key: 'G', code: 'KeyG', altKey: true, shiftKey: true } );
        expect( panelEl().querySelector( '.kd-replay-controls' ) ).toBeTruthy();
    } );

    it( 'stops a recording on the first close, and closes on the second', () => {
        vi.useFakeTimers();
        openGraph();
        headerButton( '● Rec' ).click();
        panelEl().querySelector<HTMLButtonElement>( 'button[title="Close"]' )!.click();
        expect( panelEl().classList.contains( 'kp-open' ) ).toBe( true );
        expect( panelEl().querySelector( '.kd-replay-controls' ) ).toBeTruthy();
        panelEl().querySelector<HTMLButtonElement>( 'button[title="Close"]' )!.click();
        expect( panelEl().classList.contains( 'kp-open' ) ).toBe( false );
    } );

    it( 'lights a node that is clicked, with its neighbours, and logs it', () => {
        openGraph();
        const node = ( name: string ): SVGElement => Array.from( panelEl().querySelectorAll<SVGElement>( '.kd-gnode' ) ).find( n => n.querySelector( '.kd-gname' )!.textContent === name )!;
        const press = ( el: Element, type: string ): void => void el.dispatchEvent( new PointerEvent( type, { bubbles: true, button: 0, clientX: 5, clientY: 5 } ) );
        press( node( 'doubled' ), 'pointerdown' );
        press( node( 'doubled' ), 'pointerup' );
        expect( node( 'doubled' ).classList.contains( 'kd-focused' ) ).toBe( true );
        expect( panelEl().querySelectorAll( '.kd-dim' ).length ).toBe( 0 );
        expect( console.group ).toHaveBeenCalled();
        press( node( 'count' ), 'pointerdown' );
        press( node( 'count' ), 'pointerup' );
        expect( node( 'count' ).classList.contains( 'kd-focused' ) ).toBe( true );
        expect( node( 'doubled' ).classList.contains( 'kd-focused' ) ).toBe( false );
        // A press on the background lets go.
        press( panelEl().querySelector( '.kd-graph-view svg' )!, 'pointerdown' );
        press( panelEl().querySelector( '.kd-graph-view svg' )!, 'pointerup' );
        expect( panelEl().querySelector( '.kd-focused' ) ).toBeNull();
    } );

    it( 'updates the nodes in place when only their state changed, and has no transitions', () => {
        vi.useFakeTimers();
        const w = openGraph();
        const before = Array.from( panelEl().querySelectorAll( '.kd-gnode' ) );
        w.count.set( 9 );
        vi.advanceTimersByTime( 600 );
        const after = Array.from( panelEl().querySelectorAll( '.kd-gnode' ) );
        expect( after ).toHaveLength( before.length );
        expect( after.every( ( node, i ) => node === before[i] ) ).toBe( true );
        expect( panelEl().textContent ).toContain( 'v1 = 9' );
        expect( panelEl().querySelector( '.kd-pulse' ) ).toBeTruthy();
        vi.advanceTimersByTime( 1000 );
        expect( panelEl().querySelector( '.kd-pulse' ) ).toBeNull();
    } );

    it( 'moves a node by dragging it, with its edges, and puts it back on Arrange', () => {
        openGraph();
        const node = panelEl().querySelector<SVGElement>( '.kd-gnode' )!;
        const before = node.getAttribute( 'transform' );
        const edgeBefore = Array.from( panelEl().querySelectorAll( '.kd-gedge' ), p => p.getAttribute( 'd' ) );
        node.dispatchEvent( new PointerEvent( 'pointerdown', { bubbles: true, button: 0, clientX: 5, clientY: 5 } ) );
        node.dispatchEvent( new PointerEvent( 'pointermove', { bubbles: true, clientX: 65, clientY: 45 } ) );
        node.dispatchEvent( new PointerEvent( 'pointerup', { bubbles: true, clientX: 65, clientY: 45 } ) );
        expect( node.getAttribute( 'transform' ) ).not.toBe( before );
        expect( Array.from( panelEl().querySelectorAll( '.kd-gedge' ), p => p.getAttribute( 'd' ) ) ).not.toEqual( edgeBefore );
        expect( panelEl().querySelector( '.kd-focused' ) ).toBeNull();
        toolButton( 'Arrange' ).click();
        expect( panelEl().querySelector<SVGElement>( '.kd-gnode' )!.getAttribute( 'transform' ) ).toBe( before );
    } );

    it( 'draws the edges of the node in focus on top, in their own color', () => {
        openGraph();
        const node = Array.from( panelEl().querySelectorAll<SVGElement>( '.kd-gnode' ) ).find( n => n.querySelector( '.kd-gname' )!.textContent === 'doubled' )!;
        const press = ( type: string ): void => void node.dispatchEvent( new PointerEvent( type, { bubbles: true, button: 0, clientX: 5, clientY: 5 } ) );
        press( 'pointerdown' );
        press( 'pointerup' );
        const hot = Array.from( panelEl().querySelectorAll( '.kd-hot-layer .kd-gedge' ) );
        // doubled has one producer and two consumers.
        expect( hot ).toHaveLength( 3 );
        expect( hot.every( edge => edge.classList.contains( 'kd-hot' ) ) ).toBe( true );
        press( 'pointerdown' );
        press( 'pointerup' );
        expect( panelEl().querySelectorAll( '.kd-hot-layer .kd-gedge' ) ).toHaveLength( 0 );
        expect( panelEl().querySelectorAll( '.kd-hot' ) ).toHaveLength( 0 );
    } );

    it( 'does not click a node when the press turned into a drag', () => {
        openGraph();
        const node = panelEl().querySelector<SVGElement>( '.kd-gnode' )!;
        node.dispatchEvent( new PointerEvent( 'pointerdown', { bubbles: true, button: 0, clientX: 5, clientY: 5 } ) );
        node.dispatchEvent( new PointerEvent( 'pointermove', { bubbles: true, clientX: 40, clientY: 5 } ) );
        node.dispatchEvent( new PointerEvent( 'pointerup', { bubbles: true, clientX: 40, clientY: 5 } ) );
        expect( panelEl().querySelector( '.kd-focused' ) ).toBeNull();
    } );

    it( 'has a legend for the kinds of nodes', () => {
        openGraph();
        expect( panelEl().querySelector( '.kd-graph-legend' )!.textContent ).toContain( 'computed' );
    } );

    it( 'picks an element on the page for the graph', () => {
        const w = openGraph();
        const other = document.createElement( 'div' );
        document.body.append( other );
        fake.world.unit( { name: 'Other', element: other, inputs: { n: fake.world.signal( 1, 'n' ) } } );
        void w;
        toolButton( '⌖ Pick' ).click();
        expect( panelEl().style.visibility ).toBe( 'hidden' );
        other.dispatchEvent( new MouseEvent( 'click', { bubbles: true, cancelable: true, composed: true } ) );
        expect( panelEl().style.visibility ).toBe( '' );
        expect( Array.from( panelEl().querySelectorAll( '.kd-gname' ), t => t.textContent ) ).toContain( 'n' );
    } );

    it( 'stops a recording with Escape', () => {
        vi.useFakeTimers();
        openGraph();
        headerButton( '● Rec' ).click();
        key( 'keydown', { key: 'Escape', code: 'Escape' } );
        expect( panelEl().querySelector( '.kd-replay-controls' ) ).toBeTruthy();
    } );
} );
