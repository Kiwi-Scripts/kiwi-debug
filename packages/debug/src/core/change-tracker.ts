import { span } from '@kiwi-js/panels';

import type { ReactivityApi } from '../adapter/types';
import { isLoggable, logGroup } from './console';
import { copyValue, preview, type Copy } from './format';
import { safe } from './safe';

/** What is known about one value at one refresh. */
export interface Reading {
    /** `preview()` of the value. */
    text: string;
    /** `ReactiveNode.version`, if the value is reactive. */
    version?: number;
    /** A bounded copy, only for object values. */
    copy?: Copy;
    /** A fingerprint of the copy, only when values are shown in detail: changes inside an object show up in it. */
    deep?: string;
}

/** A value to follow. `scope` is the unit name (inspector) or the entry id (watch). */
export interface TrackedRef {
    scope: string;
    category: string;
    name: string;
    /** May throw; the reading is then `?`. */
    read(): unknown;
}

export interface ChangeNote {
    kind: 'text' | 'rewritten' | 'nested';
    /** What the row shows after `was`: the old text, or `value written: v1 → v2`. */
    was: string;
    /** The previous copy of an object value, logged when the row is clicked. */
    previous?: Copy;
}

export type Snapshot = Map<string, Reading>;

export const rowKey = ( scope: string, category: string, name: string ): string => `${scope}\0${category}\0${name}`;
export const groupKey = ( scope: string, category: string ): string => `${scope}:${category}`;

/** The group a row key belongs to. */
function groupOfRow( key: string ): string {
    const [scope, category] = key.split( '\0' );
    return groupKey( scope, category );
}

/**
 * Detects changes of values between refreshes: a changed text, or a reactive value that was written again with an identical text.
 * See the spec, 5.2.
 */
export interface ChangeTracker {
    snapshot( refs: Iterable<TrackedRef> ): Snapshot;
    /** Text and version of every reading, without the copies: a panel re-renders only when this changed. */
    signatureOf( snapshot: Snapshot ): string;
    /**
     * Compares with the baseline: rows in both are recorded as changed. A change in a group that is not visible (`!isSeen`) counts
     * as unseen.
     */
    diff( snapshot: Snapshot, isSeen: ( groupKey: string ) => boolean ): void;
    /** Makes the snapshot the baseline and ends the flashing. */
    commit( snapshot: Snapshot ): void;
    readonly changes: ReadonlyMap<string, ChangeNote>;
    isFlashing( rowKey: string ): boolean;
    /** Marks the row element: key, the "changed" class, the category accent, the flash and the `(was …)` label. */
    markRow( el: HTMLElement, key: string ): void;
    /** Changed values that were not seen yet. */
    unseenCount(): number;
    unseenIn( groupKey: string ): number;
    /** The group was seen (e.g. expanded). */
    acknowledge( groupKey: string ): void;
    /** The change of a row was taken note of (e.g. by hovering it). */
    dismiss( rowKey: string ): void;
    clear(): void;
    /** Drops everything of one scope, e.g. when the unit is no longer shown. */
    forget( scope: string ): void;
}

export interface ChangeTrackerOptions {
    /** Also notice changes inside objects and arrays, not only in their one-line text. */
    detail?: boolean;
}

/** A short fingerprint of a bounded copy; equal copies give equal fingerprints. */
function fingerprint( copy: Copy ): string {
    const text = JSON.stringify( copy ) ?? '';
    let hash = 5381;
    for ( let i = 0; i < text.length; i++ ) {
        hash = ( hash * 33 ^ text.charCodeAt( i ) ) | 0;
    }
    return `${text.length}:${hash}`;
}

export function createChangeTracker( reactivity?: Pick<ReactivityApi, 'nodeOf'>, options: ChangeTrackerOptions = {} ): ChangeTracker {
    let baseline: Snapshot = new Map();
    const changes = new Map<string, ChangeNote>();
    const flashing = new Set<string>();
    const unseen = new Map<string, Set<string>>();
    /** Copies of reactive values, kept per node and valid for one version. */
    const copies = new WeakMap<object, { version: number; copy: Copy }>();

    const isObject = ( value: unknown ): value is object => typeof value === 'object' && value !== null;

    const reading = ( value: unknown ): Reading => {
        const node = isObject( value ) || typeof value === 'function' ? safe( () => reactivity?.nodeOf( value ) ) : undefined;
        const out: Reading = { text: preview( value, reactivity ), version: node?.version };
        const inner = node ? ( node.holdsValue ? safe( () => node.peek() ) : undefined ) : value;
        if ( isObject( inner ) ) {
            const cached = node && copies.get( node );
            if ( node && cached && cached.version === node.version ) {
                out.copy = cached.copy;
            } else {
                out.copy = copyValue( inner );
                if ( node ) {
                    copies.set( node, { version: node.version, copy: out.copy } );
                }
            }
            if ( options.detail ) {
                out.deep = fingerprint( out.copy );
            }
        }
        return out;
    };

    const forgetUnseen = ( key: string ): void => {
        const group = groupOfRow( key );
        const rows = unseen.get( group );
        rows?.delete( key );
        if ( rows && !rows.size ) {
            unseen.delete( group );
        }
    };

    return {
        snapshot( refs ) {
            const snapshot: Snapshot = new Map();
            for ( const ref of refs ) {
                let value: unknown;
                let failed = false;
                try {
                    value = ref.read();
                } catch {
                    failed = true;
                }
                snapshot.set( rowKey( ref.scope, ref.category, ref.name ), failed ? { text: '?' } : reading( value ) );
            }
            return snapshot;
        },
        signatureOf: snapshot => Array.from( snapshot, ( [key, r] ) => `${key}\u0001${r.text}\u0001${r.version ?? ''}${r.deep ?? ''}` ).join( '\u0002' ),
        diff( snapshot, isSeen ) {
            for ( const [key, now] of snapshot ) {
                const before = baseline.get( key );
                if ( !before ) {
                    continue;
                }
                const textChanged = before.text !== now.text;
                const rewritten = !textChanged && before.version !== undefined && now.version !== undefined && before.version !== now.version;
                const nested = !textChanged && !rewritten && before.deep !== undefined && before.deep !== now.deep;
                if ( !textChanged && !rewritten && !nested ) {
                    continue;
                }
                changes.set( key, {
                    kind: textChanged ? 'text' : rewritten ? 'rewritten' : 'nested',
                    was: textChanged ? before.text : rewritten ? `value written: v${before.version} → v${now.version}` : 'a nested value changed',
                    previous: before.copy
                } );
                flashing.add( key );
                const group = groupOfRow( key );
                if ( !isSeen( group ) ) {
                    unseen.set( group, ( unseen.get( group ) ?? new Set() ).add( key ) );
                }
            }
        },
        commit( snapshot ) {
            baseline = snapshot;
            flashing.clear();
        },
        changes,
        isFlashing: key => flashing.has( key ),
        markRow( el, key ) {
            el.dataset.rowKey = key;
            el.dataset.category = key.split( '\0' )[1];
            const note = changes.get( key );
            el.classList.toggle( 'kd-changed', !!note );
            el.classList.toggle( 'kd-flash', flashing.has( key ) );
            if ( note ) {
                const label = span( 'kp-muted kd-was', `(was ${note.was})`, 'Click to log the previous value' );
                if ( isLoggable( note.previous ) ) {
                    label.classList.add( 'kd-log' );
                    label.onclick = () => logGroup( 'Previous value', [['was', note.previous]] );
                } else {
                    label.title = '';
                }
                el.append( ' ', label );
            }
        },
        unseenCount: () => Array.from( unseen.values() ).reduce( ( sum, rows ) => sum + rows.size, 0 ),
        unseenIn: group => unseen.get( group )?.size ?? 0,
        acknowledge: group => void unseen.delete( group ),
        dismiss( key ) {
            changes.delete( key );
            flashing.delete( key );
            forgetUnseen( key );
        },
        clear() {
            baseline = new Map();
            changes.clear();
            flashing.clear();
            unseen.clear();
        },
        forget( scope ) {
            const prefix = `${scope}\0`;
            for ( const key of Array.from( baseline.keys() ).filter( k => k.startsWith( prefix ) ) ) {
                baseline.delete( key );
            }
            for ( const key of Array.from( changes.keys() ).filter( k => k.startsWith( prefix ) ) ) {
                changes.delete( key );
                flashing.delete( key );
                forgetUnseen( key );
            }
        }
    };
}
