import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';

import { workspaceAliases } from '../tooling/aliases';
import { cssAsText } from '../tooling/css-as-text';

const here = ( path: string ): string => fileURLToPath( new URL( path, import.meta.url ) );

/**
 * The playground: a page with a small framework and demo components, with the overlay mounted through a dummy adapter.
 * `@kiwi-js/debug` resolves to the sources of this repository (edits show up on reload); `@kiwi-js/panels` and `@kiwi-js/dom`
 * are the sibling projects, built (`npm run build` there).
 */
export default defineConfig( {
    root: here( '.' ),
    // Turns the overlay's own stylesheet into a string. The playground's page styles are linked from index.html, not imported.
    plugins: [cssAsText()],
    resolve: { alias: workspaceAliases },
    server: {
        port: 5199,
        // The linked sibling projects live outside of this repository.
        fs: { allow: [here( '..' ), here( '../../kiwi-panels' ), here( '../../kiwi-dom' )] }
    }
} );
