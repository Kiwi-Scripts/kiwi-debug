import type { Unit } from '../../adapter/types';

/**
 * Pinned references: an object that was picked through a path and made a static reference on purpose. Expressions may start at
 * one (`$1.users[0]`) and are re-evaluated on every refresh; the pin itself is the only thing that stays.
 *
 * A pin holds its object weakly, so pinning does not keep it alive. If it is collected, the pin shows as gone, and is
 * pointed at what its source path leads to now, if there is one.
 */

/** Where a pin was picked: the path that leads to the object, and what it starts at. */
export interface PinSource {
    /** The canonical path: relative to the unit (`items[2]`), or starting at another pin (`$1.users[0]`). */
    expression: string;
    /** The address of the unit the path starts at (`addressing`), so that the pin can be found again after a reload. */
    address?: string;
    /** The unit and element the path starts at; weak. */
    unit?: WeakRef<object>;
    element?: WeakRef<Element>;
}

export interface Pin {
    /** `$1`, `$2`, … */
    readonly id: string;
    /** Where it was picked, for display: `Card.items[2]`. */
    readonly origin: string;
    /** Canonical expressions starting at this pin that are tracked, e.g. `$1.users[0]`. */
    readonly paths: Set<string>;
    readonly source?: PinSource;
}

export interface Pins {
    pin( object: object, origin: string, source?: PinSource ): Pin;
    /** Brings back a pin of an earlier page load, under its old id. */
    restore( stored: { id: string; origin: string; paths: readonly string[]; source?: PinSource }, object: object ): Pin;
    /** Points a pin whose object is gone at another one. */
    rebind( id: string, object: object ): void;
    get( id: string ): Pin | undefined;
    /** The object behind a pin; `undefined` if the pin is unknown or the object is gone. */
    resolve( id: string ): object | undefined;
    list(): readonly Pin[];
    remove( id: string ): void;
    onChange( cb: () => void ): () => void;
}

export const unitOf = ( source: Pick<PinSource, 'unit'> | undefined ): Unit | undefined => source?.unit?.deref() as Unit | undefined;

export function createPins(): Pins {
    const pins = new Map<string, { pin: Pin; ref: WeakRef<object> }>();
    const listeners = new Set<() => void>();
    let counter = 0;
    const changed = (): void => listeners.forEach( cb => cb() );
    return {
        pin( object, origin, source ) {
            // The same object keeps its pin.
            for ( const { pin, ref } of pins.values() ) {
                if ( ref.deref() === object ) {
                    return pin;
                }
            }
            const pin: Pin = { id: `$${++counter}`, origin, paths: new Set(), source };
            pins.set( pin.id, { pin, ref: new WeakRef( object ) } );
            changed();
            return pin;
        },
        restore( stored, object ) {
            const pin: Pin = { id: stored.id, origin: stored.origin, paths: new Set( stored.paths ), source: stored.source };
            counter = Math.max( counter, Number( stored.id.slice( 1 ) ) || 0 );
            pins.set( pin.id, { pin, ref: new WeakRef( object ) } );
            changed();
            return pin;
        },
        rebind( id, object ) {
            const entry = pins.get( id );
            if ( entry ) {
                entry.ref = new WeakRef( object );
                changed();
            }
        },
        get: id => pins.get( id )?.pin,
        resolve: id => pins.get( id )?.ref.deref(),
        list: () => Array.from( pins.values(), e => e.pin ),
        remove( id ) {
            if ( pins.delete( id ) ) {
                changed();
            }
        },
        onChange: cb => {
            listeners.add( cb );
            return () => void listeners.delete( cb );
        }
    };
}
