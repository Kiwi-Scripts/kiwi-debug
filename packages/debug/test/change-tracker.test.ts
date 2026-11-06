import { describe, expect, it } from 'vitest';
import { fakeAdapter } from '../src/adapter/testkit';
import { createChangeTracker, groupKey, rowKey } from '../src/core/change-tracker';

const seenNowhere = (): boolean => false;

describe( 'ChangeTracker', () => {
    function setup() {
        const adapter = fakeAdapter();
        const tracker = createChangeTracker( adapter.reactivity );
        const values: Record<string, unknown> = { a: 1, b: 'x' };
        const refs = () => Object.keys( values ).map( name => ( { scope: 'U', category: 'inputs', name, read: () => values[name] } ) );
        return { adapter, tracker, values, refs };
    }

    it( 'reports no change on the first snapshot', () => {
        const { tracker, refs } = setup();
        const first = tracker.snapshot( refs() );
        tracker.diff( first, seenNowhere );
        expect( tracker.changes.size ).toBe( 0 );
    } );

    it( 'records a changed text with the old one', () => {
        const { tracker, values, refs } = setup();
        tracker.commit( tracker.snapshot( refs() ) );
        values.a = 2;
        const next = tracker.snapshot( refs() );
        tracker.diff( next, seenNowhere );
        const key = rowKey( 'U', 'inputs', 'a' );
        expect( tracker.changes.get( key ) ).toMatchObject( { kind: 'text', was: '1' } );
        expect( tracker.isFlashing( key ) ).toBe( true );
        expect( tracker.changes.has( rowKey( 'U', 'inputs', 'b' ) ) ).toBe( false );
        tracker.commit( next );
        expect( tracker.isFlashing( key ) ).toBe( false );
        expect( tracker.changes.has( key ) ).toBe( true );
    } );

    it( 'detects a reactive value that was written with an identical text', () => {
        const { adapter, tracker, values, refs } = setup();
        const signal = adapter.world.signal( { n: 1 }, 's' );
        values.s = signal;
        tracker.commit( tracker.snapshot( refs() ) );
        signal.set( { n: 1 } );
        const next = tracker.snapshot( refs() );
        tracker.diff( next, seenNowhere );
        expect( tracker.changes.get( rowKey( 'U', 'inputs', 's' ) ) ).toMatchObject( { kind: 'rewritten', was: 'value written: v0 → v1', previous: { n: 1 } } );
    } );

    it( 'counts changes in groups that were not seen, until they are acknowledged', () => {
        const { tracker, values, refs } = setup();
        tracker.commit( tracker.snapshot( refs() ) );
        values.a = 2;
        values.b = 'y';
        tracker.diff( tracker.snapshot( refs() ), group => group === groupKey( 'U', 'inputs' ) );
        expect( tracker.unseenCount() ).toBe( 0 );
        tracker.diff( tracker.snapshot( refs() ), seenNowhere );
        expect( [tracker.unseenCount(), tracker.unseenIn( groupKey( 'U', 'inputs' ) )] ).toEqual( [2, 2] );
        tracker.dismiss( rowKey( 'U', 'inputs', 'a' ) );
        expect( tracker.unseenCount() ).toBe( 1 );
        tracker.acknowledge( groupKey( 'U', 'inputs' ) );
        expect( tracker.unseenCount() ).toBe( 0 );
    } );

    it( 'changes its signature with texts and versions only', () => {
        const { tracker, values, refs } = setup();
        const a = tracker.signatureOf( tracker.snapshot( refs() ) );
        expect( tracker.signatureOf( tracker.snapshot( refs() ) ) ).toBe( a );
        values.a = 3;
        expect( tracker.signatureOf( tracker.snapshot( refs() ) ) ).not.toBe( a );
    } );

    it( 'reads ? for a value that throws and keeps copies of reactive objects per version', () => {
        const { adapter, tracker } = setup();
        const signal = adapter.world.signal( { deep: { x: 1 } } );
        const refs = [
            {
                scope: 'U', category: 'p', name: 'bad', read: () => {
                    throw new Error( 'x' );
                }
            },
            { scope: 'U', category: 'p', name: 'sig', read: () => signal }
        ];
        const one = tracker.snapshot( refs );
        const two = tracker.snapshot( refs );
        expect( one.get( rowKey( 'U', 'p', 'bad' ) )?.text ).toBe( '?' );
        expect( two.get( rowKey( 'U', 'p', 'sig' ) )?.copy ).toBe( one.get( rowKey( 'U', 'p', 'sig' ) )?.copy );
    } );

    it( 'marks rows and forgets a scope', () => {
        const { tracker, values, refs } = setup();
        tracker.commit( tracker.snapshot( refs() ) );
        values.a = 2;
        tracker.diff( tracker.snapshot( refs() ), seenNowhere );
        const row = document.createElement( 'div' );
        tracker.markRow( row, rowKey( 'U', 'inputs', 'a' ) );
        expect( row.classList.contains( 'kd-changed' ) ).toBe( true );
        expect( row.dataset.category ).toBe( 'inputs' );
        expect( row.textContent ).toContain( '(was 1)' );
        tracker.forget( 'U' );
        expect( tracker.changes.size ).toBe( 0 );
        expect( tracker.unseenCount() ).toBe( 0 );
    } );
} );
