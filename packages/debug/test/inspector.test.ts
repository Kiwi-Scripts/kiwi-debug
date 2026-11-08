import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeAdapter, type FakeAdapter } from '../src/adapter/testkit';
import { DEFAULT_ACTIONS } from '../src/core/builtin-actions';
import { mountOverlay } from '../src/core/mount';
import type { DebugFeature, EffectiveOptions } from '../src/core/types';

let fake: FakeAdapter;
let dispose: ( () => void ) | undefined;

const options = ( over: Partial<EffectiveOptions> = {} ): EffectiveOptions => ( {
    adapter: fake, key: 'Alt', trackedColors: [], actions: DEFAULT_ACTIONS, valueDetail: 'summary', profileRenders: false, scope: undefined,
    features: ['inspector'], overlay: { storage: false as never }, ...over
} );

const host = (): HTMLElement => document.querySelector( 'kiwi-panels' ) as HTMLElement;
const rawPanel = (): HTMLElement | null => host().shadowRoot!.querySelector( '.kp-panel[data-panel="inspector"]' );
/** The inspector panel, if it is shown (open or previewing). */
const inspectorPanel = (): HTMLElement | null => {
    const panel = rawPanel();
    return panel?.classList.contains( 'kp-open' ) || panel?.classList.contains( 'kp-preview' ) ? panel : null;
};
const text = (): string => inspectorPanel()?.textContent ?? '';
const isOpen = (): boolean => !!rawPanel()?.classList.contains( 'kp-open' );

const key = ( type: 'keydown' | 'keyup', init: KeyboardEventInit = {} ): void => {
    document.dispatchEvent( new KeyboardEvent( type, { bubbles: true, cancelable: true, composed: true, ...init } ) );
};
const altDown = (): void => key( 'keydown', { key: 'Alt', code: 'AltLeft', altKey: true } );
const altUp = (): void => key( 'keyup', { key: 'Alt', code: 'AltLeft', altKey: false } );
const move = ( el: Element, altKey = true ): void => void el.dispatchEvent( new MouseEvent( 'mousemove', { bubbles: true, composed: true, altKey, clientX: 20, clientY: 30 } ) );

function page() {
    document.body.innerHTML = '<main id="app"><section id="card"><button id="btn">go</button></section><p id="plain"></p></main>';
    const el = ( id: string ) => document.getElementById( id )!;
    const count = fake.world.signal( 1, 'count' );
    const app = fake.world.unit( { name: 'App', element: el( 'app' ) } );
    const card = fake.world.unit( { name: 'Card', element: el( 'card' ), inputs: { title: 'Hello', count }, properties: { open: false } } );
    fake.world.unit( { name: 'Btn', element: el( 'btn' ), inputs: { label: 'go' } } );
    return { el, count, app, card };
}

beforeEach( () => {
    document.body.innerHTML = '';
    fake = fakeAdapter();
} );
afterEach( () => {
    dispose?.();
    dispose = undefined;
    vi.restoreAllMocks();
    vi.useRealTimers();
} );

describe( 'mountOverlay', () => {
    it( 'mounts the overlay with the inspector and removes it again', () => {
        vi.spyOn( console, 'info' ).mockImplementation( () => undefined );
        page();
        dispose = mountOverlay( options() );
        expect( host() ).toBeTruthy();
        expect( inspectorPanel() ).toBeNull();
        dispose!();
        expect( document.querySelector( 'kiwi-panels' ) ).toBeNull();
    } );

    it( 'does not mount in production builds or for an unsupported contract', () => {
        const warn = vi.spyOn( console, 'warn' ).mockImplementation( () => undefined );
        expect( mountOverlay( options( { adapter: fakeAdapter( { dev: false } ) } ) ) ).toBeUndefined();
        expect( mountOverlay( options( { adapter: fakeAdapter( { contract: 99 } ) } ) ) ).toBeUndefined();
        expect( warn.mock.calls[0][0] ).toContain( 'contract 99' );
        expect( document.querySelector( 'kiwi-panels' ) ).toBeNull();
    } );

    it( 'leaves out features whose capabilities are missing', () => {
        vi.spyOn( console, 'info' ).mockImplementation( () => undefined );
        const setup = vi.fn( () => undefined );
        const needy: DebugFeature = { id: 'needy', requires: ['reactivity'], setup };
        const lenient: DebugFeature = { id: 'lenient', setup: vi.fn( () => undefined ) };
        vi.spyOn( console, 'warn' ).mockImplementation( () => undefined );
        fake = fakeAdapter( { capabilities: [] } );
        dispose = mountOverlay( options( { features: [needy, lenient] } ) );
        expect( setup ).not.toHaveBeenCalled();
        expect( lenient.setup ).toHaveBeenCalled();
    } );

    it( 'registers panels in tray order and sets up features in setup order', () => {
        vi.spyOn( console, 'info' ).mockImplementation( () => undefined );
        const order: string[] = [];
        const make = ( id: string ): DebugFeature => ( {
            id, setup: () => ( order.push( id ), { panel: { id, title: id, mount: () => undefined } } )
        } );
        dispose = mountOverlay( options( { features: [make( 'search' ), make( 'inspector' ), make( 'watch' )] } ) );
        expect( order ).toEqual( ['watch', 'search', 'inspector'] );
        const buttons = Array.from( host().shadowRoot!.querySelectorAll( '.kp-tray button[title]' ), b => b.getAttribute( 'title' ) );
        expect( buttons.join( ' ' ) ).toMatch( /inspector.*search.*watch/is );
    } );

    it( 'refreshes after the framework renders, throttled', () => {
        vi.useFakeTimers();
        vi.spyOn( console, 'info' ).mockImplementation( () => undefined );
        const refresh = vi.fn();
        const feature: DebugFeature = { id: 'x', setup: () => ( { refresh } ) };
        dispose = mountOverlay( options( { features: [feature] } ) );
        fake.world.render();
        fake.world.render();
        expect( refresh ).not.toHaveBeenCalled();
        vi.advanceTimersByTime( 260 );
        expect( refresh ).toHaveBeenCalledTimes( 1 );
        // A write that no template reads still refreshes.
        fake.world.signal( 1 ).set( 2 );
        vi.advanceTimersByTime( 260 );
        expect( refresh ).toHaveBeenCalledTimes( 2 );
        expect( fake.world.runOutsideCalls ).toBeGreaterThan( 0 );
    } );
} );

describe( 'inspector', () => {
    beforeEach( () => void vi.spyOn( console, 'info' ).mockImplementation( () => undefined ) );

    it( 'previews the element under the pointer while the modifier is held, and ends when it is released', () => {
        const { el } = page();
        dispose = mountOverlay( options() );
        move( el( 'card' ), false );
        expect( inspectorPanel() ).toBeNull();

        altDown();
        move( el( 'card' ) );
        expect( rawPanel()?.classList.contains( 'kp-preview' ) ).toBe( true );
        expect( text() ).toContain( 'Card' );
        expect( text() ).toContain( 'title = "Hello"' );

        altUp();
        expect( inspectorPanel() ).toBeNull();
    } );

    it( 'resolves the nearest inspectable ancestor of what is hovered', () => {
        const { el } = page();
        dispose = mountOverlay( options() );
        altDown();
        move( el( 'plain' ) );
        expect( text() ).toContain( 'App' );
    } );

    it( 'retargets the preview when the pointer moves to another element', () => {
        const { el } = page();
        dispose = mountOverlay( options() );
        altDown();
        move( el( 'card' ) );
        move( el( 'btn' ) );
        expect( text() ).toContain( 'Btn' );
        expect( text() ).toContain( 'label = "go"' );
    } );

    it( 'picks an element with the pick button, without the click reaching the page', () => {
        const { el } = page();
        const pageClick = vi.fn();
        el( 'btn' ).addEventListener( 'click', pageClick );
        dispose = mountOverlay( options() );
        altDown();
        el( 'card' ).dispatchEvent( new MouseEvent( 'click', { bubbles: true, cancelable: true, composed: true, altKey: true } ) );
        altUp();
        expect( text() ).toContain( 'Card' );
        const pick = Array.from( rawPanel()!.querySelectorAll<HTMLButtonElement>( '.kp-header button' ) ).find( b => b.textContent === '⌖' )!;
        pick.click();
        expect( rawPanel()!.style.visibility ).toBe( 'hidden' );
        const click = new MouseEvent( 'click', { bubbles: true, cancelable: true, composed: true } );
        el( 'btn' ).dispatchEvent( click );
        expect( click.defaultPrevented ).toBe( true );
        expect( pageClick ).not.toHaveBeenCalled();
        expect( rawPanel()!.style.visibility ).toBe( '' );
        expect( text() ).toContain( 'Btn' );
    } );

    it( 'ends a pick with Escape', () => {
        const { el } = page();
        dispose = mountOverlay( options() );
        altDown();
        el( 'card' ).dispatchEvent( new MouseEvent( 'click', { bubbles: true, cancelable: true, composed: true, altKey: true } ) );
        altUp();
        Array.from( rawPanel()!.querySelectorAll<HTMLButtonElement>( '.kp-header button' ) ).find( b => b.textContent === '⌖' )!.click();
        key( 'keydown', { key: 'Escape', code: 'Escape' } );
        expect( rawPanel()!.style.visibility ).toBe( '' );
        expect( text() ).toContain( 'Card' );
    } );

    it( 'pins with a modified click, swallowing the click', () => {
        const { el } = page();
        const pageClick = vi.fn();
        el( 'card' ).addEventListener( 'click', pageClick );
        dispose = mountOverlay( options() );
        altDown();
        const click = new MouseEvent( 'click', { bubbles: true, cancelable: true, composed: true, altKey: true } );
        el( 'card' ).dispatchEvent( click );
        expect( click.defaultPrevented ).toBe( true );
        expect( pageClick ).not.toHaveBeenCalled();
        expect( isOpen() ).toBe( true );
        altUp();
        expect( isOpen() ).toBe( true );
    } );

    it( 'lets unmodified clicks through', () => {
        const { el } = page();
        const pageClick = vi.fn();
        el( 'card' ).addEventListener( 'click', pageClick );
        dispose = mountOverlay( options() );
        el( 'card' ).dispatchEvent( new MouseEvent( 'click', { bubbles: true, cancelable: true, composed: true } ) );
        expect( pageClick ).toHaveBeenCalledTimes( 1 );
    } );

    function pin( id = 'card' ) {
        const world = page();
        dispose = mountOverlay( options() );
        altDown();
        world.el( id ).dispatchEvent( new MouseEvent( 'click', { bubbles: true, cancelable: true, composed: true, altKey: true } ) );
        altUp();
        return world;
    }

    it( 'shows changes of values after a refresh', () => {
        vi.useFakeTimers();
        const { count } = pin();
        expect( text() ).toContain( 'count = signal(1)' );
        count.set( 5 );
        fake.world.render();
        vi.advanceTimersByTime( 300 );
        expect( text() ).toContain( 'count = signal(5)' );
        expect( text() ).toContain( '(was signal(1))' );
    } );

    it( 'navigates to the parent and back down with the modifier and arrow keys', () => {
        pin( 'btn' );
        expect( text() ).toContain( 'Btn' );
        altDown();
        key( 'keydown', { key: 'ArrowLeft', code: 'ArrowLeft', altKey: true } );
        expect( text() ).toContain( 'Card' );
        key( 'keydown', { key: 'ArrowRight', code: 'ArrowRight', altKey: true } );
        expect( text() ).toContain( 'Btn' );
    } );

    it( 'closes on Escape without the modifier, and passes Escape on when closed', () => {
        pin();
        const esc = new KeyboardEvent( 'keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true } );
        document.dispatchEvent( esc );
        expect( isOpen() ).toBe( false );
        const again = new KeyboardEvent( 'keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true } );
        document.dispatchEvent( again );
        expect( again.defaultPrevented ).toBe( false );
    } );

    it( 'drops a target that left the page', () => {
        vi.useFakeTimers();
        const { el } = pin();
        expect( text() ).toContain( 'Card' );
        el( 'card' ).remove();
        fake.world.render();
        vi.advanceTimersByTime( 300 );
        expect( isOpen() ).toBe( false );
    } );

    it( 'shows a hint when opened without a target', () => {
        page();
        dispose = mountOverlay( options() );
        key( 'keydown', { key: 'p', code: 'KeyP', altKey: true } );
        expect( text() ).toContain( 'Hold Alt and hover an element' );
    } );

    it( 'lists sections and relations', () => {
        const { el } = page();
        fake.world.addSection( el( 'card' ), { id: 'providers', label: 'providers', read: () => 1, list: () => [{ title: 'Service', chips: ['root'], owner: 'App' }] } );
        dispose = mountOverlay( options() );
        altDown();
        el( 'card' ).dispatchEvent( new MouseEvent( 'click', { bubbles: true, cancelable: true, composed: true, altKey: true } ) );
        const body = inspectorPanel()!;
        expect( body.textContent ).toContain( 'providers' );
        expect( body.textContent ).toContain( 'Relations (depth 1)' );
        const section = Array.from( body.querySelectorAll<HTMLDetailsElement>( 'details.kd-section' ) )[0];
        section.open = true;
        section.dispatchEvent( new Event( 'toggle' ) );
        expect( section.textContent ).toContain( 'Service' );
    } );
} );
