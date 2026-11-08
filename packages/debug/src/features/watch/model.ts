import type { StorageAdapter } from '@kiwi-js/panels';

import type { Unit } from '../../adapter/types';
import type { Tracking, TrackTarget } from '../../core/services';
import type { DebugContext } from '../../core/types';
import type { TrackedRow } from '../../core/units';
import { createPathReader, EXPRESSIONS, type PathReader } from './paths';
import { createPins, unitOf, type Pin, type PinSource, type Pins } from './pins';

export const DEFAULT_TRACKED_COLORS = ['#ff9800', '#4fc3f7', '#7cc05b', '#d66ad6', '#e5c07b', '#f44747', '#9cdcfe', '#c586c0'];

/** How long a restore keeps trying, and how often. */
export const RESTORE_FOR_MS = 30_000;
export const RESTORE_EVERY_MS = 500;

/**
 * What a tracked value is called in a selection: a member by its name (member names are unique), an expression by its text, and a
 * form row by `#form:name`, which cannot be mistaken for either.
 */
export const selectionKey = ( category: string, name: string ): string => category === 'form' ? `#form:${name}` : name;

export interface WatchEntry {
    id: string;
    unit: Unit;
    element: Element;
    kind: string;
    name: string;
    /** Tracks every member of the unit, including properties that appear later. Expressions are tracked in `selected` either way. */
    all: boolean;
    /** The tracked values (see {@link selectionKey}); with `all`, only the expressions among them count. */
    selected: Set<string>;
    expanded: boolean;
    address?: string;
    /**
     * The element left the page and nothing has been found at the address since. The entry keeps what it tracks and takes the
     * unit that shows up at its address again; until then it is shown as waiting.
     */
    gone: boolean;
}

/** The marker in a stored list that says the entry tracks all members besides the listed values. */
const ALL = '*';

/** What is stored per address: the tracked values, `null` for all members, or both (`*` and the expressions). */
type Stored = Record<string, string[] | null>;

/** What is stored per pin: the path that leads to its object, and where that starts. */
interface StoredPin {
    id: string;
    origin: string;
    paths: string[];
    expression: string;
    address?: string;
}

export interface WatchModel {
    readonly entries: readonly WatchEntry[];
    readonly tracking: Tracking;
    readonly pins: Pins;
    readonly reader: PathReader;
    /** Entries on the same element are contiguous and share color and index. */
    colorOf( el: Element ): string;
    indexOf( el: Element ): number;
    setColor( el: Element, color: string ): void;
    isOutlined( el: Element ): boolean;
    toggleOutline( el: Element ): void;
    remove( id: string ): void;
    /** The rows an entry tracks: its members (all, or the selected ones) and its expressions. */
    rowsOf( entry: WatchEntry ): TrackedRow[];
    /** Whether the expression (relative to the unit, or starting at a pin) is tracked. */
    isExpressionTracked( unit: Unit | undefined, text: string ): boolean;
    /** Tracks the expression, or stops tracking it. Returns whether it is tracked now; `undefined` if it cannot be tracked. */
    toggleExpression( target: TrackTarget | undefined, text: string ): boolean | undefined;
    onChange( cb: () => void ): () => void;
    /** Pins the object a path leads to (see {@link Pins.pin}); the path is kept so that the pin is found again after a reload. */
    pinValue( target: TrackTarget | undefined, text: string, object: object, origin: string ): Pin;
    /**
     * Looks after the entries and pins against the page: entries whose element left are marked as waiting, and take the unit that
     * shows up at their address; pins whose object is gone are pointed at what their path leads to now. Returns whether anything changed.
     */
    reconcile(): boolean;
    /** Starts resolving the stored addresses; the first attempt comes after one interval, never synchronously. */
    startRestore(): void;
    dispose(): void;
}

export interface WatchModelOptions {
    storage: StorageAdapter;
    /** Distinguishes the pages of an app in the store. */
    path: string;
    palette?: readonly string[];
}

export function createWatchModel( ctx: DebugContext, options: WatchModelOptions ): WatchModel {
    const { adapter } = ctx;
    const palette = options.palette?.length ? options.palette : DEFAULT_TRACKED_COLORS;
    const storeKey = `tracked:${options.path}`;
    const pinsKey = `pins:${options.path}`;
    const pins = createPins();
    const reader = createPathReader( ctx, pins );
    const entries: WatchEntry[] = [];
    const elements = new Map<Element, { color: string; outlined: boolean }>();
    const listeners = new Set<() => void>();
    let counter = 0;
    /** Addresses stored by an earlier page load that were not resolved (yet); kept so that a quick reload does not lose them. */
    let pending: Stored = {};
    let pendingPins: StoredPin[] = [];
    let timer: ReturnType<typeof setInterval> | undefined;
    let restoreUntil = 0;

    const notify = (): void => listeners.forEach( cb => cb() );
    const changed = (): void => {
        save();
        notify();
    };
    pins.onChange( changed );

    function save(): void {
        const stored: Stored = { ...pending };
        for ( const entry of entries ) {
            if ( entry.address !== undefined ) {
                stored[entry.address] = entry.all ? ( entry.selected.size ? [ALL, ...entry.selected] : null ) : Array.from( entry.selected );
            }
        }
        if ( Object.keys( stored ).length ) {
            options.storage.set( storeKey, JSON.stringify( stored ) );
        } else {
            options.storage.remove( storeKey );
        }
        const storedPins: StoredPin[] = [...pendingPins, ...pins.list().filter( p => p.source ).map( p => ( {
            id: p.id, origin: p.origin, paths: Array.from( p.paths ), expression: p.source!.expression, address: p.source!.address
        } ) )];
        if ( storedPins.length ) {
            options.storage.set( pinsKey, JSON.stringify( storedPins ) );
        } else {
            options.storage.remove( pinsKey );
        }
    }

    const nextColor = (): string => {
        const used = new Set( Array.from( elements.values(), e => e.color ) );
        return palette.find( c => !used.has( c ) ) ?? palette[elements.size % palette.length];
    };

    const find = ( unit: Unit ): WatchEntry | undefined => entries.find( e => e.unit === unit );

    /** Adds an entry after the last one on the same element, so that entries of an element stay together. */
    const add = ( target: TrackTarget & { element: Element }, patch: Partial<WatchEntry> ): WatchEntry => {
        const description = adapter.units.describe( target.unit );
        const entry: WatchEntry = {
            id: `w${++counter}`, unit: target.unit, element: target.element, kind: description.kind, name: description.name,
            all: false, selected: new Set(), expanded: true, gone: false,
            address: adapter.addressing?.of( target.unit, target.element ),
            ...patch
        };
        if ( !elements.has( entry.element ) ) {
            elements.set( entry.element, { color: nextColor(), outlined: false } );
        }
        let at = entries.length;
        for ( let i = entries.length - 1; i >= 0; i-- ) {
            if ( entries[i].element === entry.element ) {
                at = i + 1;
                break;
            }
        }
        entries.splice( at, 0, entry );
        return entry;
    };

    /** Moves what is known about an element (color, outline, place in the numbering) to the one that replaces it. */
    const replaceElement = ( old: Element, next: Element ): void => {
        const info = elements.get( old );
        if ( !info || old === next || entries.some( e => e.element === old ) ) {
            return;
        }
        const copy = Array.from( elements );
        elements.clear();
        for ( const [el, value] of copy ) {
            if ( el === old ) {
                if ( !copy.some( ( [other] ) => other === next ) ) {
                    elements.set( next, value );
                }
            } else {
                elements.set( el, value );
            }
        }
    };

    const removeEntry = ( entry: WatchEntry ): void => {
        entries.splice( entries.indexOf( entry ), 1 );
        if ( !entries.some( e => e.element === entry.element ) ) {
            elements.delete( entry.element );
        }
    };

    const rowsOf = ( entry: WatchEntry ): TrackedRow[] => {
        const members = ctx.rowsOf( entry.unit );
        const known = new Set( members.map( r => selectionKey( r.category, r.name ) ) );
        const rows = entry.all ? members : members.filter( r => entry.selected.has( selectionKey( r.category, r.name ) ) );
        const expressions = Array.from( entry.selected ).filter( key => !known.has( key ) && !key.startsWith( '#' ) ).map( key => reader.rowFor( entry.unit, key ) );
        return [...rows, ...expressions];
    };

    /** Drops an entry that tracks nothing any more. */
    const dropIfEmpty = ( entry: WatchEntry ): void => {
        if ( !entry.all && !entry.selected.size ) {
            removeEntry( entry );
        }
    };

    const tracking: Tracking = {
        isWatched( unit, category, name ) {
            const entry = find( unit );
            if ( !entry ) {
                return false;
            }
            if ( category === undefined || name === undefined ) {
                return true;
            }
            return ( entry.all && category !== EXPRESSIONS ) || entry.selected.has( selectionKey( category, name ) );
        },
        toggleDirectiveWatch( target ) {
            const entry = find( target.unit );
            if ( entry ) {
                removeEntry( entry );
            } else if ( target.element ) {
                add( { ...target, element: target.element }, { all: true } );
            }
            changed();
        },
        toggleValueWatch( target, category, name ) {
            const key = selectionKey( category, name );
            const entry = find( target.unit );
            if ( !entry ) {
                if ( target.element ) {
                    add( { ...target, element: target.element }, { selected: new Set( [key] ) } );
                    changed();
                }
                return;
            }
            if ( entry.all && category !== EXPRESSIONS ) {
                // Converts to an explicit set: every member but this one, and the expressions that were tracked.
                const members = ctx.rowsOf( entry.unit ).map( r => selectionKey( r.category, r.name ) );
                entry.all = false;
                entry.selected = new Set( [...entry.selected, ...members] );
                entry.selected.delete( key );
            } else if ( !entry.selected.delete( key ) ) {
                entry.selected.add( key );
            }
            dropIfEmpty( entry );
            changed();
        }
    };

    /** The object a pin's source path leads to now, if it can be followed. */
    const followSource = ( expression: string, source: Pick<PinSource, 'address' | 'unit' | 'element'> | undefined ): { object: object; unit?: Unit; element?: Element } | undefined => {
        const parsed = reader.parse( expression );
        if ( !parsed.ok ) {
            return undefined;
        }
        let unit: Unit | undefined;
        let element: Element | undefined;
        if ( parsed.expression.base.kind === 'unit' ) {
            const found = source?.address ? adapter.addressing?.resolve( source.address ) : undefined;
            unit = found?.unit ?? unitOf( source );
            element = found ? found.element : source?.element?.deref();
            if ( !unit ) {
                return undefined;
            }
        }
        const result = reader.evaluate( unit, parsed.expression );
        return result.ok && typeof result.value === 'object' && result.value !== null ? { object: result.value, unit, element } : undefined;
    };

    const weak = ( value: unknown ): WeakRef<object> | undefined => typeof value === 'object' && value !== null ? new WeakRef( value ) : undefined;

    const sourceOf = ( target: TrackTarget | undefined, expression: string ): PinSource => ( {
        expression,
        address: target?.unit && target.element ? adapter.addressing?.of( target.unit, target.element ) : undefined,
        unit: weak( target?.unit ),
        element: target?.element ? new WeakRef( target.element ) : undefined
    } );

    const restorePin = ( stored: StoredPin ): boolean => {
        const followed = followSource( stored.expression, { address: stored.address } );
        if ( !followed ) {
            return false;
        }
        pins.restore( { ...stored, source: {
            expression: stored.expression, address: stored.address, unit: weak( followed.unit ),
            element: followed.element && new WeakRef( followed.element )
        } }, followed.object );
        return true;
    };

    const restoreStep = (): void => {
        const addresses = Object.keys( pending );
        let restored = false;
        for ( const address of addresses ) {
            const found = adapter.addressing?.resolve( address );
            if ( !found || find( found.unit ) ) {
                continue;
            }
            const names = pending[address];
            const all = names === null || names.includes( ALL );
            add( found, { all, selected: new Set( names?.filter( n => n !== ALL ) ), address } );
            delete pending[address];
            restored = true;
        }
        const waiting = pendingPins.length;
        pendingPins = pendingPins.filter( stored => !restorePin( stored ) );
        if ( restored || pendingPins.length !== waiting ) {
            changed();
        }
        if ( !( Object.keys( pending ).length + pendingPins.length ) || Date.now() > restoreUntil ) {
            stopRestore();
            // What did not match any more is dropped from the store.
            pending = {};
            pendingPins = [];
            save();
        }
    };

    function stopRestore(): void {
        if ( timer !== undefined ) {
            clearInterval( timer );
            timer = undefined;
        }
    }

    return {
        entries,
        tracking,
        pins,
        reader,
        colorOf: el => elements.get( el )?.color ?? palette[0],
        indexOf: el => Array.from( elements.keys() ).indexOf( el ) + 1,
        setColor( el, color ) {
            const info = elements.get( el );
            if ( info ) {
                info.color = color;
                notify();
            }
        },
        isOutlined: el => !!elements.get( el )?.outlined,
        toggleOutline( el ) {
            const info = elements.get( el );
            if ( info ) {
                info.outlined = !info.outlined;
                notify();
            }
        },
        remove( id ) {
            const entry = entries.find( e => e.id === id );
            if ( entry ) {
                removeEntry( entry );
                changed();
            }
        },
        rowsOf,
        isExpressionTracked( unit, text ) {
            const canonical = reader.canonical( text );
            const result = reader.parse( text );
            if ( canonical === undefined || !result.ok ) {
                return false;
            }
            if ( result.expression.base.kind === 'pin' ) {
                return !!pins.get( result.expression.base.id )?.paths.has( canonical );
            }
            return !!unit && !!find( unit )?.selected.has( canonical );
        },
        toggleExpression( target, text ) {
            const result = reader.parse( text );
            const canonical = reader.canonical( text );
            if ( !result.ok || canonical === undefined ) {
                return undefined;
            }
            if ( result.expression.base.kind === 'pin' ) {
                const pin = pins.get( result.expression.base.id );
                if ( !pin ) {
                    return undefined;
                }
                const on = !pin.paths.delete( canonical );
                if ( on && result.expression.segments.length ) {
                    pin.paths.add( canonical );
                }
                changed();
                return on && result.expression.segments.length > 0;
            }
            if ( !target?.element ) {
                return undefined;
            }
            const entry = find( target.unit ) ?? add( { ...target, element: target.element }, {} );
            const on = !entry.selected.delete( canonical );
            if ( on ) {
                entry.selected.add( canonical );
            }
            dropIfEmpty( entry );
            changed();
            return on;
        },
        onChange: cb => {
            listeners.add( cb );
            return () => void listeners.delete( cb );
        },
        pinValue( target, text, object, origin ) {
            return pins.pin( object, origin, sourceOf( target, reader.canonical( text ) ?? text ) );
        },
        reconcile() {
            let any = false;
            for ( const entry of entries ) {
                const gone = !entry.element.isConnected;
                if ( gone && entry.address && adapter.addressing ) {
                    const found = adapter.addressing.resolve( entry.address );
                    if ( found?.element.isConnected && !entries.some( e => e !== entry && e.unit === found.unit ) ) {
                        const old = entry.element;
                        const description = adapter.units.describe( found.unit );
                        entry.unit = found.unit;
                        entry.element = found.element;
                        entry.kind = description.kind;
                        entry.name = description.name;
                        entry.gone = false;
                        replaceElement( old, found.element );
                        any = true;
                        continue;
                    }
                }
                if ( entry.gone !== gone ) {
                    entry.gone = gone;
                    any = true;
                }
            }
            for ( const pin of pins.list() ) {
                const followed = pin.source && !pins.resolve( pin.id ) ? followSource( pin.source.expression, pin.source ) : undefined;
                if ( followed ) {
                    pins.rebind( pin.id, followed.object );
                    any = true;
                }
            }
            return any;
        },
        startRestore() {
            if ( !adapter.addressing ) {
                return;
            }
            try {
                pending = JSON.parse( options.storage.get( storeKey ) ?? '{}' ) as Stored;
            } catch {
                pending = {};
            }
            try {
                pendingPins = ( JSON.parse( options.storage.get( pinsKey ) ?? '[]' ) as StoredPin[] ).sort( ( a, b ) => Number( a.id.slice( 1 ) ) - Number( b.id.slice( 1 ) ) );
            } catch {
                pendingPins = [];
            }
            if ( !Object.keys( pending ).length && !pendingPins.length ) {
                return;
            }
            restoreUntil = Date.now() + RESTORE_FOR_MS;
            // No synchronous first attempt: overlays are usually enabled while the app is still being constructed.
            timer = ctx.runOutside( () => setInterval( restoreStep, RESTORE_EVERY_MS ) );
        },
        dispose() {
            stopRestore();
            listeners.clear();
        }
    };
}
