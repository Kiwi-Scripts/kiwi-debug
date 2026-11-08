import type { DebugContext } from './types';

export interface PickOptions {
    /** Hidden while picking, so that it does not cover what is picked (usually the panel the pick was started from). */
    hide?: HTMLElement;
    /** The element that was clicked: the nearest inspectable one. A click on nothing inspectable only ends the pick. */
    onPick( element: Element ): void;
    /** The pick ended, whichever way. */
    onEnd?(): void;
}

/**
 * Lets the user pick an inspectable element on the page: it is outlined while the pointer moves over it, and the click that picks
 * it does not reach the page. Escape ends the pick. Returns a function that ends it (safe to call again).
 */
export function startPick( ctx: DebugContext, options: PickOptions ): () => void {
    const { overlay, adapter } = ctx;
    const runOutside = <T>( fn: () => T ): T => adapter.env.runOutside ? adapter.env.runOutside( fn ) : fn();
    if ( options.hide ) {
        options.hide.style.visibility = 'hidden';
    }
    const resolve = ( ev: Event ): Element | null => {
        const first = ev.composedPath()[0];
        return first instanceof Element && !overlay.inOverlay( first ) ? ctx.findParent( first, true ) : null;
    };
    const block = ( ev: Event ): void => {
        ev.preventDefault();
        ev.stopPropagation();
    };

    let ended = false;
    const end = (): void => {
        if ( ended ) {
            return;
        }
        ended = true;
        runOutside( () => events.forEach( ( [type, fn] ) => document.removeEventListener( type, fn, true ) ) );
        if ( options.hide ) {
            options.hide.style.visibility = '';
        }
        ctx.highlightHover( null );
        options.onEnd?.();
    };

    const events: Array<[string, ( ev: any ) => void]> = [
        ['pointermove', ( ev: MouseEvent ) => ctx.highlightHover( resolve( ev ) )],
        ['click', ( ev: MouseEvent ) => {
            block( ev );
            const element = resolve( ev );
            end();
            if ( element ) {
                options.onPick( element );
            }
        }],
        ['keydown', ( ev: KeyboardEvent ) => {
            if ( ev.key === 'Escape' ) {
                block( ev );
                end();
            }
        }],
        // The press and release belong to the click that picks: they must not reach the page either.
        ['pointerdown', block], ['pointerup', block], ['mousedown', block], ['mouseup', block]
    ];
    runOutside( () => events.forEach( ( [type, fn] ) => document.addEventListener( type, fn, true ) ) );
    return end;
}
