import { defineConfig } from 'vitest/config';

import { workspaceAliases } from '../../tooling/aliases';

export default defineConfig( {
    resolve: { alias: workspaceAliases },
    test: {
        environment: 'happy-dom',
        include: ['test/**/*.test.ts']
    }
} );
