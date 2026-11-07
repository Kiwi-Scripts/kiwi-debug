import { button } from '@kiwi-js/panels';

import { safe } from './safe';
import type { TrackTarget } from './services';
import type { DebugContext } from './types';
import type { TrackedRow } from './units';

/** Where an action is offered: next to a value row, or in the head of a unit. */
export type ActionScope = 'row' | 'unit';

/** What an action is told when it is rendered or run. */
export interface ActionContext {
    ctx: DebugContext;
    /** The panel that shows the row: 'inspector', 'watch', 'search' or 'side'. */
    surface: string;
    target: TrackTarget;
    /** Row actions only. */
    row?: TrackedRow;
}

export interface ActionDef {
    id: string;
    /** A glyph or short text, or a node (cloned wherever it is shown). */
    icon: string | Node;
    title: string | ( ( c: ActionContext ) => string );
    /** Before the name (`leading`) or after the value (`trailing`). Default: 'trailing'. */
    slot?: 'leading' | 'trailing';
    /** The surfaces that show the action; without it, all of them. */
    surfaces?: readonly string[];
    /** Checked each time the row is drawn. */
    visible?( c: ActionContext ): boolean;
    /** Shows the button as switched on, for toggles. Checked after every run. */
    isOn?( c: ActionContext ): boolean;
    /** An extra class for the button. */
    className?: string;
    run( c: ActionContext, ev: MouseEvent ): void;
}

/** What the options list: a built-in action by name, or a definition (which replaces a built-in with the same id). */
export type ActionConfig = string | ActionDef;

export interface ActionLists {
    row: ActionConfig[];
    unit: ActionConfig[];
}

export interface ActionRegistry {
    /** Makes an action available by name. Returns what removes it again. */
    register( scope: ActionScope, def: ActionDef ): () => void;
    /** The actions to show, in configured order, for a surface; names that are not registered are skipped. */
    resolve( scope: ActionScope, surface: string ): ActionDef[];
}

export function createActionRegistry( lists: ActionLists ): ActionRegistry {
    const registered: Record<ActionScope, Map<string, ActionDef>> = { row: new Map(), unit: new Map() };
    return {
        register( scope, def ) {
            registered[scope].set( def.id, def );
            return () => void ( registered[scope].get( def.id ) === def && registered[scope].delete( def.id ) );
        },
        resolve( scope, surface ) {
            return lists[scope]
                .map( item => typeof item === 'string' ? registered[scope].get( item ) : item )
                .filter( ( def ): def is ActionDef => !!def && ( !def.surfaces || def.surfaces.includes( surface ) ) );
        }
    };
}

/** The ids of an action list, for the signature that decides whether the overlay has to be rebuilt. */
export const actionIds = ( list: readonly ActionConfig[] ): string[] => list.map( item => typeof item === 'string' ? item : item.id );

const titleOf = ( def: ActionDef, c: ActionContext ): string => typeof def.title === 'string' ? def.title : safe( () => ( def.title as ( c: ActionContext ) => string )( c ) ) ?? def.id;

const iconOf = ( icon: string | Node ): Node | string => typeof icon === 'string' ? icon : icon.cloneNode( true );

/**
 * The buttons of the actions that are visible for the context and slot. A handler that throws does not break the overlay; afterwards
 * the toggle state is read again and the panels are asked to refresh.
 */
export function renderActions( defs: readonly ActionDef[], slot: 'leading' | 'trailing', c: ActionContext ): HTMLElement[] {
    const buttons: HTMLElement[] = [];
    for ( const def of defs ) {
        if ( ( def.slot ?? 'trailing' ) !== slot || ( def.visible && !safe( () => def.visible!( c ) ) ) ) {
            continue;
        }
        const on = (): boolean => !!def.isOn && !!safe( () => def.isOn!( c ) );
        const el = button( '', titleOf( def, c ), () => undefined, { mini: true, on: on() } );
        el.onclick = ev => {
            safe( () => def.run( c, ev ) );
            el.classList.toggle( 'kp-on', on() );
            el.title = titleOf( def, c );
            c.ctx.overlay.requestRefresh();
        };
        el.replaceChildren( iconOf( def.icon ) );
        el.classList.add( 'kd-action', `kd-action-${def.id}` );
        if ( def.className ) {
            el.classList.add( ...def.className.split( ' ' ) );
        }
        buttons.push( el );
    }
    return buttons;
}
