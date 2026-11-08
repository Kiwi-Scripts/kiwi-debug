import { walkElements } from '@kiwi-js/dom';

import type { Unit } from '../adapter/types';
import { safe } from './safe';
import type { DebugContext } from './types';

/** A place that holds a given object. */
export interface Reference {
    unit: Unit;
    element: Element;
    name: string;
    /** The unit's `group`, e.g. 'properties'; `undefined` if the unit *is* the object. */
    category?: string;
    /** The member that holds the object; `undefined` if the unit is the object itself. */
    member?: string;
}

const MAX_ELEMENTS = 5000;

/**
 * Where an object is held, as far as the members of the units on the page go: a service that two directives are given shows up
 * on both. This is how an injected instance that was overridden somewhere becomes visible, since the units that got another one
 * are missing from the list. Only direct members are looked at, not what lies deeper inside them.
 */
export function findReferences( ctx: DebugContext, object: unknown, limit = 50 ): Reference[] {
    if ( typeof object !== 'object' && typeof object !== 'function' || object === null ) {
        return [];
    }
    const { adapter } = ctx;
    const found: Reference[] = [];
    const seen = new Set<Unit>();
    let visited = 0;
    const visit = ( el: Element ): void => {
        for ( const unit of safe( () => adapter.units.at( el ) ) ?? [] ) {
            if ( seen.has( unit ) || found.length >= limit ) {
                continue;
            }
            seen.add( unit );
            const name = adapter.units.describe( unit ).name;
            if ( safe( () => adapter.units.instance?.( unit ) ) === object ) {
                found.push( { unit, element: el, name } );
            }
            for ( const row of ctx.rowsOf( unit ) ) {
                if ( row.category !== 'form' && found.length < limit && safe( () => row.read() ) === object ) {
                    found.push( { unit, element: el, name, category: row.category, member: row.name } );
                }
            }
        }
    };
    visit( document.body );
    for ( const el of walkElements( document.body, { reject: e => ctx.overlay.inOverlay( e ), composed: true } ) ) {
        if ( ++visited > MAX_ELEMENTS || found.length >= limit ) {
            break;
        }
        visit( el );
    }
    return found;
}

/** `Name.member`, or `Name` where the unit is the object. */
export const referenceLabel = ( ref: Reference ): string => ref.member ? `${ref.name}.${ref.member}` : ref.name;
