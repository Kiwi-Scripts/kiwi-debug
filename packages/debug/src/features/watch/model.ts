import type { StorageAdapter } from '@kiwi-js/panels';

import type { Unit } from '../../adapter/types';
import type { Tracking, TrackTarget } from '../../core/services';
import type { DebugContext } from '../../core/types';
import type { TrackedRow } from '../../core/units';

export const DEFAULT_TRACKED_COLORS = ['#ff9800', '#4fc3f7', '#7cc05b', '#d66ad6', '#e5c07b', '#f44747', '#9cdcfe', '#c586c0'];

/** How long a restore keeps trying, and how often. */
export const RESTORE_FOR_MS = 30_000;
export const RESTORE_EVERY_MS = 500;

const valueKey = ( category: string, name: string ): string => `${category}\0${name}`;

export interface WatchEntry {
    id: string;
    unit: Unit;
    element: Element;
    kind: string;
    name: string;
    /** Tracks every value of the unit, including properties that appear later. */
    all: boolean;
    /** `category\0name` of the tracked values when `all` is false. */
    selected: Set<string>;
    expanded: boolean;
    address?: string;
}

/** What is stored per address: the tracked value keys, or `null` for everything. */
type Stored = Record<string, string[] | null>;

export interface WatchModel {
    readonly entries: readonly WatchEntry[];
    readonly tracking: Tracking;
    /** Entries on the same element are contiguous and share color and index. */
    colorOf( el: Element ): string;
    indexOf( el: Element ): number;
    setColor( el: Element, color: string ): void;
    isOutlined( el: Element ): boolean;
    toggleOutline( el: Element ): void;
    remove( id: string ): void;
    /** The rows an entry tracks (all of them, or the selected ones). */
    rowsOf( entry: WatchEntry ): TrackedRow[];
    onChange( cb: () => void ): () => void;
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
    const entries: WatchEntry[] = [];
    const elements = new Map<Element, { color: string; outlined: boolean }>();
    const listeners = new Set<() => void>();
    let counter = 0;
    /** Addresses stored by an earlier page load that were not resolved (yet); kept so that a quick reload does not lose them. */
    let pending: Stored = {};
    let timer: ReturnType<typeof setInterval> | undefined;
    let restoreUntil = 0;

    const changed = (): void => {
        save();
        listeners.forEach( cb => cb() );
    };

    function save(): void {
        const stored: Stored = { ...pending };
        for ( const entry of entries ) {
            if ( entry.address !== undefined ) {
                stored[entry.address] = entry.all ? null : Array.from( entry.selected );
            }
        }
        if ( Object.keys( stored ).length ) {
            options.storage.set( storeKey, JSON.stringify( stored ) );
        } else {
            options.storage.remove( storeKey );
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
            all: false, selected: new Set(), expanded: true,
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

    const removeEntry = ( entry: WatchEntry ): void => {
        entries.splice( entries.indexOf( entry ), 1 );
        if ( !entries.some( e => e.element === entry.element ) ) {
            elements.delete( entry.element );
        }
    };

    const rowsOf = ( entry: WatchEntry ): TrackedRow[] => {
        const rows = ctx.rowsOf( entry.unit );
        return entry.all ? rows : rows.filter( r => entry.selected.has( valueKey( r.category, r.name ) ) );
    };

    const tracking: Tracking = {
        isWatched( unit, category, name ) {
            const entry = find( unit );
            if ( !entry ) {
                return false;
            }
            return category === undefined || name === undefined || entry.all || entry.selected.has( valueKey( category, name ) );
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
            const key = valueKey( category, name );
            const entry = find( target.unit );
            if ( !entry ) {
                if ( target.element ) {
                    add( { ...target, element: target.element }, { selected: new Set( [key] ) } );
                    changed();
                }
                return;
            }
            if ( entry.all ) {
                // Converts to an explicit set of everything but this value.
                entry.all = false;
                entry.selected = new Set( ctx.rowsOf( entry.unit ).map( r => valueKey( r.category, r.name ) ) );
                entry.selected.delete( key );
            } else if ( !entry.selected.delete( key ) ) {
                entry.selected.add( key );
            }
            if ( !entry.all && !entry.selected.size ) {
                removeEntry( entry );
            }
            changed();
        }
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
            add( found, names === null ? { all: true, address } : { selected: new Set( names ), address } );
            delete pending[address];
            restored = true;
        }
        if ( restored ) {
            changed();
        }
        if ( !Object.keys( pending ).length || Date.now() > restoreUntil ) {
            stopRestore();
            // What did not match any more is dropped from the store.
            pending = {};
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
        colorOf: el => elements.get( el )?.color ?? palette[0],
        indexOf: el => Array.from( elements.keys() ).indexOf( el ) + 1,
        setColor( el, color ) {
            const info = elements.get( el );
            if ( info ) {
                info.color = color;
                listeners.forEach( cb => cb() );
            }
        },
        isOutlined: el => !!elements.get( el )?.outlined,
        toggleOutline( el ) {
            const info = elements.get( el );
            if ( info ) {
                info.outlined = !info.outlined;
                listeners.forEach( cb => cb() );
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
        onChange: cb => {
            listeners.add( cb );
            return () => void listeners.delete( cb );
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
            if ( !Object.keys( pending ).length ) {
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
