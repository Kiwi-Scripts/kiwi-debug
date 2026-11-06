import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeAdapter, type FakeAdapter } from '../src/adapter/testkit';
import { mountOverlay } from '../src/core/mount';
import type { EffectiveOptions } from '../src/core/types';
import { groupByName, haystackOf, isEmptyQuery, matchEntries, matchFields, parseQuery, type SearchEntry } from '../src/features/search/query';

describe( 'search query', () => {
    it( 'splits plain and field terms', () => {
        expect( parseQuery( '  Card  @Title  btn @ ' ) ).toEqual( { terms: ['card', 'btn'], fields: ['title'] } );
        expect( isEmptyQuery( parseQuery( ' @ ' ) ) ).toBe( true );
    } );

    const entry = ( name: string, id = '', cls = '' ): SearchEntry => {
        const element = document.createElement( 'div' );
        element.id = id;
        element.className = cls;
        return { id: name + id, unit: {}, element, kind: 'component', name, tag: 'div', haystack: haystackOf( name, element ) };
    };

    it( 'requires every term and puts names that start with the first term first', () => {
        const entries = [entry( 'ListCard' ), entry( 'Card' ), entry( 'Button', 'card-btn' ), entry( 'Other' )];
        expect( matchEntries( entries, parseQuery( 'card' ) ).map( e => e.name ) ).toEqual( ['Card', 'ListCard', 'Button'] );
        expect( matchEntries( entries, parseQuery( 'card btn' ) ).map( e => e.name ) ).toEqual( ['Button'] );
        expect( matchEntries( entries, parseQuery( '@x' ) ) ).toHaveLength( 4 );
    } );

    it( 'matches class and tag through the haystack', () => {
        const entries = [entry( 'A', '', 'primary wide' ), entry( 'B' )];
        expect( matchEntries( entries, parseQuery( 'primary' ) ).map( e => e.name ) ).toEqual( ['A'] );
        expect( matchEntries( entries, parseQuery( 'div' ) ) ).toHaveLength( 2 );
    } );

    it( 'matches fields by name or label, in inputs and properties only', () => {
        const unit = {};
        const row = ( category: string, name: string, label?: string ) => ( { unit, category, name, label, read: () => 1 } );
        const rows = [row( 'inputs', 'title' ), row( 'inputs', 'count', 'total' ), row( 'properties', 'isOpen' ), row( 'outputs', 'titled' )];
        expect( matchFields( rows, ['title'] )?.map( r => r.name ) ).toEqual( ['title'] );
        expect( matchFields( rows, ['total', 'open'] )?.map( r => r.name ) ).toEqual( ['count', 'isOpen'] );
        expect( matchFields( rows, ['title', 'nothing'] ) ).toBeUndefined();
    } );

    it( 'groups by name in order of appearance', () => {
        const groups = groupByName( [{ name: 'B' }, { name: 'A' }, { name: 'B' }] );
        expect( Array.from( groups, ( [name, g] ) => [name, g.length] ) ).toEqual( [['B', 2], ['A', 1]] );
    } );
} );

describe( 'search feature', () => {
    let fake: FakeAdapter;
    let dispose: ( () => void ) | undefined;

    const options = (): EffectiveOptions => ( {
        adapter: fake, key: 'Alt', trackedColors: [], profileRenders: false, scope: undefined,
        features: ['search', 'watch'], overlay: { storage: false as never }
    } );
    const shadow = (): ShadowRoot => document.querySelector( 'kiwi-panels' )!.shadowRoot!;
    const panel = (): HTMLElement => shadow().querySelector( '.kp-panel[data-panel="search"]' )!;
    const isOpen = (): boolean => panel()?.classList.contains( 'kp-open' ) ?? false;
    const key = ( init: KeyboardEventInit ): KeyboardEvent => {
        const ev = new KeyboardEvent( 'keydown', { bubbles: true, cancelable: true, composed: true, ...init } );
        document.dispatchEvent( ev );
        return ev;
    };
    const type = ( text: string ): void => {
        const input = panel().querySelector<HTMLInputElement>( 'input' )!;
        input.value = text;
        input.dispatchEvent( new Event( 'input' ) );
    };

    beforeEach( () => {
        fake = fakeAdapter();
        vi.spyOn( console, 'info' ).mockImplementation( () => undefined );
        document.body.innerHTML = '<main id="app"><div id="a" class="card"></div><div id="b"></div><div id="c"></div></main>';
        const el = ( id: string ) => document.getElementById( id )!;
        fake.world.unit( { name: 'App', element: el( 'app' ) } );
        fake.world.unit( { name: 'Card', element: el( 'a' ), inputs: { title: 'One', size: 1 } } );
        fake.world.unit( { name: 'Card', element: el( 'b' ), inputs: { title: 'Two' } } );
        fake.world.unit( { name: 'Button', element: el( 'c' ), properties: { disabled: false } } );
        dispose = mountOverlay( options() );
    } );
    afterEach( () => {
        dispose?.();
        vi.restoreAllMocks();
    } );

    it( 'opens with the hotkey and explains how to search', () => {
        key( { key: 'f', code: 'KeyF', altKey: true } );
        expect( isOpen() ).toBe( true );
        expect( panel().textContent ).toContain( 'Type a name' );
    } );

    it( 'lists matches grouped by class with a count', () => {
        key( { key: 'f', code: 'KeyF', altKey: true } );
        type( 'card' );
        const text = panel().textContent!;
        expect( text ).toContain( 'Card2' );
        expect( text ).not.toContain( 'Button' );
        expect( panel().querySelectorAll( '.kd-result' ) ).toHaveLength( 2 );
    } );

    it( 'says when nothing matches', () => {
        key( { key: 'f', code: 'KeyF', altKey: true } );
        type( 'zzz' );
        expect( panel().textContent ).toContain( 'Nothing found' );
    } );

    it( 'shows only matching rows, expanded, for a field search', () => {
        key( { key: 'f', code: 'KeyF', altKey: true } );
        type( '@size' );
        const results = panel().querySelectorAll<HTMLDetailsElement>( '.kd-result' );
        expect( results ).toHaveLength( 1 );
        expect( results[0].open ).toBe( true );
        expect( results[0].textContent ).toContain( 'size = 1' );
        expect( results[0].textContent ).not.toContain( 'title' );
    } );

    it( 'does not search inside the overlay', () => {
        fake.world.unit( { name: 'Own', element: document.querySelector( 'kiwi-panels' ) } );
        key( { key: 'f', code: 'KeyF', altKey: true } );
        type( 'own' );
        expect( panel().textContent ).toContain( 'Nothing found' );
    } );

    it( 'tracks the first result on Enter', () => {
        key( { key: 'f', code: 'KeyF', altKey: true } );
        type( 'button' );
        panel().querySelector( 'input' )!.dispatchEvent( new KeyboardEvent( 'keydown', { key: 'Enter', bubbles: true } ) );
        const watch = shadow().querySelector( '.kp-panel[data-panel="watch"]' )!;
        expect( watch.textContent ).toContain( 'Tracked values (1)' );
    } );

    it( 'closes on Escape and passes Escape on when closed', () => {
        key( { key: 'f', code: 'KeyF', altKey: true } );
        expect( key( { key: 'Escape', code: 'Escape' } ).defaultPrevented ).toBe( true );
        expect( isOpen() ).toBe( false );
        expect( key( { key: 'Escape', code: 'Escape' } ).defaultPrevented ).toBe( false );
    } );

    it( 'remembers what the user expanded', () => {
        key( { key: 'f', code: 'KeyF', altKey: true } );
        type( 'card' );
        const first = panel().querySelector<HTMLDetailsElement>( '.kd-result' )!;
        first.open = true;
        first.dispatchEvent( new Event( 'toggle' ) );
        type( 'card' );
        type( 'cards'.slice( 0, 4 ) + ' ' );
        expect( panel().querySelector<HTMLDetailsElement>( '.kd-result' )!.open ).toBe( true );
    } );
} );
