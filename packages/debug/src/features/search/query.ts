import type { Unit } from '../../adapter/types';
import type { TrackedRow } from '../../core/units';

/** One searchable unit, found while walking the page. */
export interface SearchEntry {
    id: string;
    unit: Unit;
    element: Element;
    kind: string;
    name: string;
    tag: string;
    /** Lowercase `name + TAG + id + class`. */
    haystack: string;
}

export interface ParsedQuery {
    /** Plain terms: all must be substrings of the haystack. */
    terms: string[];
    /** `@term`: matches the names of inputs and properties, and shows only the matching rows. */
    fields: string[];
}

export const MAX_RESULTS = 100;

/** Splits on whitespace; a term starting with `@` is a field term. */
export function parseQuery( text: string ): ParsedQuery {
    const query: ParsedQuery = { terms: [], fields: [] };
    for ( const raw of text.toLowerCase().split( /\s+/ ) ) {
        if ( raw.startsWith( '@' ) ) {
            if ( raw.length > 1 ) {
                query.fields.push( raw.slice( 1 ) );
            }
        } else if ( raw ) {
            query.terms.push( raw );
        }
    }
    return query;
}

export const isEmptyQuery = ( query: ParsedQuery ): boolean => !query.terms.length && !query.fields.length;

export function haystackOf( name: string, element: Element ): string {
    return `${name}${element.localName}${element.id}${element.getAttribute( 'class' ) ?? ''}`.toLowerCase();
}

/** The entries containing every plain term; stable, with names that start with the first term first. */
export function matchEntries( entries: readonly SearchEntry[], query: ParsedQuery ): SearchEntry[] {
    const matching = entries.filter( e => query.terms.every( term => e.haystack.includes( term ) ) );
    const first = query.terms[0];
    if ( !first ) {
        return matching;
    }
    const starts = ( e: SearchEntry ): number => e.name.toLowerCase().startsWith( first ) ? 0 : 1;
    // `sort` is stable, so equal entries keep the order of the page.
    return matching.sort( ( a, b ) => starts( a ) - starts( b ) );
}

/**
 * The rows matching every field term (inputs and properties by label or name), or `undefined` if some term matches nothing,
 * in which case the unit is no result.
 */
export function matchFields( rows: readonly TrackedRow[], fields: readonly string[] ): TrackedRow[] | undefined {
    const candidates = rows.filter( r => r.category === 'inputs' || r.category === 'properties' );
    const matched = new Set<TrackedRow>();
    for ( const field of fields ) {
        const hits = candidates.filter( r => `${r.label ?? ''}\0${r.name}`.toLowerCase().includes( field ) );
        if ( !hits.length ) {
            return undefined;
        }
        hits.forEach( r => matched.add( r ) );
    }
    return candidates.filter( r => matched.has( r ) );
}

/** The groups of the results by class name, in order of first appearance. */
export function groupByName<T extends { name: string }>( entries: readonly T[] ): Map<string, T[]> {
    const groups = new Map<string, T[]>();
    for ( const entry of entries ) {
        groups.set( entry.name, [...groups.get( entry.name ) ?? [], entry] );
    }
    return groups;
}
