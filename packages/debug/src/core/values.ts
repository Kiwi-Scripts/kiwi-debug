import type { ReactivityApi } from '../adapter/types';
import type { Segment } from './expressions';
import { preview } from './format';
import { safe } from './safe';

/** How many children a node lists before "N more". */
export const TREE_PAGE = 50;

export type ValueKind = 'primitive' | 'object' | 'array' | 'map' | 'set' | 'element' | 'function' | 'reactive' | 'getter' | 'circular';

/** One node of an inspected value. Children are made when asked for, so a big structure costs nothing until it is opened. */
export interface ValueNode {
    /** The label in its parent: a property name, an index, `[key]` for a map entry. */
    key: string;
    /** How to reach it from its parent, if that can be said as an expression step. */
    segment?: Segment;
    kind: ValueKind;
    /** `preview()` of the value; for a getter `(getter)`, which has not been run. */
    text: string;
    /** Whether it has children to show. */
    expandable: boolean;
    value: unknown;
    /** The first `limit` children, and how many there are. */
    children( limit?: number ): { nodes: ValueNode[]; total: number };
}

type Reactivity = Pick<ReactivityApi, 'nodeOf'> | undefined;

const NO_CHILDREN = () => ( { nodes: [] as ValueNode[], total: 0 } );

const isObjectLike = ( value: unknown ): value is object => ( typeof value === 'object' && value !== null ) || typeof value === 'function';

/** Strips a reactive node down to the value it holds, if it holds one. */
function unwrap( value: unknown, reactivity: Reactivity ): { inner: unknown; reactive: boolean } {
    const node = isObjectLike( value ) ? safe( () => reactivity?.nodeOf( value ) ) : undefined;
    if ( node?.holdsValue ) {
        return { inner: safe( () => node.peek() ), reactive: true };
    }
    return { inner: value, reactive: !!node };
}

/**
 * Describes a value as a tree. Only own enumerable properties of objects are listed, accessors are listed but never run, and a value
 * that is its own ancestor is marked instead of followed.
 */
export function describeValue(
    value: unknown, reactivity?: Reactivity, key = '', segment?: Segment, ancestors: readonly unknown[] = []
): ValueNode {
    const { inner, reactive } = unwrap( value, reactivity );
    const text = preview( value, reactivity );

    const leaf = ( kind: ValueKind ): ValueNode => ( { key, segment, kind, text, expandable: false, value, children: NO_CHILDREN } );

    if ( !isObjectLike( inner ) ) {
        return leaf( reactive ? 'reactive' : 'primitive' );
    }
    if ( ancestors.includes( inner ) ) {
        return { ...leaf( 'circular' ), text: `${text} [circular]` };
    }
    if ( typeof inner === 'function' ) {
        return leaf( 'function' );
    }
    if ( typeof Element !== 'undefined' && inner instanceof Element ) {
        return leaf( 'element' );
    }
    if ( inner instanceof Date || inner instanceof RegExp || inner instanceof Error || inner instanceof WeakMap || inner instanceof WeakSet ) {
        return leaf( 'object' );
    }

    const lineage = [...ancestors, inner];
    const child = ( v: unknown, k: string, s?: Segment ): ValueNode => describeValue( v, reactivity, k, s, lineage );
    const make = ( kind: ValueKind, total: number, at: ( limit: number ) => ValueNode[] ): ValueNode => ( {
        key, segment, kind: reactive ? 'reactive' : kind, text, value, expandable: total > 0,
        children: ( limit = TREE_PAGE ) => ( { nodes: at( limit ), total } )
    } );

    if ( Array.isArray( inner ) ) {
        return make( 'array', inner.length, limit => inner.slice( 0, limit ).map( ( v, i ) => child( v, String( i ), { kind: 'index', key: i, optional: false } ) ) );
    }
    if ( inner instanceof Map ) {
        return make( 'map', inner.size, limit => Array.from( inner ).slice( 0, limit ).map( ( [k, v] ) => {
            const simple = typeof k === 'string' || typeof k === 'number';
            return child( v, `[${preview( k, reactivity )}]`, simple ? { kind: 'index', key: k, optional: false } : undefined );
        } ) );
    }
    if ( inner instanceof Set ) {
        return make( 'set', inner.size, limit => Array.from( inner ).slice( 0, limit ).map( ( v, i ) => child( v, String( i ), { kind: 'index', key: i, optional: false } ) ) );
    }

    const keys = safe( () => Object.keys( inner ) ) ?? [];
    return make( 'object', keys.length, limit => keys.slice( 0, limit ).map( k => {
        const segmentOf: Segment = { kind: 'prop', name: k, optional: false };
        if ( safe( () => Object.getOwnPropertyDescriptor( inner, k )?.get ) ) {
            return { key: k, segment: segmentOf, kind: 'getter' as const, text: '(getter)', expandable: false, value: undefined, children: NO_CHILDREN };
        }
        try {
            return child( ( inner as Record<string, unknown> )[k], k, segmentOf );
        } catch {
            return { key: k, segment: segmentOf, kind: 'primitive' as const, text: '?', expandable: false, value: undefined, children: NO_CHILDREN };
        }
    } ) );
}
