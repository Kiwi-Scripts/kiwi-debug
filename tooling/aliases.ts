import { fileURLToPath } from 'node:url';

const src = ( path: string ): string => fileURLToPath( new URL( `../packages/${path}`, import.meta.url ) );

/**
 * Vitest aliases for the workspace packages, so that tests run against sources and need no build.
 * Keep in sync with `paths` in tsconfig.base.json. More specific entries come first.
 */
export const workspaceAliases = [
    { find: '@kiwi-js/debug/adapter', replacement: src( 'debug/src/adapter/index.ts' ) },
    { find: '@kiwi-js/debug/testkit', replacement: src( 'debug/src/adapter/testkit.ts' ) },
    { find: /^@kiwi-js\/debug$/, replacement: src( 'debug/src/index.ts' ) }
];
