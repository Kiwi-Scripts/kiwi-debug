import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyValue, logGroup, preview, stringifyCopy } from '../src/core';
import { safe, safeOr } from '../src/core/safe';

class Service {
    a = 1;
}

describe( 'safe', () => {
    it( 'swallows throws', () => {
        expect( safe( () => 1 ) ).toBe( 1 );
        expect( safe( () => {
            throw new Error( 'x' );
        } ) ).toBeUndefined();
        expect( safeOr( () => {
            throw new Error( 'x' );
        }, 5 ) ).toBe( 5 );
    } );
} );

describe( 'preview', () => {
    it( 'describes plain values', () => {
        expect( [preview( 1 ), preview( true ), preview( null ), preview( undefined ), preview( 5n )] ).toEqual( ['1', 'true', 'null', 'undefined', '5n'] );
        expect( preview( 'a"b' ) ).toBe( '"a\\"b"' );
    } );

    it( 'cuts long strings', () => {
        const text = preview( 'x'.repeat( 100 ) );
        expect( text.length ).toBe( 61 );
        expect( text.endsWith( '…' ) ).toBe( true );
    } );

    it( 'describes functions, collections, elements and objects', () => {
        function named() {}
        const el = document.createElement( 'div' );
        el.id = 'a';
        el.className = 'b';
        expect( preview( named ) ).toBe( 'ƒ named' );
        expect( preview( [1, 2] ) ).toBe( 'Array(2)' );
        expect( preview( new Map( [[1, 2]] ) ) ).toBe( 'Map(1)' );
        expect( preview( new Set() ) ).toBe( 'Set(0)' );
        expect( preview( el ) ).toBe( '<div#a.b>' );
        expect( preview( new Service() ) ).toBe( 'Service' );
        expect( preview( { a: 1 } ) ).toBe( '{…}' );
        expect( preview( Object.create( null ) ) ).toBe( '{…}' );
    } );

    it( 'shows reactive values with their current value', () => {
        const node = { kind: 'signal', holdsValue: true, peek: () => 'hi' };
        const effect = { kind: 'effect', holdsValue: false, peek: () => 1 };
        const signal = {};
        const reactivity = { nodeOf: ( v: unknown ) => v === signal ? node as never : v === effect ? effect as never : undefined };
        expect( preview( signal, reactivity ) ).toBe( 'signal("hi")' );
        expect( preview( effect, reactivity ) ).toBe( 'effect' );
        expect( preview( {}, reactivity ) ).toBe( '{…}' );
    } );

    it( 'shows ? for values that throw', () => {
        const hostile = new Proxy( {}, {
            getPrototypeOf() {
                throw new Error( 'x' );
            }
        } );
        expect( preview( hostile ) ).toBe( '?' );
    } );
} );

describe( 'copyValue', () => {
    it( 'copies structures and encodes special values', () => {
        const copy = copyValue( { n: 1, big: 2n, fn() {}, sym: Symbol( 's' ), und: undefined, map: new Map( [['k', 1]] ), set: new Set( [1] ), svc: new Service() } ) as Record<string, unknown>;
        expect( copy.n ).toBe( 1 );
        expect( copy.big ).toBe( '2n' );
        expect( copy.fn ).toBe( 'ƒ fn' );
        expect( copy.sym ).toBe( 'Symbol(s)' );
        expect( copy.und ).toBe( '[undefined]' );
        expect( copy.map ).toEqual( { $map: [['k', 1]] } );
        expect( copy.set ).toEqual( { $set: [1] } );
        expect( copy.svc ).toEqual( { $class: 'Service', a: 1 } );
    } );

    it( 'replaces cycles and repeats', () => {
        const shared = { v: 1 };
        const cyclic: Record<string, unknown> = { a: shared, b: shared };
        cyclic.self = cyclic;
        expect( copyValue( cyclic ) ).toEqual( { a: { v: 1 }, b: '[repeated]', self: '[circular]' } );
    } );

    it( 'bounds the number of objects', () => {
        const many = Array.from( { length: 3000 }, () => ( {} ) );
        const copy = copyValue( many ) as unknown[];
        expect( copy.filter( x => x === '[…]' ).length ).toBeGreaterThan( 900 );
    } );

    it( 'survives throwing getters', () => {
        const copy = copyValue( { get bad(): number { throw new Error( 'x' ); }, ok: 1 } ) as Record<string, unknown>;
        expect( copy ).toEqual( { bad: '?', ok: 1 } );
    } );
} );

describe( 'stringifyCopy', () => {
    it( 'cuts at 20 000 characters', () => {
        expect( stringifyCopy( 'x'.repeat( 50_000 ) ).length ).toBeLessThan( 20_100 );
        expect( stringifyCopy( { a: 1 } ) ).toBe( '{\n  "a": 1\n}' );
    } );
} );

describe( 'logGroup', () => {
    afterEach( () => void vi.restoreAllMocks() );

    it( 'writes a group with one line per defined entry', () => {
        const group = vi.spyOn( console, 'group' ).mockImplementation( () => undefined );
        const log = vi.spyOn( console, 'log' ).mockImplementation( () => undefined );
        const end = vi.spyOn( console, 'groupEnd' ).mockImplementation( () => undefined );
        logGroup( 'Title', [['a', 1], ['skipped', undefined], false, ['b', 2]] );
        expect( group.mock.calls[0][0] ).toContain( '[kiwi-debug] Title' );
        expect( log.mock.calls ).toEqual( [['[kiwi-debug] a', 1], ['[kiwi-debug] b', 2]] );
        expect( end ).toHaveBeenCalledTimes( 1 );
    } );
} );
