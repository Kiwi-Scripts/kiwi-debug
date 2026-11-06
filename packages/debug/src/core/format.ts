import { describeElement } from '@kiwi-js/dom';

import type { ReactivityApi } from '../adapter/types';

export const PREVIEW_LIMIT = 60;
export const COPY_MAX_CHARS = 20_000;
export const COPY_MAX_OBJECTS = 2_000;

const ELLIPSIS = '…';

const cut = ( text: string, max: number ): string => text.length > max ? text.slice( 0, max ) + ELLIPSIS : text;

function constructorName( value: object ): string | undefined {
    const proto = Object.getPrototypeOf( value );
    return proto === null || proto === Object.prototype ? undefined : proto.constructor?.name || undefined;
}

type NodeOf = Pick<ReactivityApi, 'nodeOf'> | undefined;

/**
 * A one-line description of any value, for rows and logs: strings JSON-quoted and cut at 60 characters, `ƒ name`, `Array(n)`,
 * `<tag#id.cls>`, a class name or `{…}`. A reactive value (when `reactivity` is given) shows as `signal(<its current value>)`,
 * which is read with `peek()`, so only call this where the value is displayed. A value that throws on access shows as `?`.
 */
export function preview( value: unknown, reactivity?: NodeOf, depth = 0 ): string {
    try {
        const node = typeof value === 'object' || typeof value === 'function' ? reactivity?.nodeOf( value ) : undefined;
        if ( node ) {
            return node.holdsValue && depth < 2 ? `${node.kind}(${preview( node.peek(), reactivity, depth + 1 )})` : node.kind;
        }
        switch ( typeof value ) {
            case 'string': return cut( JSON.stringify( value ), PREVIEW_LIMIT );
            case 'function': return `ƒ ${value.name || '(anonymous)'}`;
            case 'bigint': return `${value}n`;
            case 'symbol': return value.toString();
            case 'object': break;
            default: return String( value );
        }
        if ( value === null ) {
            return 'null';
        }
        if ( Array.isArray( value ) ) {
            return `Array(${value.length})`;
        }
        if ( typeof Element !== 'undefined' && value instanceof Element ) {
            return `<${describeElement( value )}>`;
        }
        if ( value instanceof Map || value instanceof Set ) {
            return `${value instanceof Map ? 'Map' : 'Set'}(${value.size})`;
        }
        if ( value instanceof Date ) {
            return Number.isNaN( value.getTime() ) ? 'Invalid Date' : value.toISOString();
        }
        return constructorName( value ) ?? '{…}';
    } catch {
        return '?';
    }
}

/** A bounded copy of a value that can be kept and logged later: see {@link copyValue}. */
export type Copy = unknown;

/**
 * A bounded, JSON-safe copy of a value: at most 2 000 objects, cycles and repeated objects replaced by a note, and special encodings
 * for bigint, function, symbol, Element, Map and Set. What a row remembers as its "previous value".
 */
export function copyValue( value: unknown ): Copy {
    let budget = COPY_MAX_OBJECTS;
    const ancestors = new Set<object>();
    const seen = new WeakSet<object>();

    const walk = ( input: unknown ): Copy => {
        switch ( typeof input ) {
            case 'bigint': return `${input}n`;
            case 'function': return `ƒ ${input.name || '(anonymous)'}`;
            case 'symbol': return input.toString();
            case 'undefined': return '[undefined]';
            case 'object': break;
            default: return typeof input === 'number' && !Number.isFinite( input ) ? String( input ) : input;
        }
        if ( input === null ) {
            return null;
        }
        if ( ancestors.has( input ) ) {
            return '[circular]';
        }
        if ( seen.has( input ) ) {
            return '[repeated]';
        }
        if ( typeof Element !== 'undefined' && input instanceof Element ) {
            return `<${describeElement( input )}>`;
        }
        if ( input instanceof Date ) {
            return Number.isNaN( input.getTime() ) ? 'Invalid Date' : input.toISOString();
        }
        if ( --budget < 0 ) {
            return '[…]';
        }
        seen.add( input );
        ancestors.add( input );
        try {
            if ( input instanceof Map ) {
                return { $map: Array.from( input, ( [k, v] ) => [walk( k ), walk( v )] ) };
            }
            if ( input instanceof Set ) {
                return { $set: Array.from( input, walk ) };
            }
            if ( Array.isArray( input ) ) {
                return input.map( walk );
            }
            const out: Record<string, Copy> = {};
            const name = constructorName( input );
            if ( name ) {
                out.$class = name;
            }
            for ( const key of Object.keys( input ) ) {
                try {
                    out[key] = walk( ( input as Record<string, unknown> )[key] );
                } catch {
                    out[key] = '?';
                }
            }
            return out;
        } finally {
            ancestors.delete( input );
        }
    };
    try {
        return walk( value );
    } catch {
        return '?';
    }
}

/** {@link copyValue} as JSON text, at most 20 000 characters. */
export function stringifyCopy( value: unknown ): string {
    const text = JSON.stringify( copyValue( value ), null, 2 ) ?? 'undefined';
    return text.length > COPY_MAX_CHARS ? text.slice( 0, COPY_MAX_CHARS ) + `${ELLIPSIS} (cut at ${COPY_MAX_CHARS} characters)` : text;
}
