import { describe, expect, it } from 'vitest';

import * as debug from '../src';
import * as adapter from '../src/adapter';
import * as testkit from '../src/adapter/testkit';
import { DEBUG_CSS } from '../src/styles';

describe( '@kiwi-js/debug', () => {
    it( 'loads all entry points', () => {
        expect( [debug, adapter, testkit] ).toHaveLength( 3 );
    } );

    it( 'inlines stylesheets as strings', () => {
        expect( typeof DEBUG_CSS ).toBe( 'string' );
        expect( DEBUG_CSS ).toContain( 'kiwi-debug styles' );
    } );

    it( 'can use the overlay shell it is built on', async () => {
        const { createOverlay } = await import( '@kiwi-js/panels' );
        const overlay = createOverlay( { storage: false } );
        expect( overlay.host.isConnected ).toBe( true );
        overlay.dispose();
    } );
} );
