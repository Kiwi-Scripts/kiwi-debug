import type { ReactivityApi } from '../adapter/types';
import { safe } from './safe';

/**
 * Expressions: a small, safe subset of TypeScript property access, used to look into nested values.
 *
 *     items[0].name        a.b?.c        config['key with spaces']        $1.users[2]
 *
 * Calls, operators and assignments are not part of it, so evaluating one never runs more code than reading properties does.
 * The first name is a member of the unit (or, after a `$n`, a pinned object).
 */

export const MAX_SEGMENTS = 20;
export const MAX_EXPRESSION_LENGTH = 500;

export type Segment =
    | { kind: 'prop'; name: string; optional: boolean }
    | { kind: 'index'; key: string | number; optional: boolean };

/** Where a path starts: the unit it is relative to, or a pinned object. */
export type Base = { kind: 'unit' } | { kind: 'pin'; id: string };

export interface Expression {
    base: Base;
    segments: Segment[];
}

export type ParseResult = { ok: true; expression: Expression } | { ok: false; error: string; at: number };

const IDENT_START = /[\p{L}_$]/u;
const IDENT_PART = /[\p{L}\p{N}_$]/u;
const IDENT = /^[\p{L}_$][\p{L}\p{N}_$]*$/u;

class Reader {
    at = 0;

    constructor( readonly text: string ) {}

    skipSpace(): void {
        while ( /\s/.test( this.text[this.at] ?? '' ) ) {
            this.at++;
        }
    }

    peek = (): string => this.text[this.at] ?? '';

    done = (): boolean => this.at >= this.text.length;

    identifier(): string | undefined {
        if ( !IDENT_START.test( this.peek() ) ) {
            return undefined;
        }
        const start = this.at;
        while ( !this.done() && IDENT_PART.test( this.peek() ) ) {
            this.at++;
        }
        return this.text.slice( start, this.at );
    }
}

const fail = ( error: string, at: number ): ParseResult => ( { ok: false, error, at } );

/** Parses an expression; the result says where it went wrong, if it did. */
export function parseExpression( text: string ): ParseResult {
    if ( text.length > MAX_EXPRESSION_LENGTH ) {
        return fail( `longer than ${MAX_EXPRESSION_LENGTH} characters`, MAX_EXPRESSION_LENGTH );
    }
    const r = new Reader( text );
    r.skipSpace();
    let base: Base = { kind: 'unit' };
    const segments: Segment[] = [];

    if ( r.peek() === '$' && /\d/.test( text[r.at + 1] ?? '' ) ) {
        const start = ++r.at;
        while ( /\d/.test( r.peek() ) ) {
            r.at++;
        }
        base = { kind: 'pin', id: `$${text.slice( start, r.at )}` };
    } else {
        const name = r.identifier();
        if ( name === undefined ) {
            return fail( r.done() ? 'empty expression' : 'expected a property name', r.at );
        }
        segments.push( { kind: 'prop', name, optional: false } );
    }

    for ( ;; ) {
        r.skipSpace();
        if ( r.done() ) {
            break;
        }
        if ( segments.length >= MAX_SEGMENTS ) {
            return fail( `more than ${MAX_SEGMENTS} steps`, r.at );
        }
        let optional = false;
        if ( r.peek() === '?' && text[r.at + 1] === '.' ) {
            optional = true;
            r.at += 2;
        } else if ( r.peek() === '.' ) {
            r.at++;
        } else if ( r.peek() !== '[' ) {
            return fail( r.peek() === '(' ? 'calls are not allowed' : `unexpected "${r.peek()}"`, r.at );
        }
        r.skipSpace();
        if ( r.peek() === '[' ) {
            r.at++;
            r.skipSpace();
            const key = readKey( r );
            if ( key === undefined ) {
                return fail( 'expected a number or a quoted string in brackets', r.at );
            }
            r.skipSpace();
            if ( r.peek() !== ']' ) {
                return fail( 'expected "]"', r.at );
            }
            r.at++;
            segments.push( { kind: 'index', key, optional } );
        } else {
            const name = r.identifier();
            if ( name === undefined ) {
                return fail( 'expected a property name', r.at );
            }
            segments.push( { kind: 'prop', name, optional } );
        }
    }
    return { ok: true, expression: { base, segments } };
}

function readKey( r: Reader ): string | number | undefined {
    const quote = r.peek();
    if ( quote === '"' || quote === '\'' ) {
        r.at++;
        let out = '';
        while ( !r.done() && r.peek() !== quote ) {
            if ( r.peek() === '\\' ) {
                r.at++;
            }
            out += r.peek();
            r.at++;
        }
        if ( r.done() ) {
            return undefined;
        }
        r.at++;
        return out;
    }
    const start = r.at;
    while ( /\d/.test( r.peek() ) ) {
        r.at++;
    }
    return r.at > start ? Number( r.text.slice( start, r.at ) ) : undefined;
}

const quote = ( key: string ): string => `'${key.replace( /[\\']/g, '\\$&' )}'`;

/**
 * The canonical text of segments. With `bare`, a first property is written without a dot (`items[0].name`), as after a unit;
 * otherwise every step stands on its own (`.items[0].name`), as after a pin.
 */
export function formatSegments( segments: readonly Segment[], bare = true ): string {
    return segments.map( ( seg, i ) => {
        const chain = seg.optional ? '?.' : '';
        if ( seg.kind === 'index' ) {
            return `${chain}[${typeof seg.key === 'number' ? seg.key : quote( seg.key )}]`;
        }
        if ( !IDENT.test( seg.name ) ) {
            return `${chain}[${quote( seg.name )}]`;
        }
        return bare && i === 0 && !seg.optional ? seg.name : `${seg.optional ? '?.' : '.'}${seg.name}`;
    } ).join( '' );
}

/** The canonical text of an expression; parsing it again gives the same expression. */
export function formatExpression( expression: Expression ): string {
    return expression.base.kind === 'pin'
        ? `${expression.base.id}${formatSegments( expression.segments, false )}`
        : formatSegments( expression.segments );
}

export type Failure = 'nullish' | 'throws';

export type Evaluation =
    | { ok: true; value: unknown }
    | { ok: false; at: number; reason: Failure; message: string };

export interface EvaluateOptions {
    /** Reactive values on the way are read with `peek()`, so that a path can pass through a signal. */
    reactivity?: Pick<ReactivityApi, 'nodeOf'>;
}

const describeUpTo = ( segments: readonly Segment[], count: number ): string => formatSegments( segments.slice( 0, count ) ) || 'the base';

function step( current: unknown, segment: Segment ): unknown {
    if ( segment.kind === 'index' ) {
        if ( current instanceof Map ) {
            return current.get( segment.key );
        }
        if ( current instanceof Set ) {
            return typeof segment.key === 'number' ? Array.from( current )[segment.key] : undefined;
        }
        return ( current as Record<string | number, unknown> )[segment.key];
    }
    return ( current as Record<string, unknown> )[segment.name];
}

/** Follows the segments from `root`. A missing final property is `undefined`; a nullish receiver on the way is a failure. */
export function evaluatePath( root: unknown, segments: readonly Segment[], options: EvaluateOptions = {} ): Evaluation {
    let current = root;
    for ( let i = 0; i < segments.length; i++ ) {
        // A signal on the way: the path goes on with its value.
        for ( let unwrapped = 0; unwrapped < 3; unwrapped++ ) {
            const node = typeof current === 'object' || typeof current === 'function' ? safe( () => options.reactivity?.nodeOf( current ) ) : undefined;
            if ( !node?.holdsValue ) {
                break;
            }
            try {
                current = node.peek();
            } catch ( error ) {
                return { ok: false, at: i, reason: 'throws', message: `${describeUpTo( segments, i )} threw: ${String( error )}` };
            }
        }
        if ( current === null || current === undefined ) {
            if ( segments[i].optional ) {
                return { ok: true, value: undefined };
            }
            return { ok: false, at: i, reason: 'nullish', message: `${describeUpTo( segments, i )} is ${current}` };
        }
        try {
            current = step( current, segments[i] );
        } catch ( error ) {
            return { ok: false, at: i, reason: 'throws', message: `${describeUpTo( segments, i + 1 )} threw: ${String( error )}` };
        }
    }
    return { ok: true, value: current };
}
