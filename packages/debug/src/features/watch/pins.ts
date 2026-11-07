/**
 * Pinned references: an object that was picked through a path and made a static reference on purpose. Expressions may start at
 * one (`$1.users[0]`) and are re-evaluated on every refresh; the pin itself is the only thing that stays.
 *
 * A pin holds its object weakly, so pinning does not keep it alive. If it is collected, the pin shows as gone.
 */
export interface Pin {
    /** `$1`, `$2`, … */
    readonly id: string;
    /** Where it was picked, for display: `Card.items[2]`. */
    readonly origin: string;
    /** Canonical expressions starting at this pin that are tracked, e.g. `$1.users[0]`. */
    readonly paths: Set<string>;
}

export interface Pins {
    pin( object: object, origin: string ): Pin;
    get( id: string ): Pin | undefined;
    /** The object behind a pin; `undefined` if the pin is unknown or the object is gone. */
    resolve( id: string ): object | undefined;
    list(): readonly Pin[];
    remove( id: string ): void;
    onChange( cb: () => void ): () => void;
}

export function createPins(): Pins {
    const pins = new Map<string, { pin: Pin; ref: WeakRef<object> }>();
    const listeners = new Set<() => void>();
    let counter = 0;
    const changed = (): void => listeners.forEach( cb => cb() );
    return {
        pin( object, origin ) {
            // The same object keeps its pin.
            for ( const { pin, ref } of pins.values() ) {
                if ( ref.deref() === object ) {
                    return pin;
                }
            }
            const pin: Pin = { id: `$${++counter}`, origin, paths: new Set() };
            pins.set( pin.id, { pin, ref: new WeakRef( object ) } );
            changed();
            return pin;
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
