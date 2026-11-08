import { enableDebug, resetDebug, setSwitchedOff, type ActionDef, type DebugOptions } from '@kiwi-js/debug';
import { htmlEl } from '@kiwi-js/dom';

import { playgroundAdapter } from './adapter';
import { buildApp } from './app';
import { createControls, loadSettings, type Settings } from './controls';

const settings = loadSettings();

/** Two actions of our own, to show that rows and unit heads take definitions. */
const tableRow: ActionDef = {
    id: 'table', icon: '▦', title: 'Log the value with console.table',
    run: ( { row } ) => console.table( { [row?.name ?? '?']: row?.read() } )
};
const flashUnit: ActionDef = {
    id: 'flash', icon: '✦', title: 'Flash the element', surfaces: ['inspector', 'search', 'watch'],
    run: ( { target } ) => void target.element?.animate( [{ outline: '4px solid hotpink' }, { outline: '4px solid transparent' }], 900 )
};

function actionsFor( preset: Settings['actions'] ): DebugOptions['actions'] {
    switch ( preset ) {
        case 'minimal': return { row: ['track'], unit: ['track'] };
        case 'custom': return { row: ['track', 'graph', 'inspect', tableRow], unit: ['track', 'graph', 'address', flashUnit, 'keep', 'side', 'remove'] };
        default: return undefined;
    }
}

let off: ( () => void ) | undefined;

/** Mounts the overlay with the current settings as a new layer, then drops the previous one. */
function apply(): void {
    const next = settings.enabled
        ? enableDebug( { adapter: playgroundAdapter, key: settings.key, valueDetail: settings.valueDetail, actions: actionsFor( settings.actions ) } )
        : undefined;
    off?.();
    off = next;
}

const hints = [
    ['Hover', 'Hold the modifier and move over the page: a preview of the unit under the pointer follows. Modifier + click pins it.'],
    ['Navigate', 'Modifier + ← / → / ↑ / ↓ moves to the parent, the child, and between children. Esc closes a pinned inspector.'],
    ['Track', 'Click ◉ on a unit or a row (or modifier + click a name). Tracked values stay in "Tracked values" (modifier + T) and come back after a reload.'],
    ['Search', 'Modifier + F. Try "counter", "tooltip", "@step" or "@user".'],
    ['Changes', 'Use the buttons of the counters, todos and "touch": changed values flash and keep "(was …)". Set valueDetail to detail and press "move" to see nested changes.'],
    ['Inspect', 'Click ⌕ on the user row of the User card, then try user.address.geo, user.manager.reports[0].name, scores[100], fullName or _cache.hits. Click names in the tree to extend the path.'],
    ['Pin', 'In the inspect panel pin an object (Pin), then type $1.name and Track it. References stay until you remove them.'],
    ['Held by', 'Pin the logger of the Apples ($1) in the inspect panel: the References list shows which units hold the same instance. The Pears have one of their own. Pins and their paths come back after a reload.'],
    ['Lists', 'Track a todo item, then switch the list filter: the entry waits as "gone" and takes the item back when the item shows up again.'],
    ['Triggers', 'The Ticker writes from a timer, so no click is behind its changes. Pause it to watch the rest.'],
    ['Latch', 'Modifier + L latches the modifier so you need not hold it. Modifier + M pins the tray. The power button switches the overlay off; the launcher switches it on.']
];

function start(): void {
    const stage = htmlEl( 'div', { class: 'stage' } );
    const controls = createControls( settings, apply, { 'switch off': () => setSwitchedOff( true ), reload: () => location.reload() } );
    const aside = htmlEl( 'aside', { class: 'hints' }, htmlEl( 'h2', { text: 'Things to try' } ),
        htmlEl( 'dl', {}, ...hints.flatMap( ( [term, text] ) => [htmlEl( 'dt', { text: term } ), htmlEl( 'dd', { text } )] ) ) );
    document.body.append( controls, htmlEl( 'div', { class: 'layout' }, stage, aside ) );
    buildApp( stage );
    apply();
}

start();

// A hot reload would otherwise leave the old overlay behind.
import.meta.hot?.dispose( () => resetDebug() );
