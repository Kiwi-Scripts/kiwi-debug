import { beforeEach, describe, expect, it } from 'vitest';
import { guardAdapter } from '../src/adapter';
import { fakeAdapter } from '../src/adapter/testkit';
import { createUnitReaders } from '../src/core/units';

function setup() {
    document.body.innerHTML = `
        <div id="app"><section id="card"><p id="plain"><b id="btn"></b></p><i id="deep"><u id="leaf"></u></i></section></div>
        <div id="overlay"><b id="inside"></b></div>`;
    const el = ( id: string ) => document.getElementById( id )!;
    const fake = fakeAdapter();
    const app = fake.world.unit( { name: 'App', element: el( 'app' ) } );
    const card = fake.world.unit( { name: 'Card', element: el( 'card' ), inputs: { title: 'T' }, properties: { n: 1 }, outputs: { done: 'emitter' } } );
    const tip = fake.world.unit( { name: 'Tip', kind: 'directive', element: el( 'card' ) } );
    const btn = fake.world.unit( { name: 'Btn', element: el( 'btn' ) } );
    fake.world.unit( { name: 'Leaf', element: el( 'leaf' ) } );
    fake.world.unit( { name: 'Ghost', element: el( 'inside' ) } );
    const readers = createUnitReaders( guardAdapter( fake ), e => e === el( 'overlay' ) || el( 'overlay' ).contains( e ) );
    return { fake, el, app, card, tip, btn, readers };
}

describe( 'unit readers', () => {
    beforeEach( () => void ( document.body.innerHTML = '' ) );

    it( 'inspects an element: component and directives', () => {
        const { el, card, tip, readers } = setup();
        expect( readers.inspect( el( 'card' ) ) ).toEqual( { element: el( 'card' ), component: card, directives: [tip] } );
        expect( readers.inspect( el( 'plain' ) ) ).toBeNull();
    } );

    it( 'never inspects the overlay', () => {
        const { el, readers } = setup();
        expect( readers.inspect( el( 'inside' ) ) ).toBeNull();
    } );

    it( 'finds the nearest inspectable ancestor', () => {
        const { el, readers } = setup();
        expect( readers.findParent( el( 'btn' ) ) ).toBe( el( 'card' ) );
        expect( readers.findParent( el( 'btn' ), true ) ).toBe( el( 'btn' ) );
        expect( readers.findParent( el( 'app' ) ) ).toBeNull();
    } );

    it( 'finds the nearest inspectable descendants only', () => {
        const { el, readers } = setup();
        expect( readers.findChildren( el( 'app' ) ) ).toEqual( [el( 'card' )] );
        expect( readers.findChildren( el( 'card' ) ) ).toEqual( [el( 'btn' ), el( 'leaf' )] );
    } );

    it( 'lists member rows', () => {
        const { card, readers } = setup();
        expect( readers.rowsOf( card ).map( r => [r.category, r.name, r.read()] ) ).toEqual( [
            ['inputs', 'title', 'T'], ['outputs', 'done', 'emitter'], ['properties', 'n', 1]
        ] );
    } );

    it( 'adds form rows for a bound control', () => {
        const { fake, btn, readers } = setup();
        const control = fake.world.control( 'name', { value: 'x' } );
        fake.world.bindControl( btn, control );
        control.errors.push( ['required', true] );
        const rows = readers.rowsOf( btn );
        expect( rows.map( r => r.name ) ).toEqual( ['value', 'status', 'errors', 'touched', 'dirty'] );
        expect( rows.every( r => r.category === 'form' ) ).toBe( true );
        expect( rows.map( r => r.read() ) ).toEqual( ['x', 'invalid', ['required'], false, false] );
    } );
} );
