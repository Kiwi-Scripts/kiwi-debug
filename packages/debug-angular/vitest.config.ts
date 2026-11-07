import { defineConfig } from 'vitest/config';

import { workspaceAliases } from '../../tooling/aliases';

export default defineConfig( {
    resolve: { alias: workspaceAliases },
    test: {
        environment: 'happy-dom',
        include: ['test/**/*.test.ts'],
        // Importing the sources of the debug package and Angular cold takes a while when other tests run alongside.
        testTimeout: 30_000
    }
} );
