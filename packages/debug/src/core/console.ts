import { Unreachable } from './expressions';

/** The prefix of everything the overlay writes to the console. */
export const LOG_PREFIX = '[kiwi-debug]';

/** A labelled value for {@link logGroup}; entries whose value is `undefined` are left out. */
export type LogEntry = readonly [label: string, value: unknown];

/** Whether logging a value tells more than its text does: objects, arrays and functions. A string or a number is just what is shown. */
export const isLoggable = ( value: unknown ): boolean => ( ( typeof value === 'object' && value !== null ) || typeof value === 'function' ) && !( value instanceof Unreachable );

const HEADING_STYLE = 'color:#7cc05b;font-weight:bold';

/** Writes an expanded console group with a highlighted heading and one prefixed line per defined entry. */
export function logGroup( title: string, entries: readonly ( LogEntry | undefined | false )[] ): void {
    console.group( `%c${LOG_PREFIX} ${title}`, HEADING_STYLE );
    try {
        for ( const entry of entries ) {
            if ( entry && entry[1] !== undefined ) {
                console.log( `${LOG_PREFIX} ${entry[0]}`, entry[1] );
            }
        }
    } finally {
        console.groupEnd();
    }
}

export const logInfo = ( message: string ): void => console.info( `${LOG_PREFIX} ${message}` );
export const logWarn = ( message: string, ...details: unknown[] ): void => console.warn( `${LOG_PREFIX} ${message}`, ...details );
