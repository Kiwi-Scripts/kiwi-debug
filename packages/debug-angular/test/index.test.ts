import { describe, expect, it } from 'vitest';

import * as angular from '../src';

describe( '@kiwi-js/debug-angular', () => {
    it( 'loads', () => {
        expect( angular ).toBeDefined();
    } );

    it( 'resolves the other workspace packages and Angular', async () => {
        const debug = await import( '@kiwi-js/debug' );
        const adapter = await import( '@kiwi-js/debug/adapter' );
        const core = await import( '@angular/core' );
        expect( debug ).toBeDefined();
        expect( adapter ).toBeDefined();
        expect( typeof core.isDevMode ).toBe( 'function' );
    } );
} );
