import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { disableDebug, enableDebug, resetDebug, type ActionDef } from '../src';
import { fakeAdapter, type FakeAdapter } from '../src/adapter/testkit';
import { actionIds, createActionRegistry } from '../src/core/actions';
import { DEFAULT_ACTIONS } from '../src/core/builtin-actions';

const def = ( id: string, over: Partial<ActionDef> = {} ): ActionDef => ( { id, icon: id, title: id, run: () => undefined, ...over } );

describe( 'action registry', () => {
    it( 'resolves names in configured order and skips unknown ones', () => {
        const registry = createActionRegistry( { row: ['b', 'missing', 'a'], unit: [] } );
        registry.register( 'row', def( 'a' ) );
        registry.register( 'row', def( 'b' ) );
        expect( registry.resolve( 'row', 'inspector' ).map( d => d.id ) ).toEqual( ['b', 'a'] );
    } );

    it( 'accepts definitions in the list, which need no registration', () => {
        const custom = def( 'mine' );
        const registry = createActionRegistry( { row: [custom, 'a'], unit: [] } );
        registry.register( 'row', def( 'a' ) );
        expect( registry.resolve( 'row', 'watch' ) ).toEqual( [custom, expect.objectContaining( { id: 'a' } )] );
    } );

    it( 'keeps actions to their surfaces and scopes', () => {
        const registry = createActionRegistry( { row: ['a'], unit: ['a'] } );
        registry.register( 'row', def( 'a', { surfaces: ['watch'] } ) );
        registry.register( 'unit', def( 'a' ) );
        expect( registry.resolve( 'row', 'inspector' ) ).toHaveLength( 0 );
        expect( registry.resolve( 'row', 'watch' ) ).toHaveLength( 1 );
        expect( registry.resolve( 'unit', 'inspector' ) ).toHaveLength( 1 );
    } );

    it( 'unregisters', () => {
        const registry = createActionRegistry( { row: ['a'], unit: [] } );
        const off = registry.register( 'row', def( 'a' ) );
        off();
        expect( registry.resolve( 'row', 'watch' ) ).toHaveLength( 0 );
    } );

    it( 'lists ids of a configuration', () => {
        expect( actionIds( ['a', def( 'b' )] ) ).toEqual( ['a', 'b'] );
    } );
} );

describe( 'actions in the overlay', () => {
    let fake: FakeAdapter;
    const shadow = (): ShadowRoot => document.querySelector( 'kiwi-panels' )!.shadowRoot!;
    const key = ( type: 'keydown' | 'keyup', init: KeyboardEventInit ): void => {
        document.dispatchEvent( new KeyboardEvent( type, { bubbles: true, cancelable: true, composed: true, ...init } ) );
    };

    /** Pins the card in the inspector. */
    function pin(): void {
        key( 'keydown', { key: 'Alt', code: 'AltLeft', altKey: true } );
        document.getElementById( 'card' )!.dispatchEvent( new MouseEvent( 'click', { bubbles: true, cancelable: true, composed: true, altKey: true } ) );
        key( 'keyup', { key: 'Alt', code: 'AltLeft', altKey: false } );
    }
    const rowButtons = (): string[] => Array.from( shadow().querySelectorAll( '.kd-unit .kd-row:first-of-type .kd-action' ), b => b.className.match( /kd-action-(\S+)/ )![1] );
    const unitButtons = (): string[] => Array.from( shadow().querySelectorAll( '.kd-unit > summary > .kp-row > .kd-action' ), b => b.className.match( /kd-action-(\S+)/ )![1] );

    beforeEach( () => {
        document.body.innerHTML = '<div id="card"></div>';
        fake = fakeAdapter();
        fake.world.unit( { name: 'Card', element: document.getElementById( 'card' ), inputs: { title: 'T' } } );
        localStorage.clear();
        vi.spyOn( console, 'info' ).mockImplementation( () => undefined );
    } );
    afterEach( () => {
        resetDebug();
        vi.restoreAllMocks();
    } );

    it( 'shows the default buttons without configuration', () => {
        enableDebug( { adapter: fake, features: ['inspector', 'watch'], overlay: { storage: false as never } } );
        pin();
        expect( unitButtons() ).toEqual( ['track', 'address'] );
        expect( rowButtons() ).toEqual( ['track', 'inspect'] );
        expect( DEFAULT_ACTIONS.row ).toEqual( ['track', 'graph', 'inspect'] );
    } );

    it( 'shows only the configured buttons, by name', () => {
        enableDebug( { adapter: fake, features: ['inspector', 'watch'], overlay: { storage: false as never }, actions: { row: [], unit: ['track'] } } );
        pin();
        expect( rowButtons() ).toEqual( [] );
        expect( unitButtons() ).toEqual( ['track'] );
    } );

    it( 'runs a custom action with the row and the target', () => {
        const run = vi.fn();
        const custom: ActionDef = { id: 'copy', icon: '⧉', title: row => `Copy ${row.row?.name}`, run };
        enableDebug( { adapter: fake, features: ['inspector'], overlay: { storage: false as never }, actions: { row: ['track', custom] } } );
        pin();
        const button = shadow().querySelector<HTMLButtonElement>( '.kd-action-copy' )!;
        expect( button.title ).toBe( 'Copy title' );
        expect( button.textContent ).toBe( '⧉' );
        button.click();
        expect( run ).toHaveBeenCalledTimes( 1 );
        const [c] = run.mock.calls[0];
        expect( [c.surface, c.row.name, c.target.element.id] ).toEqual( ['inspector', 'title', 'card'] );
    } );

    it( 'shows toggle state, honours visible and survives a throwing handler', () => {
        let on = false;
        const toggle: ActionDef = { id: 'flag', icon: 'F', title: 'Flag', isOn: () => on, run: () => void ( on = !on ) };
        const hidden: ActionDef = { id: 'hidden', icon: 'H', title: 'Hidden', visible: () => false, run: () => undefined };
        const broken: ActionDef = {
            id: 'broken', icon: 'B', title: 'Broken', run: () => {
                throw new Error( 'x' );
            }
        };
        enableDebug( { adapter: fake, features: ['inspector'], overlay: { storage: false as never }, actions: { row: [toggle, hidden, broken] } } );
        pin();
        const flag = shadow().querySelector<HTMLButtonElement>( '.kd-action-flag' )!;
        expect( shadow().querySelector( '.kd-action-hidden' ) ).toBeNull();
        flag.click();
        expect( flag.classList.contains( 'kp-on' ) ).toBe( true );
        expect( () => shadow().querySelector<HTMLButtonElement>( '.kd-action-broken' )!.click() ).not.toThrow();
    } );

    it( 'rebuilds the overlay when the action list changes', async () => {
        enableDebug( { adapter: fake, features: ['inspector'], overlay: { storage: false as never } } );
        const first = document.querySelector( 'kiwi-panels' );
        const off = enableDebug( { actions: { row: [] } } );
        expect( document.querySelector( 'kiwi-panels' ) ).not.toBe( first );
        off();
        await Promise.resolve();
        expect( document.querySelectorAll( 'kiwi-panels' ) ).toHaveLength( 1 );
        disableDebug();
    } );
} );
