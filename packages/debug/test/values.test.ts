import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enableDebug, resetDebug } from '../src';
import { fakeAdapter, type FakeAdapter } from '../src/adapter/testkit';
import { createChangeTracker, rowKey } from '../src/core/change-tracker';
import { formatSegments } from '../src/core/expressions';
import { createValueViewState, renderValueTree } from '../src/core/value-view';
import { describeValue, TREE_PAGE } from '../src/core/values';

describe( 'describeValue', () => {
    it( 'treats primitives, functions and elements as leaves', () => {
        for ( const value of [1, 'a', null, undefined, () => 1, document.createElement( 'div' ), new Date()] ) {
            const node = describeValue( value );
            expect( node.expandable ).toBe( false );
            expect( node.children().nodes ).toEqual( [] );
        }
        expect( describeValue( () => 1 ).kind ).toBe( 'function' );
        expect( describeValue( document.body ).kind ).toBe( 'element' );
    } );

    it( 'lists array items and object properties with the steps to reach them', () => {
        const node = describeValue( { list: [10, 20], name: 'x' } );
        expect( node.expandable ).toBe( true );
        const [list, name] = node.children().nodes;
        expect( [list.key, list.text, name.key, name.text] ).toEqual( ['list', 'Array(2)', 'name', '"x"'] );
        const [first] = list.children().nodes;
        expect( [first.key, first.text, formatSegments( [list.segment!, first.segment!] )] ).toEqual( ['0', '10', 'list[0]'] );
    } );

    it( 'lists map entries and set items', () => {
        const map = describeValue( new Map<unknown, unknown>( [['a', 1], [{}, 2]] ) );
        const [byString, byObject] = map.children().nodes;
        expect( [byString.key, byString.segment] ).toEqual( ['["a"]', { kind: 'index', key: 'a', optional: false }] );
        expect( byObject.segment ).toBeUndefined();
        expect( describeValue( new Set( ['x', 'y'] ) ).children().nodes.map( n => n.text ) ).toEqual( ['"x"', '"y"'] );
    } );

    it( 'pages long lists', () => {
        const node = describeValue( Array.from( { length: 120 }, ( _, i ) => i ) );
        const first = node.children();
        expect( [first.nodes.length, first.total] ).toEqual( [TREE_PAGE, 120] );
        expect( node.children( 100 ).nodes ).toHaveLength( 100 );
    } );

    it( 'marks cycles instead of following them', () => {
        const a: Record<string, unknown> = { name: 'a' };
        a.self = a;
        const self = describeValue( a ).children().nodes.find( n => n.key === 'self' )!;
        expect( self.kind ).toBe( 'circular' );
        expect( self.expandable ).toBe( false );
    } );

    it( 'lists getters without running them', () => {
        const getter = vi.fn( () => 1 );
        const node = describeValue( { get lazy() { return getter(); }, plain: 1 } );
        const lazy = node.children().nodes.find( n => n.key === 'lazy' )!;
        expect( [lazy.kind, lazy.text, lazy.expandable] ).toEqual( ['getter', '(getter)', false] );
        expect( getter ).not.toHaveBeenCalled();
    } );

    it( 'shows what a signal holds when it is opened', () => {
        const fake = fakeAdapter();
        const signal = fake.world.signal( { n: 1, tags: ['a'] } );
        const node = describeValue( signal, fake.reactivity );
        expect( [node.kind, node.expandable, node.text] ).toEqual( ['reactive', true, 'signal({…})'] );
        expect( node.children().nodes.map( n => n.key ) ).toEqual( ['n', 'tags'] );
        expect( describeValue( fake.world.signal( 3 ), fake.reactivity ).expandable ).toBe( false );
    } );
} );

describe( 'renderValueTree', () => {
    const value = { user: { name: 'Ann', tags: ['a', 'b'] }, count: 2 };

    it( 'opens nodes on click and builds children lazily', () => {
        const tree = renderValueTree( describeValue( value ) );
        expect( tree.textContent ).not.toContain( 'user' );
        tree.querySelector<HTMLElement>( '.kd-node-row' )!.click();
        expect( tree.textContent ).toContain( 'user' );
        expect( tree.textContent ).not.toContain( 'name' );
        tree.querySelectorAll<HTMLElement>( '.kd-node-row' )[1].click();
        expect( tree.textContent ).toContain( 'name: "Ann"' );
    } );

    it( 'remembers what is open in its state', () => {
        const state = createValueViewState();
        const first = renderValueTree( describeValue( value ), { state } );
        first.querySelector<HTMLElement>( '.kd-node-row' )!.click();
        first.querySelectorAll<HTMLElement>( '.kd-node-row' )[1].click();
        const second = renderValueTree( describeValue( value ), { state } );
        expect( second.textContent ).toContain( 'name: "Ann"' );
    } );

    it( 'passes the path of a clicked name', () => {
        const picks: string[] = [];
        const tree = renderValueTree( describeValue( value ), { state: { open: new Set( [''] ), limits: new Map() }, onPick: path => void picks.push( formatSegments( path ) ) } );
        tree.querySelector<HTMLElement>( '.kd-name' )!.click();
        expect( picks ).toEqual( ['user'] );
    } );

    it( 'offers more of a long list', () => {
        const tree = renderValueTree( describeValue( Array.from( { length: 120 }, ( _, i ) => i ) ), { state: { open: new Set( [''] ), limits: new Map() } } );
        expect( tree.querySelectorAll( '.kd-node-row' ) ).toHaveLength( 1 + TREE_PAGE );
        tree.querySelector<HTMLElement>( '.kd-more' )!.click();
        expect( tree.querySelectorAll( '.kd-node-row' ) ).toHaveLength( 1 + 2 * TREE_PAGE );
    } );

    it( 'highlights elements under the pointer', () => {
        const highlight = vi.fn();
        const el = document.createElement( 'p' );
        const tree = renderValueTree( describeValue( { el } ), { highlight, state: { open: new Set( [''] ), limits: new Map() } } );
        const row = tree.querySelectorAll<HTMLElement>( '.kd-node-row' )[1];
        row.dispatchEvent( new MouseEvent( 'mouseenter' ) );
        row.dispatchEvent( new MouseEvent( 'mouseleave' ) );
        expect( highlight.mock.calls ).toEqual( [[el], [null]] );
    } );
} );

describe( 'detail changes', () => {
    it( 'notices changes inside an object only when detail is on', () => {
        const object = { inner: { n: 1 } };
        const refs = [{ scope: 'U', category: 'inputs', name: 'o', read: () => object }];
        const key = rowKey( 'U', 'inputs', 'o' );
        for ( const [detail, expected] of [[false, false], [true, true]] as const ) {
            const tracker = createChangeTracker( undefined, { detail } );
            object.inner.n = 1;
            tracker.commit( tracker.snapshot( refs ) );
            object.inner.n = 2;
            tracker.diff( tracker.snapshot( refs ), () => true );
            expect( tracker.changes.has( key ) ).toBe( expected );
            if ( expected ) {
                expect( tracker.changes.get( key ) ).toMatchObject( { kind: 'nested', previous: { inner: { n: 1 } } } );
            }
        }
    } );
} );

describe( 'valueDetail option', () => {
    let fake: FakeAdapter;
    const key = ( type: 'keydown' | 'keyup', init: KeyboardEventInit ): void => {
        document.dispatchEvent( new KeyboardEvent( type, { bubbles: true, cancelable: true, composed: true, ...init } ) );
    };

    function pinned( valueDetail?: 'detail' ): ShadowRoot {
        document.body.innerHTML = '<div id="card"></div>';
        fake = fakeAdapter();
        fake.world.unit( { name: 'Card', element: document.getElementById( 'card' ), inputs: { items: [1, 2, 3], plain: 5 } } );
        vi.spyOn( console, 'info' ).mockImplementation( () => undefined );
        enableDebug( { adapter: fake, features: ['inspector'], overlay: { storage: false as never }, valueDetail } );
        key( 'keydown', { key: 'Alt', code: 'AltLeft', altKey: true } );
        document.getElementById( 'card' )!.dispatchEvent( new MouseEvent( 'click', { bubbles: true, cancelable: true, composed: true, altKey: true } ) );
        return document.querySelector( 'kiwi-panels' )!.shadowRoot!;
    }
    beforeEach( () => localStorage.clear() );
    afterEach( () => {
        resetDebug();
        vi.restoreAllMocks();
    } );

    it( 'shows one line per value by default', () => {
        expect( pinned().querySelector( '.kd-tree' ) ).toBeNull();
    } );

    it( 'lets arrays and objects open in place in detail mode', () => {
        const shadow = pinned( 'detail' );
        const trees = shadow.querySelectorAll<HTMLElement>( '.kd-tree' );
        expect( trees ).toHaveLength( 1 );
        trees[0].querySelector<HTMLElement>( '.kd-node-row' )!.click();
        expect( trees[0].textContent ).toContain( '0: 1' );
        expect( trees[0].textContent ).toContain( '2: 3' );
    } );
} );
