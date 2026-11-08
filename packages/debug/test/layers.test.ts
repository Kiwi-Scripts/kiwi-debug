import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { disableDebug, enableDebug, isSwitchedOff, resetDebug, setSwitchedOff } from '../src';
import { fakeAdapter, type FakeAdapter } from '../src/adapter/testkit';

let fake: FakeAdapter;

const hosts = (): Element[] => Array.from( document.querySelectorAll( 'kiwi-panels' ) );
const host = (): Element | undefined => hosts()[0];
const flush = (): Promise<void> => Promise.resolve();

beforeEach( () => {
    document.body.innerHTML = '';
    localStorage.clear();
    fake = fakeAdapter();
    vi.spyOn( console, 'info' ).mockImplementation( () => undefined );
} );
afterEach( () => {
    resetDebug();
    vi.restoreAllMocks();
} );

describe( 'enableDebug', () => {
    it( 'mounts synchronously and removes the overlay after the last layer is gone', async () => {
        const off = enableDebug( { adapter: fake } );
        expect( hosts() ).toHaveLength( 1 );
        off();
        expect( hosts() ).toHaveLength( 1 );
        await flush();
        expect( hosts() ).toHaveLength( 0 );
    } );

    it( 'does nothing a second time with unchanged options', () => {
        enableDebug( { adapter: fake } );
        const first = host();
        enableDebug( {} );
        expect( host() ).toBe( first );
    } );

    it( 'rebuilds when an option that shapes the overlay changes, and goes back when the layer ends', async () => {
        enableDebug( { adapter: fake } );
        const first = host();
        const off = enableDebug( { key: 'Shift' } );
        expect( host() ).not.toBe( first );
        expect( hosts() ).toHaveLength( 1 );
        off();
        await flush();
        expect( hosts() ).toHaveLength( 1 );
        expect( host() ).not.toBe( first );
    } );

    it( 'lets the newest layer win per option, and the oldest supply the adapter', () => {
        const other = fakeAdapter( { id: 'other' } );
        const info = vi.spyOn( console, 'info' );
        enableDebug( { adapter: fake, key: 'Alt' } );
        enableDebug( { adapter: other, key: 'Control' } );
        expect( info.mock.calls.at( -1 )![0] ).toContain( 'hold Control' );
        expect( info.mock.calls.at( -1 )![0] ).toContain( 'Fake' );
    } );

    it( 'counts a page destroyed and the next one created in one task as one change', async () => {
        enableDebug( { adapter: fake } );
        const offA = enableDebug( { trackedColors: ['#111'] } );
        const mounted = host();
        offA();
        enableDebug( { trackedColors: ['#111'] } );
        await flush();
        expect( host() ).toBe( mounted );
    } );

    it( 'is off while a disabling layer exists', async () => {
        enableDebug( { adapter: fake } );
        const off = disableDebug();
        expect( hosts() ).toHaveLength( 0 );
        off();
        await flush();
        expect( hosts() ).toHaveLength( 1 );
    } );

    it( 'does not mount for production builds or an unsupported contract', () => {
        const warn = vi.spyOn( console, 'warn' ).mockImplementation( () => undefined );
        enableDebug( { adapter: fakeAdapter( { dev: false } ) } );
        expect( hosts() ).toHaveLength( 0 );
        resetDebug();
        enableDebug( { adapter: fakeAdapter( { contract: 7 } ) } );
        expect( hosts() ).toHaveLength( 0 );
        expect( warn.mock.calls[0][0] ).toContain( 'contract 7' );
    } );

    it( 'passes the owner scope of the oldest layer to the adapter', () => {
        const scopes: unknown[] = [];
        const adapter = fakeAdapter();
        const original = adapter.env.onRender!;
        ( adapter.env as { onRender: typeof original } ).onRender = ( cb, scope ) => ( scopes.push( scope ), original( cb, scope ) );
        enableDebug( { adapter, scope: 'app' } );
        expect( scopes ).toEqual( ['app'] );
    } );
} );

describe( 'off switch', () => {
    const launcher = (): HTMLButtonElement | null => host()?.shadowRoot?.querySelector( '.kp-launcher' ) as HTMLButtonElement | null;
    const hasPanels = (): boolean => !!host()?.shadowRoot?.querySelector( '.kp-layer' );

    it( 'shows only a dimmed launcher while switched off', () => {
        setSwitchedOff( true );
        enableDebug( { adapter: fake } );
        expect( localStorage.getItem( 'kiwi-debug:off' ) ).toBe( '1' );
        expect( isSwitchedOff() ).toBe( true );
        expect( launcher() ).toBeTruthy();
        expect( hasPanels() ).toBe( false );
        expect( host()!.shadowRoot!.textContent ).toContain( 'off' );
    } );

    it( 'wakes up on a click: clears the flag and mounts the live overlay', () => {
        setSwitchedOff( true );
        enableDebug( { adapter: fake } );
        launcher()!.click();
        expect( isSwitchedOff() ).toBe( false );
        expect( localStorage.getItem( 'kiwi-debug:off' ) ).toBeNull();
        expect( hosts() ).toHaveLength( 1 );
        expect( hasPanels() ).toBe( true );
    } );

    it( 'is switched off by the power button of the tray', () => {
        enableDebug( { adapter: fake } );
        expect( hasPanels() ).toBe( true );
        host()!.shadowRoot!.querySelector<HTMLButtonElement>( 'button[title="Switch kiwi-debug off"]' )!.click();
        expect( isSwitchedOff() ).toBe( true );
        expect( hosts() ).toHaveLength( 1 );
        expect( launcher() ).toBeTruthy();
    } );

    it( 'registers no listeners on the document while dormant', () => {
        const add = vi.spyOn( document, 'addEventListener' );
        setSwitchedOff( true );
        enableDebug( { adapter: fake } );
        expect( add ).not.toHaveBeenCalled();
    } );
} );
