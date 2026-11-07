import { createOverlay, type Overlay } from '@kiwi-js/panels';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { guardAdapter } from '../src/adapter';
import { fakeAdapter, type FakeAdapter } from '../src/adapter/testkit';
import { createChangeTracker } from '../src/core/change-tracker';
import { createDebugContext, type ContextHandle } from '../src/core/context';
import { createDirectiveView } from '../src/core/directive-view';
import { InspectedElement, Profiler, Tracking } from '../src/core/services';
import { DEFAULT_ACTIONS } from '../src/core/builtin-actions';
import type { EffectiveOptions } from '../src/core/types';

let overlay: Overlay;
let handle: ContextHandle;
let fake: FakeAdapter;

function setup( capabilities?: Parameters<typeof fakeAdapter>[0] ) {
    fake = fakeAdapter( capabilities );
    overlay = createOverlay( { storage: false, hotkeys: { modifier: 'Alt' } } );
    const options = { adapter: fake, key: 'Alt', trackedColors: [], actions: DEFAULT_ACTIONS, valueDetail: 'summary', profileRenders: false, scope: undefined, features: [], overlay: {} } as EffectiveOptions;
    handle = createDebugContext( { overlay, adapter: guardAdapter( fake ), options } );
    return handle.ctx;
}

beforeEach( () => void ( document.body.innerHTML = '<div id="card"></div>' ) );
afterEach( () => {
    handle.dispose();
    overlay.dispose();
    vi.restoreAllMocks();
} );

describe( 'DebugContext', () => {
    it( 'provides services and the inspected element', () => {
        const ctx = setup();
        const el = document.getElementById( 'card' )!;
        expect( ctx.inspectedElement() ).toBeNull();
        ctx.provide( InspectedElement, () => el );
        expect( ctx.inspectedElement() ).toBe( el );
    } );

    it( 'inspects through the guarded adapter and skips the overlay', () => {
        const ctx = setup();
        const el = document.getElementById( 'card' )!;
        fake.world.unit( { name: 'Card', element: el } );
        expect( ctx.inspect( el )?.component ).toBeTruthy();
        fake.world.unit( { name: 'Own', element: overlay.host } );
        expect( ctx.inspect( overlay.host ) ).toBeNull();
    } );

    it( 'treats the modifier as held only when it is pressed or latched', () => {
        const ctx = setup();
        expect( ctx.isHeld( new MouseEvent( 'click' ) ) ).toBe( false );
        expect( ctx.isHeld( new MouseEvent( 'click', { altKey: true } ) ) ).toBe( true );
    } );

    it( 'places the shared hover box over an element and hides it', () => {
        const ctx = setup();
        const el = document.getElementById( 'card' )!;
        el.getBoundingClientRect = () => ( { left: 5, top: 6, width: 7, height: 8 } as DOMRect );
        ctx.highlightHover( el );
        const box = overlay.root.querySelector<HTMLElement>( '.kd-hover' )!;
        expect( [box.style.display, box.style.left, box.style.width] ).toEqual( ['block', '5px', '7px'] );
        ctx.highlightHover( null );
        expect( box.style.display ).toBe( 'none' );
    } );

    it( 'builds a toggle button that follows its state', () => {
        const ctx = setup();
        let on = false;
        const button = ctx.watchButton( 'Track', () => on, () => void ( on = !on ) );
        expect( button.classList.contains( 'kp-on' ) ).toBe( false );
        button.click();
        expect( button.classList.contains( 'kp-on' ) ).toBe( true );
    } );
} );

describe( 'DirectiveView', () => {
    function world() {
        const ctx = setup();
        const el = document.getElementById( 'card' )!;
        const sig = fake.world.signal( 1, 'count' );
        const unit = fake.world.unit( { name: 'Card', element: el, inputs: { title: 'T', count: sig }, properties: { n: 2 } } );
        const view = createDirectiveView( ctx );
        const changes = createChangeTracker( fake.reactivity );
        return { ctx, el, sig, unit, view, changes, target: { unit, element: el } };
    }

    it( 'renders groups with rows; inputs are open by default', () => {
        const { ctx, view, changes, target, unit } = world();
        const groups = view.rowGroups( target, ctx.rowsOf( unit ), { surface: 'inspector', scope: 'Card', changes } );
        expect( groups ).toHaveLength( 2 );
        const [inputs, properties] = groups as HTMLDetailsElement[];
        expect( [inputs.open, properties.open] ).toEqual( [true, false] );
        expect( inputs.textContent ).toContain( 'title = "T"' );
        expect( inputs.textContent ).toContain( 'count = signal(1)' );
        properties.open = true;
        properties.dispatchEvent( new Event( 'toggle' ) );
        expect( properties.textContent ).toContain( 'n = 2' );
    } );

    it( 'marks changed rows and acknowledges a group on expand', () => {
        const { ctx, view, changes, target, unit, sig } = world();
        const refs = () => ctx.rowsOf( unit ).map( r => ( { scope: 'Card', category: r.category, name: r.name, read: r.read } ) );
        changes.commit( changes.snapshot( refs() ) );
        sig.set( 5 );
        changes.diff( changes.snapshot( refs() ), () => false );
        expect( changes.unseenCount() ).toBe( 1 );
        const [inputs] = view.rowGroups( target, ctx.rowsOf( unit ), { surface: 'inspector', scope: 'Card', changes } ) as HTMLDetailsElement[];
        expect( inputs.textContent ).toContain( '1 changed' );
        expect( inputs.querySelector( '.kd-changed' ) ).toBeTruthy();
        inputs.dispatchEvent( new Event( 'toggle' ) );
        expect( changes.unseenCount() ).toBe( 0 );
    } );

    it( 'offers tracking only when a Tracking service exists', () => {
        const { ctx, view, target, unit, changes } = world();
        const trailing = () => view.unitActions( target, 'inspector', 'trailing' );
        expect( trailing().filter( b => b.classList.contains( 'kd-watch' ) ) ).toHaveLength( 0 );
        const toggled: string[] = [];
        ctx.provide( Tracking, {
            isWatched: () => false,
            toggleDirectiveWatch: () => void toggled.push( 'unit' ),
            toggleValueWatch: ( _t, category, name ) => void toggled.push( `${category}.${name}` )
        } );
        trailing().find( b => b.classList.contains( 'kd-watch' ) )!.click();
        const [inputs] = view.rowGroups( target, ctx.rowsOf( unit ), { surface: 'inspector', scope: 'Card', changes } ) as HTMLDetailsElement[];
        inputs.querySelector<HTMLButtonElement>( '.kd-watch' )!.click();
        expect( toggled ).toEqual( ['unit', 'inputs.title'] );
    } );

    it( 'toggles tracking on a modified click of the name and logs otherwise', () => {
        const { ctx, view, target } = world();
        const log = vi.spyOn( console, 'log' ).mockImplementation( () => undefined );
        vi.spyOn( console, 'group' ).mockImplementation( () => undefined );
        vi.spyOn( console, 'groupEnd' ).mockImplementation( () => undefined );
        const toggle = vi.fn();
        ctx.provide( Tracking, { isWatched: () => false, toggleDirectiveWatch: toggle, toggleValueWatch: () => undefined } );
        const link = view.nameLink( target );
        link.dispatchEvent( new MouseEvent( 'click', { altKey: true } ) );
        expect( toggle ).toHaveBeenCalledTimes( 1 );
        link.dispatchEvent( new MouseEvent( 'click' ) );
        expect( toggle ).toHaveBeenCalledTimes( 1 );
        expect( log.mock.calls.map( c => c[0] ) ).toContain( '[kiwi-debug] instance' );
    } );

    it( 'hides the graph icon without reactivity or a graph panel, and shows the profile badge from the service', () => {
        const { ctx, view, target, unit } = world();
        const graph = () => view.unitActions( target, 'inspector', 'trailing' ).find( b => b.classList.contains( 'kd-action-graph' ) );
        expect( graph() ).toBeUndefined();
        overlay.register( { id: 'graph', title: 'Graph', mount: () => undefined } );
        expect( graph() ).toBeDefined();
        expect( view.profileBadge( unit ) ).toBeNull();
        ctx.provide( Profiler, { countsOf: () => ( { renders: 3, checks: 9, rendering: true } ) } );
        const badge = view.profileBadge( unit )!;
        expect( badge.textContent ).toBe( '3× / 9' );
        expect( badge.classList.contains( 'kd-rendering' ) ).toBe( true );
    } );
} );
