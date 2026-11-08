import { placeBox } from '@kiwi-js/dom';
import { button, div, type Overlay } from '@kiwi-js/panels';

import type { GuardedAdapter } from '../adapter/types';
import { createActionRegistry } from './actions';
import { registerBuiltinActions } from './builtin-actions';
import { DEFAULT_PREVIEW_KEYS, setPreviewKeys } from './format';
import { createServices, InspectedElement } from './services';
import type { DebugContext, EffectiveOptions } from './types';
import { createUnitReaders } from './units';

export interface ContextInit {
    overlay: Overlay;
    adapter: GuardedAdapter;
    options: EffectiveOptions;
}

export interface ContextHandle {
    ctx: DebugContext;
    dispose(): void;
}

/** Builds the context features work with: unit readers on the guarded adapter, services, and the shared hover highlight. */
export function createDebugContext( { overlay, adapter, options }: ContextInit ): ContextHandle {
    setPreviewKeys( options.previewKeys ?? DEFAULT_PREVIEW_KEYS );
    const readers = createUnitReaders( adapter, el => overlay.inOverlay( el ) );
    const services = createServices();
    const actions = createActionRegistry( options.actions );
    registerBuiltinActions( actions );
    const runOutside = <T>( fn: () => T ): T => adapter.env.runOutside ? adapter.env.runOutside( fn ) : fn();

    let hover: Element | null = null;
    let box: HTMLElement | undefined;
    const place = (): void => box && placeBox( box, hover );
    const reposition = (): void => void ( hover && place() );
    const ensureBox = (): HTMLElement => {
        if ( !box ) {
            box = div( 'kp-highlight kd-hover' );
            overlay.root.append( box );
            runOutside( () => {
                window.addEventListener( 'scroll', reposition, true );
                window.addEventListener( 'resize', reposition );
            } );
        }
        return box;
    };

    const ctx: DebugContext = {
        overlay,
        adapter,
        options,
        ...readers,
        actions,
        provide: services.provide,
        use: services.use,
        isHeld: ev => overlay.modifier ? overlay.modifier.isHeld( ev ) : true,
        inspectedElement: () => services.use( InspectedElement )?.() ?? null,
        highlightHover( el ) {
            hover = el;
            if ( el || box ) {
                ensureBox();
                place();
            }
        },
        watchButton( title, isOn, toggle ) {
            const el = button( '◉', title, () => {
                toggle();
                el.classList.toggle( 'kp-on', isOn() );
            }, { mini: true, on: isOn() } );
            el.classList.add( 'kd-watch' );
            return el;
        },
        runOutside
    };

    return {
        ctx,
        dispose() {
            window.removeEventListener( 'scroll', reposition, true );
            window.removeEventListener( 'resize', reposition );
            box?.remove();
            box = undefined;
            hover = null;
        }
    };
}
