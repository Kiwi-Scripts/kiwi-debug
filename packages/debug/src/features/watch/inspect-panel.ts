import { button, div, type PanelDefinition } from '@kiwi-js/panels';

import type { Unit } from '../../adapter/types';
import { logGroup } from '../../core/console';
import { formatExpression, type Segment } from '../../core/expressions';
import { copyValue } from '../../core/format';
import { safe } from '../../core/safe';
import type { DebugContext } from '../../core/types';
import { createValueViewState, renderValueTree } from '../../core/value-view';
import { describeValue } from '../../core/values';
import type { HeldBy } from './held-by';
import type { WatchModel } from './model';

/** What `overlay.panels.open( 'inspect', args )` takes. */
export interface InspectArgs {
    /** The unit a path starts at; not needed for a path that starts at a pin (`$1.x`). */
    unit?: Unit;
    element?: Element | null;
    expression: string;
}

/** How many earlier inputs the panel remembers. */
export const HISTORY_SIZE = 20;

/** An earlier input: the path, and what it started at. */
interface HistoryEntry {
    text: string;
    unit?: WeakRef<Unit>;
    element?: WeakRef<Element>;
}

const isArgs = ( value: unknown ): value is InspectArgs => typeof value === 'object' && value !== null && typeof ( value as InspectArgs ).expression === 'string';

/**
 * The small panel for looking deeper into one value: a path input, and the live, detailed value it leads to. A name in the tree
 * extends the path; `Track` keeps the path in the watch list; `Pin` makes the object a reference that paths can start at.
 */
export function createInspectPanel( ctx: DebugContext, model: WatchModel, heldBy: HeldBy, onTracked: () => void ): PanelDefinition {
    const { adapter } = ctx;
    /** Kept across openings of the panel. */
    const history: HistoryEntry[] = [];
    return {
        id: 'inspect',
        title: 'Inspect',
        tray: false,
        size: { width: 420, height: 300 },
        // Next to the button that was clicked.
        defaultPosition: 'cursor',
        className: 'kd-inspect-panel',
        mount( pc ) {
            let unit: Unit | undefined;
            let element: Element | null = null;
            let signature = '';
            let current: { value: unknown; ok: boolean } = { value: undefined, ok: false };
            const state = createValueViewState();

            const root = div( 'kd-inspect' );
            const input = document.createElement( 'input' );
            input.className = 'kp-input kd-inspect-input';
            input.spellcheck = false;
            input.placeholder = 'path, e.g. items[0].name';
            /** Where in `history` the input is; `history.length` for an input that is not part of it (yet). */
            let at = 0;
            const back = button( '‹', 'Back to the previous input', () => go( -1 ), { mini: true } );
            const forward = button( '›', 'Forward to the next input', () => go( 1 ), { mini: true } );
            const bar = div( 'kd-inspect-bar' );
            const track = button( 'Track', 'Keep this path in the watch list', () => toggleTrack(), { mini: true } );
            const pin = button( 'Pin', 'Keep this object as a reference ($n) that paths can start at', () => pinValue(), { mini: true } );
            const log = button( 'Log', 'Log the value to the console', () => logGroup( input.value, [['value', current.value], ['copy', safe( () => copyValue( current.value ) )]] ), { mini: true } );
            const controls = div( 'kp-row' );
            controls.append( track, pin, log );
            const message = div( 'kd-inspect-msg' );
            const out = div( 'kd-inspect-out' );
            const held = div( 'kd-inspect-held' );
            bar.append( back, forward, input );
            root.append( bar, controls, message, out, held );

            const same = ( a: HistoryEntry, text: string ): boolean => a.text === text && a.unit?.deref() === unit;
            const currentEntry = (): HistoryEntry => ( { text: input.value, unit: unit && new WeakRef( unit ), element: element ? new WeakRef( element ) : undefined } );

            /** Keeps the current input in the history, unless it is empty or the last one already. */
            const remember = (): void => {
                const last = history[history.length - 1];
                if ( input.value.trim() && !( last && same( last, input.value ) ) ) {
                    history.push( currentEntry() );
                    if ( history.length > HISTORY_SIZE ) {
                        history.shift();
                    }
                }
                at = history.length;
            };

            const showEntry = ( entry: HistoryEntry ): void => {
                unit = entry.unit?.deref();
                element = entry.element?.deref() ?? null;
                input.value = entry.text;
                setTitle();
                update( true );
            };

            /** Back and forward through the history, like a browser: an input that is not in it yet is kept, so that forward comes back to it. */
            function go( step: -1 | 1 ): void {
                if ( at >= history.length ) {
                    remember();
                    const last = history[history.length - 1];
                    at = last && same( last, input.value ) ? history.length - 1 : history.length;
                }
                const next = at + step;
                if ( next < 0 || next >= history.length ) {
                    return;
                }
                at = next;
                showEntry( history[at] );
            }

            const updateNav = (): void => {
                const last = history[history.length - 1];
                const covered = last && same( last, input.value ) ? 1 : 0;
                back.disabled = at >= history.length ? history.length <= covered : at <= 0;
                forward.disabled = at >= history.length - 1;
            };

            /** The input is edited (by hand or by a click in the tree): it is not an entry of the history any more. */
            const setText = ( text: string ): void => {
                input.value = text;
                at = history.length;
                update( true );
            };

            /** The input is replaced as a whole: what was there is kept. */
            const replaceInput = ( text: string ): void => {
                remember();
                setText( text );
            };

            const setTitle = (): void => pc.setTitle( `Inspect · ${unit ? adapter.units.describe( unit ).name : 'reference'}` );

            const toggleTrack = (): void => {
                const on = model.toggleExpression( unit ? { unit, element } : undefined, input.value );
                if ( on === true ) {
                    remember();
                }
                if ( on !== undefined ) {
                    onTracked();
                    update( true );
                }
            };

            const pinValue = (): void => {
                if ( !current.ok || typeof current.value !== 'object' || current.value === null ) {
                    return;
                }
                const name = unit ? adapter.units.describe( unit ).name : '';
                const created = model.pinValue( unit ? { unit, element } : undefined, input.value, current.value, `${name ? `${name}.` : ''}${model.reader.canonical( input.value ) ?? input.value}` );
                onTracked();
                replaceInput( created.id );
            };

            /** A name in the tree was clicked: the path continues there. */
            const pick = ( path: Segment[] ): void => {
                const parsed = model.reader.parse( input.value );
                if ( parsed.ok ) {
                    setText( formatExpression( { base: parsed.expression.base, segments: [...parsed.expression.segments, ...path] } ) );
                }
            };

            /** Where else the value is held, if it is an object: the same service in several units, say. */
            let heldKey = '';
            const showHeld = ( found: ReturnType<HeldBy['of']> ): void => {
                const key = found.map( r => `${r.name}.${r.member ?? ''}` ).join( ',' );
                if ( key !== heldKey ) {
                    heldKey = key;
                    held.replaceChildren( ...( found.length ? [heldBy.render( found )!] : [] ) );
                }
            };

            function update( force: boolean ): void {
                updateNav();
                const text = input.value;
                const parsed = model.reader.parse( text );
                message.classList.toggle( 'kd-error', !parsed.ok );
                track.disabled = !parsed.ok || ( !unit && parsed.ok && parsed.expression.base.kind === 'unit' );
                if ( !parsed.ok ) {
                    message.textContent = `${parsed.error} (at ${parsed.at})`;
                    out.replaceChildren();
                    showHeld( [] );
                    pin.disabled = true;
                    current = { value: undefined, ok: false };
                    signature = '';
                    return;
                }
                track.classList.toggle( 'kp-on', model.isExpressionTracked( unit, text ) );
                const evaluation = model.reader.evaluate( unit, parsed.expression );
                if ( !evaluation.ok ) {
                    message.textContent = `⊘ ${evaluation.message}`;
                    message.classList.add( 'kd-error' );
                    out.replaceChildren();
                    showHeld( [] );
                    pin.disabled = true;
                    current = { value: undefined, ok: false };
                    signature = '';
                    return;
                }
                message.textContent = '';
                current = { value: evaluation.value, ok: true };
                pin.disabled = typeof evaluation.value !== 'object' || evaluation.value === null;
                showHeld( heldBy.of( evaluation.value ) );
                // Redraw only when what is shown changed; the opened nodes are kept in `state`.
                const next = `${text}\u0003${JSON.stringify( copyValue( evaluation.value ) )}\u0003${safe( () => adapter.reactivity?.nodeOf( evaluation.value )?.version )}`;
                if ( next === signature && !force ) {
                    return;
                }
                signature = next;
                out.replaceChildren( renderValueTree( describeValue( evaluation.value, adapter.reactivity ), { state, onPick: pick, highlight: ctx.highlightHover } ) );
            }

            input.oninput = () => {
                at = history.length;
                update( true );
            };

            return {
                content: root,
                onShow( args ) {
                    if ( isArgs( args ) ) {
                        remember();
                        unit = args.unit;
                        element = args.element ?? null;
                        state.open.clear();
                        state.limits.clear();
                        setTitle();
                        setText( args.expression );
                        input.focus();
                    } else if ( !input.value ) {
                        // Restored from the saved state of an earlier page load: there is nothing to inspect, so there is nothing to show.
                        queueMicrotask( () => pc.panel.close() );
                    }
                },
                refresh: () => update( false ),
                onHide: () => ctx.highlightHover( null ),
                dispose: () => ctx.highlightHover( null )
            };
        }
    };
}
