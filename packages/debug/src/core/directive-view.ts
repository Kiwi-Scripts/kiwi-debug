import { badge, button, div, link, renderDetails, span } from '@kiwi-js/panels';

import type { Unit } from '../adapter/types';
import type { ChangeTracker, Snapshot } from './change-tracker';
import { groupKey, rowKey } from './change-tracker';
import { logGroup } from './console';
import { copyValue, preview } from './format';
import { Profiler, Tracking, type TrackTarget } from './services';
import { safe } from './safe';
import type { DebugContext } from './types';
import type { TrackedRow } from './units';

export interface RowGroupsOptions {
    /** Names the unit in change keys: the unit name (inspector) or the entry id (watch). */
    scope: string;
    changes: ChangeTracker;
    /** The readings of this refresh, so that values are not read twice. */
    snapshot?: Snapshot;
    /** Whether the per-row icon starts or stops tracking. 'none' leaves it out. Default: 'track'. */
    rowIcon?: 'track' | 'untrack' | 'none';
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
    /** Toggles tracking of the whole unit; `null` where nothing provides tracking. */
    watchIcon( target: TrackTarget ): HTMLElement | null;
    /** Opens the graph for the unit; `null` without reactivity or a graph panel. */
    graphIcon( target: TrackTarget ): HTMLElement | null;
    /** `renders× / checks` of a counted component; `null` otherwise. */
    profileBadge( unit: Unit ): HTMLElement | null;
    rowGroups( target: TrackTarget, rows: TrackedRow[], options: RowGroupsOptions ): HTMLElement[];
}

const CATEGORY_ORDER = ['inputs', 'outputs', 'properties'];

/** Rendering that inspector, watch list, search and the side panel share (spec 5.3). */
export function createDirectiveView( ctx: DebugContext ): DirectiveView {
    const { adapter } = ctx;
    const tracking = (): Tracking | undefined => ctx.use( Tracking );
    const nodeOf = ( value: unknown ) => safe( () => adapter.reactivity?.nodeOf( value ) );

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

    const view: DirectiveView = {
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
        watchIcon( target ) {
            const service = tracking();
            if ( !service ) {
                return null;
            }
            return ctx.watchButton( 'Track this unit', () => service.isWatched( target.unit ), () => service.toggleDirectiveWatch( target ) );
        },
        graphIcon( target ) {
            if ( !adapter.reactivity || !ctx.overlay.panels.get( 'graph' ) ) {
                return null;
            }
            return button( '⬡', 'Show the signal graph', () => ctx.overlay.panels.open( 'graph', target.element ? { element: target.element } : { directive: target.unit } ), { mini: true } );
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
            const { scope, changes } = options;
            const wanted = options.categories ?? Array.from( new Set( [...CATEGORY_ORDER, ...rows.map( r => r.category )] ) );
            const rowIcon = options.rowIcon ?? 'track';
            const out: HTMLElement[] = [];
            for ( const category of wanted ) {
                const inGroup = rows.filter( r => r.category === category && ( options.filter?.( r ) ?? true ) );
                if ( !inGroup.length ) {
                    continue;
                }
                const key = groupKey( scope, category );
                const body = (): HTMLElement[] => inGroup.map( row => renderRow( row ) );
                const renderRow = ( row: TrackedRow ): HTMLElement => {
                    const key = rowKey( scope, row.category, row.name );
                    const reading = options.snapshot?.get( key );
                    const text = reading?.text ?? preview( safe( () => row.read() ), adapter.reactivity );
                    const el = div( 'kp-row kd-row' );
                    const service = tracking();
                    if ( service && rowIcon !== 'none' ) {
                        el.append( ctx.watchButton( rowIcon === 'untrack' ? 'Stop tracking this value' : 'Track this value',
                            () => service.isWatched( target.unit, row.category, row.name ), () => service.toggleValueWatch( target, row.category, row.name ) ) );
                    }
                    const value = span( 'kd-value', text, 'Click to log the value' );
                    value.onclick = () => logGroup( `${row.label ?? row.name}`, [['value', safe( () => row.read() )], ['copy', safe( () => copyValue( row.read() ) )]] );
                    el.append( span( `kd-name kd-${row.category}`, row.label && row.label !== row.name ? `${row.label} (${row.name})` : row.name ), ' = ', value );
                    const node = nodeOf( safe( () => row.read() ) );
                    if ( node && ctx.overlay.panels.get( 'graph' ) ) {
                        el.append( button( '⬡', 'Show in the signal graph', () => ctx.overlay.panels.open( 'graph', { owner: target.unit, name: row.name, read: row.read } ), { mini: true } ) );
                    }
                    changes.markRow( el, key );
                    el.onmouseenter = () => changes.dismiss( key );
                    return el;
                };
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
