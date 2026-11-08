import { createScheduler } from '@kiwi-js/dom';
import { cornerDock, createOverlay, type HotkeyBinding, type PanelDefinition, type TrayCommand } from '@kiwi-js/panels';

import { checkAdapter, guardAdapter } from '../adapter/define';
import type { GuardedAdapter } from '../adapter/types';
import { BUILTIN_FEATURES, SETUP_ORDER, TRAY_ORDER } from '../features';
import { DEBUG_CSS } from '../styles';
import { logInfo, logWarn } from './console';
import { createDebugContext } from './context';
import { ICONS } from './icons';
import type { DebugFeature, EffectiveOptions, FeatureInstance } from './types';

export interface MountHooks {
    /** The power button of the tray was clicked. Without it, there is no such button. */
    onSwitchOff?(): void;
}

/** Whether the adapter has everything the feature asks for. */
const supports = ( adapter: GuardedAdapter, feature: DebugFeature ): boolean => ( feature.requires ?? [] ).every( capability => !!adapter[capability] );

/** The features to set up: resolved from ids, gated by the adapter's capabilities, in setup order (custom features last). */
export function enabledFeatures( options: EffectiveOptions, adapter: GuardedAdapter ): DebugFeature[] {
    const resolved = options.features
        .map( f => typeof f === 'string' ? BUILTIN_FEATURES[f] : f )
        .filter( ( f ): f is DebugFeature => !!f );
    const rank = ( f: DebugFeature ): number => {
        const index = SETUP_ORDER.indexOf( f.id as never );
        return index < 0 ? SETUP_ORDER.length : index;
    };
    return resolved.filter( f => supports( adapter, f ) ).sort( ( a, b ) => rank( a ) - rank( b ) );
}

/**
 * Builds the overlay and its features (spec 4.5). Returns what tears it down again, or `undefined` if nothing was mounted
 * (no document, not a dev build, or an unusable adapter).
 */
export function mountOverlay( options: EffectiveOptions, hooks: MountHooks = {} ): ( () => void ) | undefined {
    if ( typeof document === 'undefined' ) {
        return undefined;
    }
    const problem = checkAdapter( options.adapter );
    if ( problem ) {
        logWarn( `Not mounting: ${problem}.` );
        return undefined;
    }
    const adapter = guardAdapter( options.adapter );
    if ( !adapter.env.isDev() ) {
        return undefined;
    }
    const runOutside = <T>( fn: () => T ): T => adapter.env.runOutside ? adapter.env.runOutside( fn ) : fn();

    const commands: TrayCommand[] = hooks.onSwitchOff
        ? [{ id: 'power', title: 'Switch kiwi-debug off', icon: ICONS.POWER, onClick: hooks.onSwitchOff }]
        : [];
    const overlay = createOverlay( {
        tray: options.overlay.tray ?? cornerDock( { trayHotkey: 'KeyM', icon: ICONS.BUG } ),
        trayCommands: commands,
        theme: options.overlay.theme,
        storage: options.overlay.storage,
        container: options.overlay.container,
        hotkeys: { modifier: options.key, latchKey: 'KeyL', trayLatch: true, escapeToClose: false },
        runOutside: adapter.env.runOutside,
        singleton: true
    } );
    const style = document.createElement( 'style' );
    style.textContent = DEBUG_CSS;
    overlay.root.append( style );

    const { ctx, dispose: disposeContext } = createDebugContext( { overlay, adapter, options } );

    const instances: Array<{ feature: DebugFeature; instance: FeatureInstance }> = [];
    const unbinders: Array<() => void> = [];
    const listeners: Array<readonly [EventTarget, string, ( ev: any ) => void, boolean]> = [];
    for ( const feature of enabledFeatures( options, adapter ) ) {
        try {
            const instance = feature.setup( ctx );
            if ( instance ) {
                instances.push( { feature, instance } );
            }
        } catch ( error ) {
            logWarn( `Feature "${feature.id}" failed to set up and is left out.`, error );
        }
    }

    // Bindings in feature order (earlier ones consume first); panels in tray order.
    for ( const { instance } of instances ) {
        for ( const binding of instance.hotkeys ?? [] as HotkeyBinding[] ) {
            unbinders.push( overlay.hotkeys.bind( binding ) );
        }
        listeners.push( ...instance.listeners ?? [] );
    }
    const trayRank = ( panel: PanelDefinition ): number => {
        const index = TRAY_ORDER.indexOf( panel.id );
        return index < 0 ? TRAY_ORDER.length : index;
    };
    instances
        .flatMap( ( { instance } ) => [...instance.panel ? [instance.panel] : [], ...instance.panels ?? []] )
        .sort( ( a, b ) => trayRank( a ) - trayRank( b ) )
        .forEach( panel => overlay.register( panel ) );
    runOutside( () => listeners.forEach( ( [target, type, fn, capture] ) => target.addEventListener( type, fn, capture ) ) );

    // Refresh: the panels are throttled by the overlay, the features' own parts by a scheduler of the same interval.
    const featureRefresh = createScheduler( () => instances.forEach( ( { instance } ) => instance.refresh?.() ), 250, runOutside );
    const requestRefresh = (): void => {
        overlay.requestRefresh();
        featureRefresh.request();
    };
    const stopRender = adapter.env.onRender?.( requestRefresh, options.scope );
    if ( !adapter.env.onRender ) {
        logWarn( 'The adapter cannot report renders: the panels will not refresh by themselves.' );
    }
    // A write that no template reads produces no render. The hook fires in the writer's context, so hop out first.
    const stopWrites = adapter.reactivity?.onWrite( () => runOutside( requestRefresh ) );

    logInfo( `${adapter.meta.name}: hold ${options.key} and hover an element to inspect it; ${options.key} + L latches the key.` );

    return () => {
        stopRender?.();
        stopWrites?.();
        featureRefresh.cancel();
        runOutside( () => listeners.forEach( ( [target, type, fn, capture] ) => target.removeEventListener( type, fn, capture ) ) );
        unbinders.forEach( off => off() );
        instances.forEach( ( { instance } ) => instance.dispose?.() );
        disposeContext();
        overlay.dispose();
    };
}
