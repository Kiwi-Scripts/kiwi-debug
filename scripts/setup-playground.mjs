import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve( dirname( fileURLToPath( import.meta.url ) ), '..' );
const parent = resolve( root, '..' );
const repositories = [
    { name: '@kiwi-js/dom', directory: 'kiwi-dom', url: 'https://github.com/Kiwi-Scripts/kiwi-dom.git' },
    { name: '@kiwi-js/panels', directory: 'kiwi-panels', url: 'https://github.com/Kiwi-Scripts/kiwi-panels.git' }
];

function run( command, args, cwd, capture = false ) {
    const result = spawnSync( command, args, {
        cwd,
        encoding: 'utf8',
        stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit'
    } );
    if ( result.error ) {
        throw result.error;
    }
    if ( result.status !== 0 ) {
        throw new Error( `${command} ${args.join( ' ' )} failed in ${cwd} (exit ${result.status ?? 'unknown'})` );
    }
    return capture ? result.stdout.trim() : '';
}

function runNpm( args, cwd ) {
    const npmCli = process.env.npm_execpath;
    if ( !npmCli ) {
        throw new Error( 'Run setup with `npm run setup:playground` so the npm CLI can be located.' );
    }
    run( process.execPath, [npmCli, ...args], cwd );
}

function normalizeRepoUrl( url ) {
    return url.trim()
        .replace( /^git\+/, '' )
        .replace( /^git@github\.com:/i, 'https://github.com/' )
        .replace( /\.git$/i, '' )
        .replace( /\/$/, '' )
        .toLowerCase();
}

function ensureRepository( repository ) {
    const directory = resolve( parent, repository.directory );
    if ( !existsSync( directory ) ) {
        console.log( `Cloning ${repository.name} into ${directory}` );
        run( 'git', ['clone', '--depth', '1', repository.url, directory], parent );
    } else {
        console.log( `Using existing checkout at ${directory}` );
    }

    const packagePath = resolve( directory, 'package.json' );
    if ( !existsSync( packagePath ) ) {
        throw new Error( `${directory} exists but has no package.json; move it aside or clone ${repository.url} there.` );
    }
    const manifest = JSON.parse( readFileSync( packagePath, 'utf8' ) );
    if ( manifest.name !== repository.name ) {
        throw new Error( `${directory} contains ${manifest.name ?? 'an unnamed package'}, expected ${repository.name}.` );
    }
    const origin = run( 'git', ['remote', 'get-url', 'origin'], directory, true );
    if ( normalizeRepoUrl( origin ) !== normalizeRepoUrl( repository.url ) ) {
        throw new Error( `${directory} has unexpected origin ${origin}; expected ${repository.url}.` );
    }
    return directory;
}

try {
    const directories = repositories.map( repository => ( { ...repository, path: ensureRepository( repository ) } ) );

    for ( const repository of directories ) {
        console.log( `Installing ${repository.name} dependencies` );
        runNpm( ['ci'], repository.path );
    }

    console.log( 'Installing kiwi-debug workspace dependencies' );
    runNpm( ['ci'], root );

    for ( const repository of directories ) {
        console.log( `Building ${repository.name}` );
        runNpm( ['run', 'build'], repository.path );
    }

    console.log( '\nSetup complete. Start the playground with: npm run playground' );
} catch ( error ) {
    console.error( `Playground setup failed: ${error instanceof Error ? error.message : String( error )}` );
    process.exitCode = 1;
}
