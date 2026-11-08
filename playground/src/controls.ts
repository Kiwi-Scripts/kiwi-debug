import { htmlEl } from '@kiwi-js/dom';

export type Preset = 'default' | 'minimal' | 'custom';

export interface Settings {
    enabled: boolean;
    key: 'Alt' | 'Shift' | 'Control' | 'Meta';
    valueDetail: 'summary' | 'detail';
    /** Which buttons the rows and unit heads get: the defaults, only the essentials, or the defaults plus custom actions. */
    actions: Preset;
}

const STORAGE_KEY = 'playground:settings';

export const DEFAULT_SETTINGS: Settings = { enabled: true, key: 'Alt', valueDetail: 'summary', actions: 'default' };

export function loadSettings(): Settings {
    try {
        return { ...DEFAULT_SETTINGS, ...JSON.parse( localStorage.getItem( STORAGE_KEY ) ?? '{}' ) };
    } catch {
        return { ...DEFAULT_SETTINGS };
    }
}

const saveSettings = ( settings: Settings ): void => {
    try {
        localStorage.setItem( STORAGE_KEY, JSON.stringify( settings ) );
    } catch {
        // storage blocked: the settings just do not survive a reload
    }
};

function select<T extends string>( label: string, value: T, choices: readonly T[], onChange: ( value: T ) => void, hint?: string ): HTMLElement {
    const el = htmlEl( 'select', { on: { change: () => onChange( el.value as T ) } } );
    el.append( ...choices.map( c => htmlEl( 'option', { text: c, attrs: { value: c, selected: c === value } } ) ) );
    return htmlEl( 'label', { title: hint }, label, el );
}

/**
 * The bar above the demo: the options of the overlay, changed live. Every change mounts the overlay again with the new options
 * (a new layer of `enableDebug`, so it also shows how layers replace each other).
 */
export function createControls( settings: Settings, apply: () => void, extra: Record<string, () => void> ): HTMLElement {
    const change = <K extends keyof Settings>( key: K ) => ( value: Settings[K] ): void => {
        settings[key] = value;
        saveSettings( settings );
        apply();
    };
    const enabled = htmlEl( 'input', { attrs: { type: 'checkbox', checked: settings.enabled }, on: { change: () => change( 'enabled' )( enabled.checked ) } } );
    const bar = htmlEl( 'div', { class: 'controls' },
        htmlEl( 'strong', { text: 'kiwi-debug playground' } ),
        htmlEl( 'label', { title: 'Mounts or removes the overlay (a layer of enableDebug)' }, enabled, 'overlay on' ),
        select( 'modifier', settings.key, ['Alt', 'Shift', 'Control', 'Meta'], change( 'key' ), 'The key to hold for hovering and for the hotkeys' ),
        select( 'valueDetail', settings.valueDetail, ['summary', 'detail'], change( 'valueDetail' ), 'detail: arrays and objects open in place' ),
        select( 'actions', settings.actions, ['default', 'minimal', 'custom'], change( 'actions' ), 'The buttons of rows and unit heads' ) );
    for ( const [label, run] of Object.entries( extra ) ) {
        bar.append( htmlEl( 'button', { text: label, on: { click: run } } ) );
    }
    return bar;
}
