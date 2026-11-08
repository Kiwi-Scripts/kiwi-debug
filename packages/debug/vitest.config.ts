import { defineConfig } from 'vitest/config';

import { workspaceAliases } from '../../tooling/aliases';
import { cssAsText } from '../../tooling/css-as-text';

export default defineConfig( {
    plugins: [cssAsText()],
    resolve: { alias: workspaceAliases },
    test: {
        environment: 'happy-dom',
        include: ['test/**/*.test.ts']
    }
} );
