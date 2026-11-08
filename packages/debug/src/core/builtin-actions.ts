import { logGroup } from './console';
import { safe } from './safe';
import { Tracking } from './services';
import type { ActionConfig, ActionDef, ActionRegistry } from './actions';

/** What the overlay shows when the options do not say otherwise (the same buttons as always, plus `inspect`). */
export const DEFAULT_ACTIONS = {
    row: ['track', 'graph', 'expressions'] as ActionConfig[],
    unit: ['track', 'graph', 'address', 'keep', 'side', 'remove'] as ActionConfig[]
};

const trackRow: ActionDef = {
    id: 'track',
    icon: '◉',
    slot: 'leading',
    className: 'kd-watch',
    title: c => trackRow.isOn!( c ) ? 'Stop tracking this value' : 'Track this value',
    visible: c => !!c.ctx.use( Tracking ),
    isOn: c => !!c.row && !!c.ctx.use( Tracking )?.isWatched( c.target.unit, c.row.category, c.row.name ),
    run: c => c.row && c.ctx.use( Tracking )?.toggleValueWatch( c.target, c.row.category, c.row.name )
};

const graphRow: ActionDef = {
    id: 'graph',
    icon: '⬡',
    title: 'Show in the signal graph',
    visible: c => !!c.row && !!c.ctx.adapter.reactivity && !!c.ctx.overlay.panels.get( 'graph' )
        && !!safe( () => c.ctx.adapter.reactivity!.nodeOf( c.row!.read() ) ),
    run: c => c.row && c.ctx.overlay.panels.open( 'graph', { owner: c.target.unit, name: c.row.name, read: c.row.read } )
};

const trackUnit: ActionDef = {
    id: 'track',
    icon: '◉',
    className: 'kd-watch',
    surfaces: ['inspector', 'search', 'side'],
    title: 'Track this unit',
    visible: c => !!c.ctx.use( Tracking ),
    isOn: c => !!c.ctx.use( Tracking )?.isWatched( c.target.unit ),
    run: c => c.ctx.use( Tracking )?.toggleDirectiveWatch( c.target )
};

const graphUnit: ActionDef = {
    id: 'graph',
    icon: '⬡',
    surfaces: ['inspector', 'search', 'side'],
    title: 'Show the signal graph',
    visible: c => !!c.ctx.adapter.reactivity && !!c.ctx.overlay.panels.get( 'graph' ),
    run: c => c.ctx.overlay.panels.open( 'graph', c.target.element ? { element: c.target.element } : { directive: c.target.unit } )
};

const addressUnit: ActionDef = {
    id: 'address',
    icon: '⌖',
    surfaces: ['inspector'],
    title: 'Log the address of this unit',
    visible: c => !!c.target.element && c.ctx.adapter.addressing?.of( c.target.unit, c.target.element ) !== undefined,
    run: c => {
        const name = c.ctx.adapter.units.describe( c.target.unit ).name;
        logGroup( name, [['address', c.target.element && c.ctx.adapter.addressing?.of( c.target.unit, c.target.element )]] );
    }
};

/** Registers the actions the core provides. The features register theirs (`keep`, `side`, `remove`, `inspect`) when they are set up. */
export function registerBuiltinActions( registry: ActionRegistry ): void {
    registry.register( 'row', trackRow );
    registry.register( 'row', graphRow );
    registry.register( 'unit', trackUnit );
    registry.register( 'unit', graphUnit );
    registry.register( 'unit', addressUnit );
}
