import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Plugin } from 'vite';

const VIRTUAL_PREFIX = '\0kd-css:';
/** The id must not end in `.css`, or vite's own css handling turns the module into an empty string. */
const TEXT_SUFFIX = '.kd-text';

/** Mirrors tsup's `loader: { '.css': 'text' }`: importing a .css file yields its source as a string. For vitest and the playground. */
export const cssAsText = (): Plugin => {
    let root = process.cwd();
    // Vite may hand out ids relative to the project root (`/src/...`).
    const toAbsolute = ( id: string ): string => existsSync( id ) ? id : resolve( root, `.${id}` );
    return {
        name: 'css-as-text',
        enforce: 'pre',
        configResolved( config ) {
            root = config.root;
        },
        async resolveId( source, importer, options ) {
            if ( !source.endsWith( '.css' ) || !importer ) {
                return undefined;
            }
            const resolved = await this.resolve( source, importer, { ...options, skipSelf: true } );
            // A virtual module, so that neither vite's css handling nor its id caching touches it.
            return resolved ? VIRTUAL_PREFIX + toAbsolute( resolved.id ) + TEXT_SUFFIX : undefined;
        },
        load( id ) {
            if ( id.startsWith( VIRTUAL_PREFIX ) ) {
                const file = id.slice( VIRTUAL_PREFIX.length, -TEXT_SUFFIX.length );
                // So that a dev server picks up edits of the stylesheet.
                this.addWatchFile( file );
                return `export default ${JSON.stringify( readFileSync( file, 'utf8' ) )};`;
            }
            return undefined;
        }
    };
};
