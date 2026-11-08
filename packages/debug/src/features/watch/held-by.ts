import { div, span } from '@kiwi-js/panels';

import { findReferences, referenceLabel, type Reference } from '../../core/references';
import { Tracking } from '../../core/services';
import type { DebugContext } from '../../core/types';

/** How long the units on the page are not looked through again for the same object. */
const CACHE_MS = 2000;

export interface HeldBy {
    /** Where the object is held (cached for a moment, since this looks through the page). */
    of( object: unknown ): Reference[];
    /** A row with one chip per place: it tracks that value, and hovering outlines its element. Empty if there is none. */
    render( held: readonly Reference[] ): HTMLElement | undefined;
}

/** Shows where else an object is held, e.g. which units were given the same service instance. */
export function createHeldBy( ctx: DebugContext ): HeldBy {
    const cache = new WeakMap<object, { at: number; found: Reference[] }>();
    return {
        of( object ) {
            if ( typeof object !== 'object' && typeof object !== 'function' || object === null ) {
                return [];
            }
            const cached = cache.get( object );
            if ( cached && Date.now() - cached.at < CACHE_MS ) {
                return cached.found;
            }
            const found = findReferences( ctx, object );
            cache.set( object, { at: Date.now(), found } );
            return found;
        },
        render( held ) {
            if ( !held.length ) {
                return undefined;
            }
            const row = div( 'kp-row kd-row kd-held' );
            row.append( span( 'kp-muted', 'held by' ) );
            for ( const ref of held ) {
                const chip = span( 'kp-link kd-ref', referenceLabel( ref ), ref.member ? 'Track this value' : 'Track this unit' );
                chip.onclick = () => {
                    const tracking = ctx.use( Tracking );
                    const target = { unit: ref.unit, element: ref.element };
                    if ( ref.member ) {
                        tracking?.toggleValueWatch( target, ref.category ?? 'properties', ref.member );
                    } else {
                        tracking?.toggleDirectiveWatch( target );
                    }
                };
                chip.onmouseenter = () => ctx.highlightHover( ref.element );
                chip.onmouseleave = () => ctx.highlightHover( null );
                row.append( chip );
            }
            return row;
        }
    };
}
