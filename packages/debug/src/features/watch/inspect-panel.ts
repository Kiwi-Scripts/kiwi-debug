import { button, div, type PanelDefinition } from '@kiwi-js/panels';

import type { Unit } from '../../adapter/types';
import { logGroup } from '../../core/console';
import { formatExpression, type Segment } from '../../core/expressions';
import { copyValue } from '../../core/format';
import { safe } from '../../core/safe';
import type { DebugContext } from '../../core/types';
import { createValueViewState, renderValueTree } from '../../core/value-view';
import { describeValue } from '../../core/values';
import type { WatchModel } from './model';

/** What `overlay.panels.open( 'inspect', args )` takes. */
export interface InspectArgs {
    /** The unit a path starts at; not needed for a path that starts at a pin (`$1.x`). */
    unit?: Unit;
    element?: Element | null;
    expression: string;
}

const isArgs = ( value: unknown ): value is InspectArgs => typeof value === 'object' && value !== null && typeof ( value as InspectArgs ).expression === 'string';

/**
 * The small panel for looking deeper into one value: a path input, and the live, detailed value it leads to. A name in the tree
 * extends the path; `Track` keeps the path in the watch list; `Pin` makes the object a reference that paths can start at.
 */
export function createInspectPanel( ctx: DebugContext, model: WatchModel, onTracked: () => void ): PanelDefinition {
    const { adapter } = ctx;
    return {
        id: 'inspect',
        title: 'Inspect',
        tray: false,
        size: { width: 380 },
        defaultPosition: 'bottom-left',
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
            const track = button( 'Track', 'Keep this path in the watch list', () => toggleTrack(), { mini: true } );
            const pin = button( 'Pin', 'Keep this object as a reference ($n) that paths can start at', () => pinValue(), { mini: true } );
            const log = button( 'Log', 'Log the value to the console', () => logGroup( input.value, [['value', current.value], ['copy', safe( () => copyValue( current.value ) )]] ), { mini: true } );
            const controls = div( 'kp-row' );
            controls.append( track, pin, log );
            const message = div( 'kd-inspect-msg' );
            const out = div( 'kd-inspect-out' );
            root.append( input, controls, message, out );

            const setText = ( text: string ): void => {
                input.value = text;
                update( true );
            };

            const toggleTrack = (): void => {
                const on = model.toggleExpression( unit ? { unit, element } : undefined, input.value );
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
                const created = model.pins.pin( current.value, `${name ? `${name}.` : ''}${model.reader.canonical( input.value ) ?? input.value}` );
                onTracked();
                setText( created.id );
            };

            /** A name in the tree was clicked: the path continues there. */
            const pick = ( path: Segment[] ): void => {
                const parsed = model.reader.parse( input.value );
                if ( parsed.ok ) {
                    setText( formatExpression( { base: parsed.expression.base, segments: [...parsed.expression.segments, ...path] } ) );
                }
            };

            function update( force: boolean ): void {
                const text = input.value;
                const parsed = model.reader.parse( text );
                message.classList.toggle( 'kd-error', !parsed.ok );
                track.disabled = !parsed.ok || ( !unit && parsed.ok && parsed.expression.base.kind === 'unit' );
                if ( !parsed.ok ) {
                    message.textContent = `${parsed.error} (at ${parsed.at})`;
                    out.replaceChildren();
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
                    pin.disabled = true;
                    current = { value: undefined, ok: false };
                    signature = '';
                    return;
                }
                message.textContent = '';
                current = { value: evaluation.value, ok: true };
                pin.disabled = typeof evaluation.value !== 'object' || evaluation.value === null;
                // Redraw only when what is shown changed; the opened nodes are kept in `state`.
                const next = `${text}\u0003${JSON.stringify( copyValue( evaluation.value ) )}\u0003${safe( () => adapter.reactivity?.nodeOf( evaluation.value )?.version )}`;
                if ( next === signature && !force ) {
                    return;
                }
                signature = next;
                out.replaceChildren( renderValueTree( describeValue( evaluation.value, adapter.reactivity ), { state, onPick: pick, highlight: ctx.highlightHover } ) );
            }

            input.oninput = () => update( true );

            return {
                content: root,
                onShow( args ) {
                    if ( isArgs( args ) ) {
                        unit = args.unit;
                        element = args.element ?? null;
                        state.open.clear();
                        state.limits.clear();
                        const name = unit ? adapter.units.describe( unit ).name : 'reference';
                        pc.setTitle( `Inspect · ${name}` );
                        input.value = args.expression;
                        update( true );
                        input.focus();
                    }
                },
                refresh: () => update( false ),
                onHide: () => ctx.highlightHover( null ),
                dispose: () => ctx.highlightHover( null )
            };
        }
    };
}
