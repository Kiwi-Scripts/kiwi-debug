import type { Unit } from '../../adapter/types';
import {
    evaluatePath, formatExpression, parseExpression, Unreachable, type Evaluation, type Expression, type ParseResult
} from '../../core/expressions';
import { safe } from '../../core/safe';
import type { DebugContext } from '../../core/types';
import type { TrackedRow } from '../../core/units';
import type { Pins } from './pins';

/** The category of rows that come from an expression rather than from a member of the unit. */
export const EXPRESSIONS = 'expressions';

export interface PathReader {
    parse( text: string ): ParseResult;
    /** The canonical text of an expression, or `undefined` if it does not parse. */
    canonical( text: string ): string | undefined;
    /** Follows the expression from the unit (for unit-based ones) or from its pin. */
    evaluate( unit: Unit | undefined, expression: Expression ): Evaluation;
    /** What a tracked expression reads: its value, or an `Unreachable` that says why not. Never throws. */
    read( unit: Unit | undefined, text: string ): unknown;
    /** A row for a tracked expression. */
    rowFor( unit: Unit, text: string ): TrackedRow;
}

/**
 * Evaluates expressions for the watch list. A path from a unit starts at its instance (`units.instance`) and falls back to the
 * unit's members, which also answers to their template-facing aliases. A path from a pin starts at the pinned object.
 */
export function createPathReader( ctx: DebugContext, pins: Pins ): PathReader {
    const { adapter } = ctx;
    const parsed = new Map<string, ParseResult>();

    const parse = ( text: string ): ParseResult => {
        let result = parsed.get( text );
        if ( !result ) {
            if ( parsed.size > 500 ) {
                parsed.clear();
            }
            parsed.set( text, result = parseExpression( text ) );
        }
        return result;
    };

    const rootOf = ( unit: Unit ): object => {
        const instance = safe( () => adapter.units.instance?.( unit ) );
        let members: TrackedRow[] | undefined;
        return new Proxy( {}, {
            get( _target, key ) {
                if ( typeof key !== 'string' ) {
                    return undefined;
                }
                if ( instance && key in instance ) {
                    return ( instance as Record<string, unknown> )[key];
                }
                members ??= ctx.rowsOf( unit ).filter( r => r.category !== 'form' );
                return members.find( r => r.name === key || r.label === key )?.read();
            }
        } );
    };

    const evaluate: PathReader['evaluate'] = ( unit, expression ) => {
        const options = { reactivity: adapter.reactivity };
        if ( expression.base.kind === 'pin' ) {
            const pin = pins.get( expression.base.id );
            const root = pins.resolve( expression.base.id );
            if ( !pin || !root ) {
                return { ok: false, at: 0, reason: 'nullish', message: `${expression.base.id} ${pin ? 'is gone' : 'is not pinned'}` };
            }
            return evaluatePath( root, expression.segments, options );
        }
        if ( !unit ) {
            return { ok: false, at: 0, reason: 'nullish', message: 'no unit to start at' };
        }
        return evaluatePath( rootOf( unit ), expression.segments, options );
    };

    const read: PathReader['read'] = ( unit, text ) => {
        const result = parse( text );
        if ( !result.ok ) {
            return new Unreachable( result.error );
        }
        const evaluation = evaluate( unit, result.expression );
        return evaluation.ok ? evaluation.value : new Unreachable( evaluation.message );
    };

    return {
        parse,
        canonical: text => {
            const result = parse( text );
            return result.ok ? formatExpression( result.expression ) : undefined;
        },
        evaluate,
        read,
        rowFor: ( unit, text ) => ( { unit, category: EXPRESSIONS, name: text, read: () => read( unit, text ) } )
    };
}
