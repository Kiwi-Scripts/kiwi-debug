import { closestMatch } from '@kiwi-js/dom';
import type { PanelHandle } from '@kiwi-js/panels';

import type { DebugContext, ListenerTuple } from '../../core/types';

export interface HoverOptions {
    panel(): PanelHandle | undefined;
}

export interface HoverController {
    listeners: ListenerTuple[];
    /** The inspectable element under a raw page element, across shadow roots. */
    resolve( raw: Element | null ): Element | null;
    /** The last pointer position in the viewport. */
    pointer(): { x: number; y: number };
    /** Forgets the hover (outline and preview). */
    clear(): void;
    dispose(): void;
}

/**
 * The part of the inspector that is not a panel: while the modifier is held it follows the pointer, outlines the inspectable element
 * under it and shows the panel as a preview next to the pointer. Modified clicks pin the panel to an element.
 */
export function createHoverController( ctx: DebugContext, options: HoverOptions ): HoverController {
    const { overlay } = ctx;
    const modifier = overlay.modifier;
    let raw: Element | null = null;
    let pointer = { x: 0, y: 0 };
    let tracking = false;
    /** The element the preview currently shows, so that moving within it does not rebuild the panel. */
    let previewed: Element | null = null;

    const resolve = ( el: Element | null ): Element | null =>
        el ? closestMatch( el, e => ctx.inspect( e ), { composed: true } )?.element ?? null : null;

    const rawOf = ( ev: Event ): Element | null => {
        const first = ev.composedPath()[0];
        return first instanceof Element ? first : null;
    };

    const clear = (): void => {
        tracking = false;
        previewed = null;
        ctx.highlightHover( null );
        const panel = options.panel();
        if ( panel?.previewing ) {
            panel.endPreview();
        }
    };

    /** Applies the hover for the element under the pointer. */
    const update = ( held: boolean ): void => {
        const panel = options.panel();
        if ( !held || !panel ) {
            clear();
            return;
        }
        tracking = true;
        const next = resolve( raw );
        if ( panel.state === 'open' ) {
            // The panel is pinned: hovering only outlines, it does not change what the panel shows.
            ctx.highlightHover( next );
            return;
        }
        ctx.highlightHover( null );
        if ( next && ( next !== previewed || !panel.previewing ) ) {
            previewed = next;
            panel.preview( next, pointer );
        }
    };

    const onMove = ( ev: MouseEvent ): void => {
        pointer = { x: ev.clientX, y: ev.clientY };
        if ( overlay.inOverlay( ev.target ) ) {
            return;
        }
        raw = rawOf( ev );
        const held = ctx.isHeld( ev );
        if ( held || tracking ) {
            update( held );
        }
    };

    const onClick = ( ev: MouseEvent ): void => {
        if ( !ctx.isHeld( ev ) || overlay.inOverlay( ev.target ) ) {
            return;
        }
        ev.preventDefault();
        ev.stopPropagation();
        const target = resolve( rawOf( ev ) );
        if ( target ) {
            options.panel()?.open( target );
        }
    };

    const offModifier = modifier?.onChange( () => update( modifier.isDown() || modifier.isLatched() ) );

    return {
        listeners: [[document, 'mousemove', onMove, true], [document, 'click', onClick, true]],
        resolve,
        pointer: () => pointer,
        clear,
        dispose: () => offModifier?.()
    };
}
