import { badge, div, link, renderDetails, span } from '@kiwi-js/panels';

import type { Unit } from '../adapter/types';
import { renderActions, type ActionContext } from './actions';
import type { ChangeTracker, Snapshot } from './change-tracker';
import { groupKey, rowKey } from './change-tracker';
import { isLoggable, logGroup } from './console';
import { copyValue, preview } from './format';
import { createValueViewState, renderValueTree, type ValueViewState } from './value-view';
import { describeValue } from './values';
import { Profiler, Tracking, type TrackTarget } from './services';
import { safe } from './safe';
import type { DebugContext } from './types';
import type { TrackedRow } from './units';

export interface RowGroupsOptions {
    /** The panel that shows the rows ('inspector', 'watch', 'search', 'side'); decides which actions are offered. */
    surface: string;
    /** Names the unit in change keys: the unit name (inspector) or the entry id (watch). */
    scope: string;
    changes: ChangeTracker;
    /** The readings of this refresh, so that values are not read twice. */
    snapshot?: Snapshot;
    /** Groups are collapsible `details`. Default: true. */
    collapsible?: boolean;
    /** Which groups start expanded; default: inputs only. */
    open?: ( category: string ) => boolean;
    /** Categories to show, in order. Default: inputs, outputs, properties, then the rest. */
    categories?: readonly string[];
    /** Only rows for which this returns true. */
    filter?( row: TrackedRow ): boolean;
    onToggleGroup?( groupKey: string, open: boolean ): void;
}

export interface DirectiveView {
    /** The name of a unit; click logs the instance with its values and sections, modifier + click toggles tracking. */
    nameLink( target: TrackTarget ): HTMLElement;
    /** The buttons of the unit actions (`DebugOptions.actions.unit`) that apply to the surface, for one slot of the head. */
    unitActions( target: TrackTarget, surface: string, slot: 'leading' | 'trailing' ): HTMLElement[];
    /** `renders× / checks` of a counted component; `null` otherwise. */
    profileBadge( unit: Unit ): HTMLElement | null;
    rowGroups( target: TrackTarget, rows: TrackedRow[], options: RowGroupsOptions ): HTMLElement[];
    /**
     * The value of a row: its one-line text, which logs complex values when clicked, or an opening tree with `valueDetail: 'detail'`.
     * `key` identifies the row for the opened nodes that are kept across redraws.
     */
    valueCell( key: string, label: string, read: () => unknown, text?: string ): HTMLElement;
}

const CATEGORY_ORDER = ['inputs', 'outputs', 'properties'];

/** Rendering that inspector, watch list, search and the side view share (spec 5.3). */
export function createDirectiveView( ctx: DebugContext ): DirectiveView {
    const { adapter } = ctx;
    const tracking = (): Tracking | undefined => ctx.use( Tracking );
    const detailed = ctx.options.valueDetail === 'detail';
    /** What the opened trees remember across redraws, per row. */
    const treeStates = new Map<string, ValueViewState>();

    const logUnit = ( target: TrackTarget ): void => {
        const description = adapter.units.describe( target.unit );
        const values: Record<string, unknown> = {};
        for ( const row of ctx.rowsOf( target.unit ) ) {
            values[`${row.category}.${row.name}`] = safe( () => copyValue( row.read() ) ) ?? '?';
        }
        const sections = target.element ? adapter.units.sections?.( target.element ) ?? [] : [];
        logGroup( description.name, [
            ['instance', target.unit],
            ['element', target.element ?? undefined],
            ['values', values],
            ...sections.map( s => [s.label, safe( () => s.read() )] as const )
        ] );
    };

    const valueCell = ( key: string, label: string, read: () => unknown, known?: string ): HTMLElement => {
        const current = safe( read );
        const value = span( 'kd-value', known ?? preview( current, adapter.reactivity ) );
        if ( isLoggable( current ) ) {
            value.classList.add( 'kd-log' );
            value.title = 'Click to log the value';
            value.onclick = () => logGroup( label, [['value', safe( read )], ['copy', safe( () => copyValue( read() ) )]] );
        }
        if ( detailed ) {
            const node = describeValue( current, adapter.reactivity );
            if ( node.expandable ) {
                let state = treeStates.get( key );
                if ( !state ) {
                    treeStates.set( key, state = createValueViewState() );
                }
                return renderValueTree( node, { state, highlight: ctx.highlightHover } );
            }
        }
        return value;
    };

    const view: DirectiveView = {
        valueCell,
        nameLink( target ) {
            const { name } = adapter.units.describe( target.unit );
            const el = link( name, 'Click to log; hold the modifier and click to track', () => undefined );
            el.onclick = ev => {
                ev.preventDefault();
                ev.stopPropagation();
                if ( ctx.isHeld( ev ) && tracking() ) {
                    tracking()!.toggleDirectiveWatch( target );
                } else {
                    logUnit( target );
                }
            };
            return el;
        },
        unitActions( target, surface, slot ) {
            const c: ActionContext = { ctx, surface, target };
            return renderActions( ctx.actions.resolve( 'unit', surface ), slot, c );
        },
        profileBadge( unit ) {
            const counts = ctx.use( Profiler )?.countsOf( unit );
            if ( !counts ) {
                return null;
            }
            const el = badge( `${counts.renders}× / ${counts.checks}` );
            el.title = 'renders / checks';
            el.classList.toggle( 'kd-rendering', counts.rendering );
            return el;
        },
        rowGroups( target, rows, options ) {
            const { scope, changes, surface } = options;
            const wanted = options.categories ?? Array.from( new Set( [...CATEGORY_ORDER, ...rows.map( r => r.category )] ) );
            const out: HTMLElement[] = [];
            for ( const category of wanted ) {
                const inGroup = rows.filter( r => r.category === category && ( options.filter?.( r ) ?? true ) );
                if ( !inGroup.length ) {
                    continue;
                }
                const key = groupKey( scope, category );
                const renderRow = ( row: TrackedRow ): HTMLElement => {
                    const key = rowKey( scope, row.category, row.name );
                    const reading = options.snapshot?.get( key );
                    const el = div( 'kp-row kd-row' );
                    const actions = ctx.actions.resolve( 'row', surface );
                    const c: ActionContext = { ctx, surface, target, row };
                    const value = valueCell( key, `${row.label ?? row.name}`, row.read, reading?.text );
                    el.append(
                        ...renderActions( actions, 'leading', c ),
                        span( `kd-name kd-${row.category}`, row.label && row.label !== row.name ? `${row.label} (${row.name})` : row.name ),
                        ' = ', value,
                        ...renderActions( actions, 'trailing', c ) );
                    changes.markRow( el, key );
                    el.onmouseenter = () => changes.dismiss( key );
                    return el;
                };
                const body = (): HTMLElement[] => inGroup.map( renderRow );
                if ( options.collapsible === false ) {
                    const group = div( 'kd-group' );
                    group.dataset.key = key;
                    group.append( span( 'kp-muted', category ), ...body() );
                    out.push( group );
                    continue;
                }
                const unseen = changes.unseenIn( key );
                out.push( renderDetails( {
                    className: 'kp-dir kd-group',
                    key,
                    open: options.open ? options.open( category ) : category === 'inputs',
                    head: [span( 'kp-muted', category ), ' ', badge( String( inGroup.length ) ), ...( unseen ? [' ', badge( `${unseen} changed` )] : [] )],
                    body,
                    onToggle: open => {
                        if ( open ) {
                            changes.acknowledge( key );
                        }
                        options.onToggleGroup?.( key, open );
                    }
                } ) );
            }
            return out;
        }
    };
    return view;
}
