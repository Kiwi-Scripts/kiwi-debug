import { createOverlay, memoryStorage, type Overlay } from '@kiwi-js/panels';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enableDebug, resetDebug } from '../src';
import { guardAdapter } from '../src/adapter';
import { fakeAdapter, type FakeAdapter } from '../src/adapter/testkit';
import { DEFAULT_ACTIONS } from '../src/core/builtin-actions';
import { createDebugContext } from '../src/core/context';
import { preview } from '../src/core/format';
import type { EffectiveOptions } from '../src/core/types';
import { createWatchModel } from '../src/features/watch/model';

let fake: FakeAdapter;

function world() {
    document.body.innerHTML = '<main id="app"><section id="card"></section><aside id="side"></aside></main>';
    const el = ( id: string ) => document.getElementById( id )!;
    const card = fake.world.unit( {
        name: 'Card', element: el( 'card' ),
        inputs: { items: [{ name: 'a', tags: ['x'] }, { name: 'b', tags: [] }], plain: 5, label: 'L' },
        state: { secret: { deep: { n: 1 } } }
    } );
    return { el, card };
}

describe( 'expressions in the watch model', () => {
    let overlay: Overlay;
    const make = ( storage = memoryStorage() ) => {
        overlay = createOverlay( { storage: false } );
        const options = { adapter: fake, key: 'Alt', trackedColors: [], actions: DEFAULT_ACTIONS, valueDetail: 'summary', profileRenders: false, scope: undefined, features: [], overlay: {} } as EffectiveOptions;
        const handle = createDebugContext( { overlay, adapter: guardAdapter( fake ), options } );
        return { handle, storage, model: createWatchModel( handle.ctx, { storage, path: '/p' } ) };
    };
    beforeEach( () => void ( fake = fakeAdapter() ) );
    afterEach( () => overlay?.dispose() );

    it( 'tracks a path as an expression row of the entry, in canonical form', () => {
        const { el, card } = world();
        const { model } = make();
        const target = { unit: card, element: el( 'card' ) };
        expect( model.toggleExpression( target, ' items [ 1 ] . name ' ) ).toBe( true );
        expect( model.entries[0].selected.has( 'items[1].name' ) ).toBe( true );
        expect( model.isExpressionTracked( card, 'items[1].name' ) ).toBe( true );
        const [row] = model.rowsOf( model.entries[0] );
        expect( [row.category, row.name, row.read()] ).toEqual( ['expressions', 'items[1].name', 'b'] );
        expect( model.toggleExpression( target, 'items[1].name' ) ).toBe( false );
        expect( model.entries ).toHaveLength( 0 );
    } );

    it( 'starts a path at the instance, which has more than the members', () => {
        const { el, card } = world();
        const { model } = make();
        model.toggleExpression( { unit: card, element: el( 'card' ) }, 'secret.deep.n' );
        expect( model.rowsOf( model.entries[0] )[0].read() ).toBe( 1 );
    } );

    it( 'falls back to members, with their alias, when the adapter has no instance', () => {
        const adapter = fakeAdapter();
        ( adapter.units as { instance?: unknown } ).instance = undefined;
        fake = adapter;
        const { el, card } = world();
        const { model } = make();
        model.toggleExpression( { unit: card, element: el( 'card' ) }, 'items[0].name' );
        expect( model.rowsOf( model.entries[0] )[0].read() ).toBe( 'a' );
    } );

    it( 'reads an unreachable path as a value that says why', () => {
        const { el, card } = world();
        const { model } = make();
        model.toggleExpression( { unit: card, element: el( 'card' ) }, 'items[5].name' );
        const value = model.rowsOf( model.entries[0] )[0].read();
        expect( preview( value ) ).toBe( '⊘ items[5] is undefined' );
        model.toggleExpression( { unit: card, element: el( 'card' ) }, 'items[0]' );
        expect( preview( model.reader.read( card, 'items[' ) ) ).toContain( '⊘ expected' );
    } );

    it( 'treats a one-step expression as the member itself', () => {
        const { el, card } = world();
        const { model } = make();
        const target = { unit: card, element: el( 'card' ) };
        model.tracking.toggleValueWatch( target, 'inputs', 'plain' );
        expect( model.toggleExpression( target, 'plain' ) ).toBe( false );
        expect( model.entries ).toHaveLength( 0 );
        model.toggleExpression( target, 'plain' );
        expect( model.tracking.isWatched( card, 'inputs', 'plain' ) ).toBe( true );
        expect( model.rowsOf( model.entries[0] ).map( r => [r.category, r.name] ) ).toEqual( [['inputs', 'plain']] );
    } );

    it( 'keeps expressions when an all-entry loses a member, and when it is toggled as a whole', () => {
        const { el, card } = world();
        const { model } = make();
        const target = { unit: card, element: el( 'card' ) };
        model.tracking.toggleDirectiveWatch( target );
        model.toggleExpression( target, 'items[0].name' );
        expect( model.rowsOf( model.entries[0] ).map( r => r.name ) ).toEqual( ['items', 'plain', 'label', 'items[0].name'] );
        model.tracking.toggleValueWatch( target, 'inputs', 'plain' );
        expect( model.entries[0].all ).toBe( false );
        expect( model.rowsOf( model.entries[0] ).map( r => r.name ).sort() ).toEqual( ['items', 'items[0].name', 'label'] );
    } );

    it( 'stores and restores members and expressions together', () => {
        vi.useFakeTimers();
        const { el, card } = world();
        const storage = memoryStorage();
        const target = { unit: card, element: el( 'card' ) };
        const first = make( storage ).model;
        first.tracking.toggleDirectiveWatch( target );
        first.toggleExpression( target, 'items[0].name' );
        expect( Object.values( JSON.parse( storage.get( 'tracked:/p' )! ) ) ).toEqual( [['*', 'items[0].name']] );
        overlay.dispose();

        const second = make( storage ).model;
        second.startRestore();
        vi.advanceTimersByTime( 600 );
        expect( second.entries[0].all ).toBe( true );
        expect( Array.from( second.entries[0].selected ) ).toEqual( ['items[0].name'] );
        vi.useRealTimers();
    } );

    it( 'tracks paths from a pin, which holds its object', () => {
        const { card } = world();
        const { model } = make();
        const object = { users: [{ name: 'Ann' }] };
        const pin = model.pins.pin( object, 'Card.thing' );
        expect( model.pins.pin( object, 'again' ) ).toBe( pin );
        expect( pin.id ).toBe( '$1' );
        expect( model.toggleExpression( undefined, '$1.users[0].name' ) ).toBe( true );
        expect( Array.from( pin.paths ) ).toEqual( ['$1.users[0].name'] );
        expect( model.reader.read( undefined, '$1.users[0].name' ) ).toBe( 'Ann' );
        expect( model.isExpressionTracked( undefined, '$1.users[0].name' ) ).toBe( true );
        expect( model.toggleExpression( undefined, '$1.users[0].name' ) ).toBe( false );
        expect( model.toggleExpression( undefined, '$9.x' ) ).toBeUndefined();
        model.pins.remove( '$1' );
        expect( preview( model.reader.read( card, '$1.users' ) ) ).toBe( '⊘ $1 is not pinned' );
    } );
} );

describe( 'the inspect panel', () => {
    const shadow = (): ShadowRoot => document.querySelector( 'kiwi-panels' )!.shadowRoot!;
    const panelEl = ( id: string ): HTMLElement => shadow().querySelector( `.kp-panel[data-panel="${id}"]` )!;
    const isOpen = ( id: string ): boolean => panelEl( id )?.classList.contains( 'kp-open' ) ?? false;
    const key = ( type: 'keydown' | 'keyup', init: KeyboardEventInit ): void => {
        document.dispatchEvent( new KeyboardEvent( type, { bubbles: true, cancelable: true, composed: true, ...init } ) );
    };
    const input = (): HTMLInputElement => panelEl( 'inspect' ).querySelector( 'input' )!;
    const type = ( text: string ): void => {
        input().value = text;
        input().dispatchEvent( new Event( 'input' ) );
    };
    const button = ( label: string ): HTMLButtonElement => Array.from( panelEl( 'inspect' ).querySelectorAll<HTMLButtonElement>( 'button' ) ).find( b => b.textContent === label )!;

    /** Pins the card in the inspector and opens the inspect panel from the row of `name`. */
    function inspectRow( name: string ): void {
        key( 'keydown', { key: 'Alt', code: 'AltLeft', altKey: true } );
        document.getElementById( 'card' )!.dispatchEvent( new MouseEvent( 'click', { bubbles: true, cancelable: true, composed: true, altKey: true } ) );
        key( 'keyup', { key: 'Alt', code: 'AltLeft', altKey: false } );
        const row = Array.from( shadow().querySelectorAll( '.kd-unit .kd-row' ) ).find( r => r.querySelector( '.kd-name' )?.textContent === name )!;
        row.querySelector<HTMLButtonElement>( '.kd-action-inspect' )!.click();
    }

    beforeEach( () => {
        localStorage.clear();
        fake = fakeAdapter();
        world();
        vi.spyOn( console, 'info' ).mockImplementation( () => undefined );
        enableDebug( { adapter: fake, features: ['inspector', 'watch'], overlay: { storage: false as never } } );
    } );
    afterEach( () => {
        resetDebug();
        vi.useRealTimers();
        vi.restoreAllMocks();
    } );

    it( 'opens from a row, starting at the property, without a tray button of its own', () => {
        inspectRow( 'items' );
        expect( isOpen( 'inspect' ) ).toBe( true );
        expect( input().value ).toBe( 'items' );
        expect( panelEl( 'inspect' ).textContent ).toContain( 'Inspect · Card' );
        expect( panelEl( 'inspect' ).textContent ).toContain( 'Array(2)' );
        expect( shadow().querySelector( '.kp-tray [data-panel="inspect"]' ) ).toBeNull();
    } );

    it( 'follows the path that is typed and says when it cannot', () => {
        inspectRow( 'items' );
        type( 'items[1].name' );
        expect( panelEl( 'inspect' ).textContent ).toContain( '"b"' );
        type( 'items[7].name' );
        expect( panelEl( 'inspect' ).querySelector( '.kd-error' )!.textContent ).toBe( '⊘ items[7] is undefined' );
        type( 'items(' );
        expect( panelEl( 'inspect' ).querySelector( '.kd-error' )!.textContent ).toContain( 'calls are not allowed' );
    } );

    it( 'extends the path when a name in the tree is clicked', () => {
        inspectRow( 'items' );
        panelEl( 'inspect' ).querySelector<HTMLElement>( '.kd-node-row' )!.click();
        const first = Array.from( panelEl( 'inspect' ).querySelectorAll<HTMLElement>( '.kd-name' ) ).find( n => n.textContent === '0' )!;
        first.click();
        expect( input().value ).toBe( 'items[0]' );
        expect( panelEl( 'inspect' ).textContent ).toContain( 'name: "a"' );
    } );

    it( 're-evaluates when the value changes', () => {
        vi.useFakeTimers();
        inspectRow( 'plain' );
        expect( panelEl( 'inspect' ).textContent ).toContain( '5' );
        const unit = fake.world.unitsAt( document.getElementById( 'card' )! )[0];
        unit.inputs.plain = 6;
        fake.world.render();
        vi.advanceTimersByTime( 300 );
        expect( panelEl( 'inspect' ).textContent ).toContain( '6' );
    } );

    it( 'tracks the path in the watch list, and stops again', () => {
        inspectRow( 'items' );
        type( 'items[0].name' );
        button( 'Track' ).click();
        expect( isOpen( 'watch' ) ).toBe( true );
        expect( panelEl( 'watch' ).textContent ).toContain( 'items[0].name = "a"' );
        expect( button( 'Track' ).classList.contains( 'kp-on' ) ).toBe( true );
        button( 'Track' ).click();
        expect( panelEl( 'watch' ).textContent ).not.toContain( 'items[0].name' );
    } );

    it( 'shows tracked paths in the watch list as expression rows and lets them be inspected again', () => {
        inspectRow( 'items' );
        type( 'secret.deep.n' );
        button( 'Track' ).click();
        const row = Array.from( panelEl( 'watch' ).querySelectorAll( '.kd-row' ) ).find( r => r.textContent?.includes( 'secret.deep.n' ) )!;
        expect( row.querySelector( '.kd-expressions' ) ).toBeTruthy();
        panelEl( 'inspect' ).querySelector( 'input' )!.value = '';
        row.querySelector<HTMLButtonElement>( '.kd-action-inspect' )!.click();
        expect( input().value ).toBe( 'secret.deep.n' );
    } );

    it( 'pins an object as a reference and continues from it', () => {
        inspectRow( 'items' );
        type( 'items[1]' );
        button( 'Pin' ).click();
        expect( input().value ).toBe( '$1' );
        expect( isOpen( 'watch' ) ).toBe( true );
        expect( panelEl( 'watch' ).textContent ).toContain( 'References' );
        expect( panelEl( 'watch' ).textContent ).toContain( 'Card.items[1]' );
        // The value stands for the pin in the title: no "$1 =" again, and the preview shows the name.
        expect( panelEl( 'watch' ).textContent ).not.toContain( '$1 =' );
        expect( panelEl( 'watch' ).textContent ).toContain( '{ name: "b", … }' );
        type( '$1.name' );
        expect( panelEl( 'inspect' ).textContent ).toContain( '"b"' );
        button( 'Track' ).click();
        expect( panelEl( 'watch' ).textContent ).toContain( '$1.name = "b"' );
    } );

    it( 'cannot pin a value that is not an object', () => {
        inspectRow( 'plain' );
        expect( button( 'Pin' ).disabled ).toBe( true );
    } );

    it( 'removes a reference from the watch list', () => {
        inspectRow( 'items' );
        button( 'Pin' ).click();
        panelEl( 'watch' ).querySelector<HTMLButtonElement>( '.kd-pin summary button' )!.click();
        expect( panelEl( 'watch' ).textContent ).not.toContain( 'References' );
    } );

    const nav = ( label: string ): HTMLButtonElement => Array.from( panelEl( 'inspect' ).querySelectorAll<HTMLButtonElement>( '.kd-inspect-bar button' ) ).find( b => b.textContent === label )!;

    it( 'remembers what the input is replaced by, and walks back and forward through it', () => {
        inspectRow( 'items' );
        expect( [nav( '‹' ).disabled, nav( '›' ).disabled] ).toEqual( [true, true] );
        type( 'items[1]' );
        button( 'Pin' ).click();
        expect( input().value ).toBe( '$1' );
        expect( nav( '‹' ).disabled ).toBe( false );
        nav( '‹' ).click();
        expect( input().value ).toBe( 'items[1]' );
        expect( nav( '‹' ).disabled ).toBe( true );
        nav( '›' ).click();
        expect( input().value ).toBe( '$1' );
        expect( nav( '›' ).disabled ).toBe( true );
    } );

    it( 'remembers a path that is tracked, and the input of an earlier opening', () => {
        inspectRow( 'items' );
        type( 'items[0].name' );
        button( 'Track' ).click();
        type( 'items[1].name' );
        nav( '‹' ).click();
        expect( input().value ).toBe( 'items[0].name' );
        // Opened again from another row: the input that was there is kept.
        const row = Array.from( shadow().querySelectorAll( '.kd-unit .kd-row' ) ).find( r => r.querySelector( '.kd-name' )?.textContent === 'plain' )!;
        row.querySelector<HTMLButtonElement>( '.kd-action-inspect' )!.click();
        expect( input().value ).toBe( 'plain' );
        nav( '‹' ).click();
        expect( input().value ).toBe( 'items[0].name' );
    } );

    it( 'keeps at most 20 entries', () => {
        inspectRow( 'items' );
        for ( let i = 0; i < 30; i++ ) {
            type( `items[${i}]` );
            button( 'Track' ).click();
            button( 'Track' ).click();
        }
        let steps = 0;
        while ( !nav( '‹' ).disabled && steps < 100 ) {
            nav( '‹' ).click();
            steps++;
        }
        expect( steps ).toBeLessThanOrEqual( 20 );
        expect( steps ).toBeGreaterThan( 10 );
    } );

    it( 'closes on Escape', () => {
        inspectRow( 'items' );
        const esc = new KeyboardEvent( 'keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true } );
        document.dispatchEvent( esc );
        expect( esc.defaultPrevented ).toBe( true );
        expect( isOpen( 'inspect' ) ).toBe( false );
    } );

    it( 'is left out of the rows when the actions are listed without it', () => {
        resetDebug();
        document.body.innerHTML = '';
        fake = fakeAdapter();
        world();
        enableDebug( { adapter: fake, features: ['inspector', 'watch'], overlay: { storage: false as never }, actions: { row: ['track'] } } );
        key( 'keydown', { key: 'Alt', code: 'AltLeft', altKey: true } );
        document.getElementById( 'card' )!.dispatchEvent( new MouseEvent( 'click', { bubbles: true, cancelable: true, composed: true, altKey: true } ) );
        expect( shadow().querySelector( '.kd-action-inspect' ) ).toBeNull();
    } );
} );
