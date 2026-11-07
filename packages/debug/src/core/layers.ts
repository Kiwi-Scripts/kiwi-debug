import { localStorageAdapter, createDormantLauncher, type StorageAdapter } from '@kiwi-js/panels';

import { checkAdapter, guardAdapter } from '../adapter/define';
import { actionIds, type ActionLists } from './actions';
import { DEFAULT_ACTIONS } from './builtin-actions';
import { ALL_FEATURE_IDS } from '../features';
import { DEFAULT_TRACKED_COLORS } from '../features/watch/model';
import { logWarn } from './console';
import { mountOverlay } from './mount';
import type { DebugOptions, EffectiveOptions } from './types';

/** `localStorage['kiwi-debug:off']`: the overlay is switched off and only a dimmed launcher is shown. */
const OFF_KEY = 'off';
const OFF_STORAGE_PREFIX = 'kiwi-debug';

interface Layer {
    options: DebugOptions;
}

interface Mounted {
    signature: string | undefined;
    scope: unknown;
    dispose(): void;
}

const layers: Layer[] = [];
let mounted: Mounted | undefined;
let offStorage: StorageAdapter | undefined;

const storage = (): StorageAdapter => offStorage ??= localStorageAdapter( OFF_STORAGE_PREFIX );

export const isSwitchedOff = (): boolean => storage().get( OFF_KEY ) === '1';

/**
 * Merges the layers, oldest to newest: per option the newest value that is not `undefined` wins. The adapter and the owner scope
 * come from the oldest layer that has one (the app frame outlives its pages).
 */
function effectiveOptions(): ( EffectiveOptions & { disabled: boolean } ) | undefined {
    if ( !layers.length ) {
        return undefined;
    }
    const merged: DebugOptions = {};
    const overlay: NonNullable<DebugOptions['overlay']> = {};
    const actions: Partial<ActionLists> = {};
    for ( const { options } of layers ) {
        for ( const [name, value] of Object.entries( options ) as Array<[keyof DebugOptions, unknown]> ) {
            if ( value !== undefined && name !== 'adapter' && name !== 'scope' && name !== 'overlay' && name !== 'actions' ) {
                ( merged as Record<string, unknown> )[name] = value;
            }
        }
        for ( const kind of ['row', 'unit'] as const ) {
            if ( options.actions?.[kind] ) {
                actions[kind] = options.actions[kind];
            }
        }
        for ( const [name, value] of Object.entries( options.overlay ?? {} ) ) {
            if ( value !== undefined ) {
                ( overlay as Record<string, unknown> )[name] = value;
            }
        }
    }
    const adapter = layers.find( l => l.options.adapter )?.options.adapter;
    if ( !adapter ) {
        return undefined;
    }
    return {
        adapter,
        scope: layers.find( l => l.options.scope !== undefined )?.options.scope,
        key: merged.key ?? 'Alt',
        trackedColors: merged.trackedColors ?? DEFAULT_TRACKED_COLORS,
        profileRenders: merged.profileRenders ?? false,
        features: merged.features ?? [...ALL_FEATURE_IDS],
        overlay,
        actions: { row: actions.row ?? DEFAULT_ACTIONS.row, unit: actions.unit ?? DEFAULT_ACTIONS.unit },
        disabled: !!merged.disabled
    };
}

const featureIds = ( options: EffectiveOptions ): string[] => options.features.map( f => typeof f === 'string' ? f : f.id );

/** What the live overlay was built from: a change of any of these rebuilds it. */
const signatureOf = ( options: EffectiveOptions, off: boolean ): string =>
    JSON.stringify( [options.key, options.trackedColors, options.profileRenders, off, featureIds( options ), actionIds( options.actions.row ), actionIds( options.actions.unit )] );

function mountDormant( options: EffectiveOptions ): () => void {
    const launcher = createDormantLauncher( {
        label: 'Off',
        title: 'kiwi-debug is switched off. Click to switch it on.',
        theme: options.overlay.theme,
        container: options.overlay.container,
        onWake: () => setSwitchedOff( false )
    } );
    return launcher.dispose;
}

/** Brings what is mounted in line with the layers. Called synchronously on enabling, in a microtask after a cleanup. */
function evaluate(): void {
    const options = effectiveOptions();
    const active = options && !options.disabled ? options : undefined;
    const off = isSwitchedOff();
    const signature = active ? signatureOf( active, off ) : undefined;
    if ( mounted && mounted.signature === signature && mounted.scope === active?.scope ) {
        return;
    }
    mounted?.dispose();
    mounted = undefined;
    if ( !active || typeof document === 'undefined' ) {
        return;
    }

    const problem = checkAdapter( active.adapter );
    if ( problem ) {
        logWarn( `Not mounting: ${problem}.` );
        mounted = { signature, scope: active.scope, dispose: () => undefined };
        return;
    }
    if ( !guardAdapter( active.adapter ).env.isDev() ) {
        mounted = { signature, scope: active.scope, dispose: () => undefined };
        return;
    }
    const dispose = off ? mountDormant( active ) : mountOverlay( active, { onSwitchOff: () => setSwitchedOff( true ) } );
    mounted = { signature, scope: active.scope, dispose: dispose ?? ( () => undefined ) };
}

/**
 * Enables the overlay and mounts it synchronously, so that profiling sees the first render. Calls stack as layers (an app frame, then
 * its pages): see {@link DebugOptions}. Returns the cleanup that removes the layer; the overlay is re-evaluated in a microtask, so that
 * destroying one page and creating the next in the same task counts as one change.
 */
export function enableDebug( options: DebugOptions ): () => void {
    const layer: Layer = { options };
    layers.push( layer );
    evaluate();
    return () => {
        const index = layers.indexOf( layer );
        if ( index >= 0 ) {
            layers.splice( index, 1 );
            queueMicrotask( evaluate );
        }
    };
}

/** Turns the overlay off for as long as the layer exists: `enableDebug( { disabled: true } )`. Returns the cleanup that ends it. */
export function disableDebug(): () => void {
    return enableDebug( { disabled: true } );
}

/** Persists the off switch and rebuilds: off shows only a dimmed launcher, on mounts the live overlay again. */
export function setSwitchedOff( off: boolean ): void {
    if ( off ) {
        storage().set( OFF_KEY, '1' );
    } else {
        storage().remove( OFF_KEY );
    }
    evaluate();
}

/** Removes all layers and the overlay, immediately. For tests and hot reloading. */
export function resetDebug(): void {
    layers.length = 0;
    mounted?.dispose();
    mounted = undefined;
    offStorage = undefined;
}
