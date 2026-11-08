import { createOverlay, memoryStorage, type Overlay } from '@kiwi-js/panels';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { guardAdapter } from '../src/adapter';
import { fakeAdapter, type FakeAdapter } from '../src/adapter/testkit';
import { createDebugContext } from '../src/core/context';
import { mountOverlay } from '../src/core/mount';
import { DEFAULT_ACTIONS } from '../src/core/builtin-actions';
import type { EffectiveOptions } from '../src/core/types';
import { createWatchModel, RESTORE_FOR_MS } from '../src/features/watch/model';

let fake: FakeAdapter;
let dispose: ( () => void ) | undefined;

const options = ( over: Partial<EffectiveOptions> = {} ): EffectiveOptions => ( {
    adapter: fake, key: 'Alt', trackedColors: [], actions: DEFAULT_ACTIONS, valueDetail: 'summary', profileRenders: false, scope: undefined,
    features: ['inspector', 'watch'], overlay: { storage: false as never }, ...over
} );

function page() {
    document.body.innerHTML = '<main id="app"><section id="card"></section><aside id="side"></aside></main>';
    const el = ( id: string ) => document.getElementById( id )!;
    const card = fake.world.unit( { name: 'Card', element: el( 'card' ), inputs: { title: 'Hello', n: 1 }, properties: { open: false } } );
    const dir = fake.world.unit( { name: 'Tip', kind: 'directive', element: el( 'card' ), properties: { text: 'x' } } );
    const side = fake.world.unit( { name: 'Side', element: el( 'side' ), inputs: { v: 1 } } );
    return { el, card, dir, side };
}

beforeEach( () => {
    document.body.innerHTML = '';
    fake = fakeAdapter();
    vi.spyOn( console, 'info' ).mockImplementation( () => undefined );
} );
afterEach( () => {
    dispose?.();
    dispose = undefined;
    vi.useRealTimers();
    vi.restoreAllMocks();
} );

describe( 'watch model', () => {
    let stop: ( () => void ) | undefined;
    const make = ( storage = memoryStorage(), palette?: string[] ) => {
        const overlay: Overlay = createOverlay( { storage: false } );
        const handle = createDebugContext( { overlay, adapter: guardAdapter( fake ), options: options() } );
        stop = () => {
            handle.dispose();
            overlay.dispose();
            stop = undefined;
        };
        return { model: createWatchModel( handle.ctx, { storage, path: '/p', palette } ), storage };
    };
    afterEach( () => stop?.() );

    it( 'tracks a whole unit, and toggles it off', () => {
        const { card, el } = page();
        const { model } = make();
        const target = { unit: card, element: el( 'card' ) };
        model.tracking.toggleDirectiveWatch( target );
        expect( model.tracking.isWatched( card ) ).toBe( true );
        expect( model.tracking.isWatched( card, 'inputs', 'title' ) ).toBe( true );
        expect( model.entries[0].all ).toBe( true );
        model.tracking.toggleDirectiveWatch( target );
        expect( model.entries ).toHaveLength( 0 );
    } );

    it( 'tracks single values; the last one removed removes the entry', () => {
        const { card, el } = page();
        const { model } = make();
        const target = { unit: card, element: el( 'card' ) };
        model.tracking.toggleValueWatch( target, 'inputs', 'title' );
        expect( model.tracking.isWatched( card, 'inputs', 'title' ) ).toBe( true );
        expect( model.tracking.isWatched( card, 'inputs', 'n' ) ).toBe( false );
        expect( model.rowsOf( model.entries[0] ).map( r => r.name ) ).toEqual( ['title'] );
        model.tracking.toggleValueWatch( target, 'inputs', 'title' );
        expect( model.entries ).toHaveLength( 0 );
    } );

    it( 'converts an all-entry into an explicit set when one value is untracked', () => {
        const { card, el } = page();
        const { model } = make();
        const target = { unit: card, element: el( 'card' ) };
        model.tracking.toggleDirectiveWatch( target );
        model.tracking.toggleValueWatch( target, 'inputs', 'n' );
        expect( model.entries[0].all ).toBe( false );
        expect( model.rowsOf( model.entries[0] ).map( r => r.name ).sort() ).toEqual( ['open', 'title'] );
    } );

    it( 'keeps entries of one element together and gives each element a color', () => {
        const { card, dir, side, el } = page();
        const { model } = make( memoryStorage(), ['#111', '#222'] );
        model.tracking.toggleDirectiveWatch( { unit: card, element: el( 'card' ) } );
        model.tracking.toggleDirectiveWatch( { unit: side, element: el( 'side' ) } );
        model.tracking.toggleDirectiveWatch( { unit: dir, element: el( 'card' ) } );
        expect( model.entries.map( e => e.name ) ).toEqual( ['Card', 'Tip', 'Side'] );
        expect( [model.colorOf( el( 'card' ) ), model.colorOf( el( 'side' ) )] ).toEqual( ['#111', '#222'] );
        expect( [model.indexOf( el( 'card' ) ), model.indexOf( el( 'side' ) )] ).toEqual( [1, 2] );
        model.setColor( el( 'card' ), '#333' );
        expect( model.colorOf( el( 'card' ) ) ).toBe( '#333' );
        model.toggleOutline( el( 'card' ) );
        expect( model.isOutlined( el( 'card' ) ) ).toBe( true );
    } );

    it( 'stores addresses and restores them later, never synchronously', () => {
        vi.useFakeTimers();
        const { card, side, el } = page();
        const storage = memoryStorage();
        const first = make( storage ).model;
        first.tracking.toggleValueWatch( { unit: card, element: el( 'card' ) }, 'inputs', 'title' );
        first.tracking.toggleDirectiveWatch( { unit: side, element: el( 'side' ) } );
        const stored = JSON.parse( storage.get( 'tracked:/p' )! );
        expect( Object.values( stored ) ).toEqual( [['title'], null] );
        stop!();

        const second = make( storage ).model;
        second.startRestore();
        expect( second.entries ).toHaveLength( 0 );
        vi.advanceTimersByTime( 600 );
        expect( second.entries.map( e => [e.name, e.all] ) ).toEqual( [['Card', false], ['Side', true]] );
        expect( second.rowsOf( second.entries[0] ).map( r => r.name ) ).toEqual( ['title'] );
    } );

    it( 'marks an entry as gone when its element leaves, and gives it the unit that shows up at its address', () => {
        const { card, el } = page();
        const { model } = make();
        model.tracking.toggleValueWatch( { unit: card, element: el( 'card' ) }, 'inputs', 'title' );
        const [entry] = model.entries;
        expect( model.reconcile() ).toBe( false );

        el( 'card' ).remove();
        expect( model.reconcile() ).toBe( true );
        expect( entry.gone ).toBe( true );
        expect( model.entries ).toHaveLength( 1 );

        const fresh = document.createElement( 'section' );
        el( 'app' ).prepend( fresh );
        const again = fake.world.unit( { name: 'Card', element: fresh, inputs: { title: 'Back' } } );
        expect( model.reconcile() ).toBe( true );
        expect( entry.gone ).toBe( false );
        expect( entry.unit ).toBe( again );
        expect( entry.element ).toBe( fresh );
        expect( model.rowsOf( entry ).map( r => [r.name, r.read()] ) ).toEqual( [['title', 'Back']] );
        expect( model.indexOf( fresh ) ).toBe( 1 );
    } );

    it( 'keeps the pins of an earlier page load, found again through their path', () => {
        vi.useFakeTimers();
        document.body.innerHTML = '<main id="app"><section id="card"></section></main>';
        const element = document.getElementById( 'card' )!;
        const cfg = { a: { b: 1 } };
        const unit = fake.world.unit( { name: 'Card', element, properties: { cfg } } );
        const storage = memoryStorage();
        const first = make( storage ).model;
        const pin = first.pinValue( { unit, element }, 'cfg.a', cfg.a, 'Card.cfg.a' );
        first.toggleExpression( undefined, `${pin.id}.b` );
        expect( JSON.parse( storage.get( 'pins:/p' )! ) ).toEqual( [{ id: '$1', origin: 'Card.cfg.a', paths: ['$1.b'], expression: 'cfg.a', address: '0/0=Card' }] );
        stop!();

        const second = make( storage ).model;
        second.startRestore();
        expect( second.pins.list() ).toHaveLength( 0 );
        vi.advanceTimersByTime( 600 );
        const [restored] = second.pins.list();
        expect( [restored.id, restored.origin, Array.from( restored.paths )] ).toEqual( ['$1', 'Card.cfg.a', ['$1.b']] );
        expect( second.pins.resolve( '$1' ) ).toBe( cfg.a );
        expect( second.pinValue( { unit, element }, 'cfg', cfg, 'Card.cfg' ).id ).toBe( '$2' );
        expect( second.reader.read( undefined, '$1.b' ) ).toBe( 1 );
    } );

    it( 'retries until the units exist and then gives up on the rest', () => {
        vi.useFakeTimers();
        document.body.innerHTML = '<main id="app"></main>';
        const storage = memoryStorage();
        storage.set( 'tracked:/p', JSON.stringify( { '=Late': null, '5=Never': null } ) );
        const { model } = make( storage );
        model.startRestore();
        vi.advanceTimersByTime( 2000 );
        expect( model.entries ).toHaveLength( 0 );
        fake.world.unit( { name: 'Late', element: document.body } );
        vi.advanceTimersByTime( 600 );
        expect( model.entries.map( e => e.name ) ).toEqual( ['Late'] );
        vi.advanceTimersByTime( RESTORE_FOR_MS + 1000 );
        expect( JSON.parse( storage.get( 'tracked:/p' )! ) ).toEqual( { '=Late': null } );
    } );
} );

describe( 'watch feature', () => {
    const key = ( type: 'keydown' | 'keyup', init: KeyboardEventInit ): void => {
        document.dispatchEvent( new KeyboardEvent( type, { bubbles: true, cancelable: true, composed: true, ...init } ) );
    };
    const shadow = (): ShadowRoot => document.querySelector( 'kiwi-panels' )!.shadowRoot!;
    const panelEl = (): HTMLElement => shadow().querySelector( '.kp-panel[data-panel="watch"]' )!;
    const shown = (): boolean => panelEl()?.classList.contains( 'kp-open' ) ?? false;

    /** Pins the element in the inspector and tracks its first unit with the icon in the unit's summary. */
    function trackFirstUnit( id: string ): void {
        key( 'keydown', { key: 'Alt', code: 'AltLeft', altKey: true } );
        document.getElementById( id )!.dispatchEvent( new MouseEvent( 'click', { bubbles: true, cancelable: true, composed: true, altKey: true } ) );
        shadow().querySelector<HTMLButtonElement>( '.kd-unit .kd-watch' )!.click();
    }

    it( 'opens when a unit is tracked and lists it with its values', () => {
        page();
        dispose = mountOverlay( options() );
        trackFirstUnit( 'card' );
        expect( shown() ).toBe( true );
        expect( panelEl().textContent ).toContain( 'Tracked values (1)' );
        expect( panelEl().textContent ).toContain( 'title = "Hello"' );
    } );

    it( 'shows the whole unit in a panel of its own, not in the list', () => {
        page();
        dispose = mountOverlay( options() );
        trackFirstUnit( 'card' );
        panelEl().querySelector<HTMLButtonElement>( '.kd-action-side' )!.click();
        const unit = shadow().querySelector<HTMLElement>( '.kp-panel[data-panel="unit"]' )!;
        expect( unit.classList.contains( 'kp-open' ) ).toBe( true );
        expect( unit.textContent ).toContain( 'Unit Card' );
        expect( unit.textContent ).toContain( 'title = "Hello"' );
        expect( panelEl().textContent ).not.toContain( 'Unit Card' );
    } );

    it( 'shows a hint while nothing is tracked', () => {
        page();
        dispose = mountOverlay( options() );
        key( 'keydown', { key: 't', code: 'KeyT', altKey: true } );
        expect( panelEl().textContent ).toContain( 'Track values from the inspector' );
    } );

    it( 'marks changed values of tracked units', () => {
        vi.useFakeTimers();
        const { card } = page();
        dispose = mountOverlay( options() );
        trackFirstUnit( 'card' );
        expect( panelEl().textContent ).toContain( 'n = 1' );
        card.inputs.n = 2;
        fake.world.render();
        vi.advanceTimersByTime( 300 );
        expect( panelEl().textContent ).toContain( 'n = 2' );
        expect( panelEl().textContent ).toContain( '(was 1)' );
    } );

    it( 'keeps entries whose element left the page, as waiting', () => {
        vi.useFakeTimers();
        const { el } = page();
        dispose = mountOverlay( options() );
        trackFirstUnit( 'card' );
        expect( panelEl().textContent ).toContain( 'Tracked values (1)' );
        el( 'card' ).remove();
        fake.world.render();
        vi.advanceTimersByTime( 300 );
        expect( panelEl().textContent ).toContain( 'Tracked values (1)' );
        expect( panelEl().textContent ).toContain( 'gone' );
        expect( panelEl().textContent ).toContain( 'Waiting for' );
    } );
} );
