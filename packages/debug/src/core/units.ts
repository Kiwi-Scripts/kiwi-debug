import { closestMatch, nearestDescendants } from '@kiwi-js/dom';

import type { FormState, GuardedAdapter, Unit } from '../adapter/types';

/** What an inspectable element carries: its component (if any) and the other units, in the adapter's order. */
export interface Inspection {
    element: Element;
    component: Unit | null;
    directives: Unit[];
}

/** One value of a unit that can be shown, diffed and tracked. */
export interface TrackedRow {
    unit: Unit;
    /** 'inputs', 'outputs', 'properties', or 'form' for the rows the core adds from the forms capability. */
    category: string;
    name: string;
    /** The template-facing alias, if it differs from `name`. */
    label?: string;
    /** May throw, see {@link Member.read}. */
    read(): unknown;
}

export interface UnitReaders {
    /** `null` if no unit is attached to the element. */
    inspect( el: Element ): Inspection | null;
    /** The nearest inspectable ancestor, across shadow roots. */
    findParent( start: Element, includeSelf?: boolean ): Element | null;
    /** The nearest inspectable descendants only (below an inspectable element the search stops). */
    findChildren( start: Element ): Element[];
    rowsOf( unit: Unit ): TrackedRow[];
}

/** The thin binding of the DOM helpers to `adapter.units.at`. `skip` is the overlay: its elements are never inspectable. */
export function createUnitReaders( adapter: GuardedAdapter, skip: ( el: Element ) => boolean ): UnitReaders {
    const inspect = ( el: Element ): Inspection | null => {
        if ( skip( el ) ) {
            return null;
        }
        const units = adapter.units.at( el );
        if ( !units.length ) {
            return null;
        }
        const component = units.find( u => adapter.units.describe( u ).kind === 'component' ) ?? null;
        return { element: el, component, directives: units.filter( u => u !== component ) };
    };

    const FORM_ROWS: ReadonlyArray<readonly [string, ( state: FormState ) => unknown]> = [
        ['value', s => s.value],
        ['status', s => s.status],
        ['errors', s => s.errors.map( ( [kind] ) => kind )],
        ['touched', s => s.touched],
        ['dirty', s => s.dirty]
    ];

    return {
        inspect,
        findParent: ( start, includeSelf = false ) => closestMatch( start, inspect, { includeSelf, composed: true } )?.element ?? null,
        findChildren: start => nearestDescendants( start, inspect, { reject: skip, composed: true } ).map( m => m.element ),
        rowsOf( unit ) {
            const rows: TrackedRow[] = adapter.units.members( unit ).map( m => ( { unit, category: m.group, name: m.name, label: m.label, read: () => m.read() } ) );
            const control = adapter.forms?.controlOf?.( unit );
            if ( control ) {
                for ( const [name, pick] of FORM_ROWS ) {
                    rows.push( { unit, category: 'form', name, read: () => pick( control.state() ) } );
                }
            }
            return rows;
        }
    };
}
