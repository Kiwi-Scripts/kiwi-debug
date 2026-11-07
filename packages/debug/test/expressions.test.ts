import { describe, expect, it } from 'vitest';
import { fakeAdapter } from '../src/adapter/testkit';
import {
    evaluatePath, formatExpression, MAX_SEGMENTS, parseExpression, type Expression
} from '../src/core/expressions';

const parse = ( text: string ): Expression => {
    const result = parseExpression( text );
    if ( !result.ok ) {
        throw new Error( `${text}: ${result.error}` );
    }
    return result.expression;
};
const roundTrip = ( text: string ): string => formatExpression( parse( text ) );

describe( 'parseExpression', () => {
    it( 'parses property and index access', () => {
        expect( parse( 'items[0].name' ) ).toEqual( {
            base: { kind: 'unit' },
            segments: [
                { kind: 'prop', name: 'items', optional: false },
                { kind: 'index', key: 0, optional: false },
                { kind: 'prop', name: 'name', optional: false }
            ]
        } );
    } );

    it( 'parses quoted keys with escapes and optional chaining', () => {
        const { segments } = parse( 'a?.b?.[\'k\\\'s\'].c' );
        expect( segments.map( s => s.optional ) ).toEqual( [false, true, true, false] );
        expect( segments[2] ).toMatchObject( { kind: 'index', key: 'k\'s' } );
        expect( parse( 'a["x y"]' ).segments[1] ).toMatchObject( { key: 'x y' } );
    } );

    it( 'starts at a pin', () => {
        expect( parse( '$12.users[2]' ).base ).toEqual( { kind: 'pin', id: '$12' } );
        expect( parse( '$1' ).segments ).toEqual( [] );
    } );

    it( 'tolerates whitespace', () => {
        expect( roundTrip( '  a . b [ 0 ] ' ) ).toBe( 'a.b[0]' );
    } );

    it.each( [
        ['', 'empty expression'],
        ['a.', 'expected a property name'],
        ['a[', 'expected a number or a quoted string'],
        ['a[1', 'expected "]"'],
        ['a()', 'calls are not allowed'],
        ['a + b', 'unexpected "+"'],
        ['a = 1', 'unexpected "="'],
        ['1a', 'expected a property name'],
        ['a[-1]', 'expected a number'],
        ['a[\'x]', 'expected a number or a quoted string']
    ] )( 'rejects %j', ( text, error ) => {
        const result = parseExpression( text );
        expect( result.ok ).toBe( false );
        expect( !result.ok && result.error ).toContain( error );
    } );

    it( 'limits length and depth', () => {
        expect( parseExpression( 'a' + '.b'.repeat( MAX_SEGMENTS ) ).ok ).toBe( false );
        expect( parseExpression( 'a'.repeat( 600 ) ).ok ).toBe( false );
    } );
} );

describe( 'formatExpression', () => {
    it( 'writes the canonical form', () => {
        expect( roundTrip( 'a [ \'b\' ] . c' ) ).toBe( 'a[\'b\'].c' );
        expect( roundTrip( 'a["it\'s"]' ) ).toBe( 'a[\'it\\\'s\']' );
        expect( roundTrip( '$3 . items [0]' ) ).toBe( '$3.items[0]' );
        expect( roundTrip( '$3' ) ).toBe( '$3' );
        expect( roundTrip( 'a?.b' ) ).toBe( 'a?.b' );
    } );

    it( 'uses brackets for names that are not identifiers', () => {
        const expression: Expression = { base: { kind: 'unit' }, segments: [{ kind: 'prop', name: 'a-b', optional: false }] };
        expect( formatExpression( expression ) ).toBe( '[\'a-b\']' );
    } );

    it( 'parses back to the same expression', () => {
        for ( const text of ['a.b[2]?.c', '$1.x[\'y z\']', 'ünï.ok'] ) {
            expect( parse( roundTrip( text ) ) ).toEqual( parse( text ) );
        }
    } );
} );

describe( 'evaluatePath', () => {
    const root = {
        user: { name: 'Ann', tags: ['a', 'b'], address: null as null | { city: string } },
        map: new Map<string | number, unknown>( [['k', { deep: 1 }], [2, 'two']] ),
        set: new Set( ['x', 'y'] ),
        text: 'hello',
        get bad(): number {
            throw new Error( 'nope' );
        }
    };
    const run = ( text: string, options = {} ) => evaluatePath( root, parse( text ).segments, options );

    it( 'follows properties and indices', () => {
        expect( run( 'user.name' ) ).toEqual( { ok: true, value: 'Ann' } );
        expect( run( 'user.tags[1]' ) ).toEqual( { ok: true, value: 'b' } );
        expect( run( 'text.length' ) ).toEqual( { ok: true, value: 5 } );
    } );

    it( 'indexes maps by key and sets by position', () => {
        expect( run( 'map[\'k\'].deep' ) ).toEqual( { ok: true, value: 1 } );
        expect( run( 'map[2]' ) ).toEqual( { ok: true, value: 'two' } );
        expect( run( 'set[1]' ) ).toEqual( { ok: true, value: 'y' } );
        expect( run( 'map.size' ) ).toEqual( { ok: true, value: 2 } );
    } );

    it( 'gives undefined for a missing final property', () => {
        expect( run( 'user.nothing' ) ).toEqual( { ok: true, value: undefined } );
    } );

    it( 'fails at the step with a nullish receiver and says where', () => {
        const result = run( 'user.address.city' );
        expect( result ).toMatchObject( { ok: false, at: 2, reason: 'nullish' } );
        expect( !result.ok && result.message ).toBe( 'user.address is null' );
        expect( run( 'nothing.x' ) ).toMatchObject( { ok: false, at: 1, reason: 'nullish' } );
    } );

    it( 'short-circuits optional chains', () => {
        expect( run( 'user.address?.city' ) ).toEqual( { ok: true, value: undefined } );
        expect( run( 'nothing?.x.y' ) ).toEqual( { ok: true, value: undefined } );
    } );

    it( 'reports a getter that throws', () => {
        expect( run( 'bad' ) ).toMatchObject( { ok: false, at: 0, reason: 'throws' } );
    } );

    it( 'reads signals on the way with peek(), and leaves the last one alone', () => {
        const fake = fakeAdapter();
        const inner = fake.world.signal( { n: 7 } );
        const outer = { sig: inner };
        const options = { reactivity: fake.reactivity };
        expect( evaluatePath( outer, parse( 'sig.n' ).segments, options ) ).toEqual( { ok: true, value: 7 } );
        expect( evaluatePath( outer, parse( 'sig' ).segments, options ) ).toEqual( { ok: true, value: inner } );
        expect( evaluatePath( outer, parse( 'sig.n' ).segments ) ).toEqual( { ok: true, value: undefined } );
    } );

    it( 'starts at any root, with no segments giving the root', () => {
        expect( evaluatePath( 5, [] ) ).toEqual( { ok: true, value: 5 } );
    } );
} );
