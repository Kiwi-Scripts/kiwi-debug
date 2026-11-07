import { keepState } from '@kiwi-js/dom';
import {
    badge, button, div, memoryStorage, placeBox, renderDetails, renderSection, sessionStorageAdapter, span,
    type HotkeyBinding, type PanelContext, type PanelDefinition, type PanelHandle, type StorageAdapter
} from '@kiwi-js/panels';

import { createChangeTracker, groupKey, rowKey } from '../../core/change-tracker';
import { createDirectiveView } from '../../core/directive-view';
import { Tracking, type TrackTarget } from '../../core/services';
import type { DebugContext, DebugFeature, FeatureInstance } from '../../core/types';
import { createInspectPanel } from './inspect-panel';
import { createWatchModel, type WatchEntry } from './model';
import { EXPRESSIONS } from './paths';
import type { Pin } from './pins';

const CATEGORIES = ['inputs', 'outputs', 'properties', 'form', EXPRESSIONS];

const ICON = 'M12 4.5C7 4.5 2.7 7.6 1 12c1.7 4.4 6 7.5 11 7.5s9.3-3.1 11-7.5c-1.7-4.4-6-7.5-11-7.5zM12 17a5 5 0 1 1 0-10 5 5 0 0 1 0 10z';

/** Where tracked values are kept: the storage given for the overlay, else the session (per tab). */
function storageFor( ctx: DebugContext ): StorageAdapter {
    const configured = ctx.options.overlay.storage;
    return configured === false ? memoryStorage() : configured ?? sessionStorageAdapter( 'kiwi-debug' );
}

function setup( ctx: DebugContext ): FeatureInstance {
    const { overlay, adapter } = ctx;
    const view = createDirectiveView( ctx );
    const changes = createChangeTracker( adapter.reactivity, { detail: ctx.options.valueDetail === 'detail' } );
    const model = createWatchModel( ctx, {
        storage: storageFor( ctx ),
        path: typeof location === 'undefined' ? '/' : location.pathname,
        palette: ctx.options.trackedColors
    } );
    const panel = (): PanelHandle | undefined => overlay.panels.get( 'watch' );

    let pc: PanelContext | undefined;
    let root: HTMLElement | undefined;
    let signature = '';
    /** The unit shown in full below the list, with a tracking icon on every member. */
    let side: TrackTarget | null = null;
    const outlines = new Map<Element, HTMLElement>();

    const visible = (): boolean => panel()?.state === 'open' && !panel()!.collapsed;

    // ---------------------------------------------------------------- outlines of kept elements
    const syncOutlines = (): void => {
        const wanted = new Set( model.entries.map( e => e.element ).filter( el => model.isOutlined( el ) ) );
        for ( const [el, box] of outlines ) {
            if ( !wanted.has( el ) ) {
                box.remove();
                outlines.delete( el );
            }
        }
        for ( const el of wanted ) {
            let box = outlines.get( el );
            if ( !box ) {
                box = div( 'kp-highlight kd-outline' );
                box.append( span( 'kd-outline-index', '' ) );
                overlay.root.append( box );
                outlines.set( el, box );
            }
            box.style.borderColor = model.colorOf( el );
            box.firstElementChild!.textContent = String( model.indexOf( el ) );
            placeBox( box, el );
        }
    };

    // ---------------------------------------------------------------- state
    /** Entries whose element left the page are dropped. */
    const dropGone = (): boolean => {
        const gone = model.entries.filter( e => !e.element.isConnected );
        gone.forEach( e => model.remove( e.id ) );
        return gone.length > 0;
    };

    const isSeen = ( key: string ): boolean => {
        if ( !visible() || !root ) {
            return false;
        }
        if ( key.startsWith( '$' ) ) {
            return true;
        }
        const entry = model.entries.find( e => key.startsWith( `${e.id}:` ) );
        return !!entry?.expanded;
    };

    // ---------------------------------------------------------------- rendering
    const renderEntry = ( entry: WatchEntry, snapshot: ReturnType<typeof changes.snapshot> ): HTMLElement => {
        const color = model.colorOf( entry.element );
        const target = { unit: entry.unit, element: entry.element };
        const head: ( Node | string )[] = [];
        const marker = span( 'kd-index', String( model.indexOf( entry.element ) ) );
        marker.style.background = color;
        head.push( marker );
        const picker = document.createElement( 'input' );
        picker.type = 'color';
        picker.className = 'kd-color';
        picker.value = color;
        picker.title = 'Color of this element';
        picker.onclick = ev => ev.stopPropagation();
        picker.oninput = () => model.setColor( entry.element, picker.value );
        head.push( picker );
        head.push( view.nameLink( target ) );
        if ( entry.kind !== 'component' ) {
            head.push( badge( entry.kind ) );
        }
        const unseen = CATEGORIES.reduce( ( sum, c ) => sum + changes.unseenIn( groupKey( entry.id, c ) ), 0 );
        if ( unseen ) {
            head.push( badge( `${unseen} changed` ) );
        }
        head.push( ...view.unitActions( target, 'watch', 'trailing' ) );

        const details = renderDetails( {
            className: 'kp-dir kd-entry',
            key: entry.id,
            open: entry.expanded,
            headRow: true,
            head,
            body: () => view.rowGroups( target, model.rowsOf( entry ), {
                surface: 'watch', scope: entry.id, changes, snapshot, collapsible: false
            } ),
            onToggle: expanded => {
                entry.expanded = expanded;
                if ( expanded ) {
                    CATEGORIES.forEach( c => changes.acknowledge( groupKey( entry.id, c ) ) );
                }
            }
        } );
        details.style.borderLeft = `3px solid ${color}`;
        details.onmouseenter = () => ctx.highlightHover( entry.element );
        details.onmouseleave = () => ctx.highlightHover( null );
        return details;
    };

    /** The paths of a pin that are tracked, after the pin itself. */
    const pinRows = ( pin: Pin ): string[] => [pin.id, ...pin.paths];

    const renderPin = ( pin: Pin, snapshot: ReturnType<typeof changes.snapshot> ): HTMLElement => {
        const gone = !model.pins.resolve( pin.id );
        const head: ( Node | string )[] = [span( 'kd-index', pin.id ), span( 'kp-muted', pin.origin )];
        if ( gone ) {
            head.push( badge( 'gone' ) );
        }
        head.push( button( '✕', 'Remove this reference', () => model.pins.remove( pin.id ), { mini: true } ) );
        return renderDetails( {
            className: 'kp-dir kd-pin',
            key: `pin:${pin.id}`,
            open: true,
            headRow: true,
            head,
            body: () => pinRows( pin ).map( text => {
                const key = rowKey( pin.id, EXPRESSIONS, text );
                const row = div( 'kp-row kd-row' );
                if ( text !== pin.id ) {
                    row.append( button( '◉', 'Stop tracking this path', () => model.toggleExpression( undefined, text ), { mini: true, on: true } ) );
                }
                const value = span( 'kd-value', snapshot.get( key )?.text ?? '' );
                row.append( span( `kd-name kd-${EXPRESSIONS}`, text ), ' = ', value,
                    button( '⌕', 'Inspect this path', () => overlay.panels.open( 'inspect', { expression: text } ), { mini: true } ) );
                changes.markRow( row, key );
                row.onmouseenter = () => changes.dismiss( key );
                return row;
            } )
        } );
    };

    const renderSide = (): HTMLElement | undefined => {
        if ( !side ) {
            return undefined;
        }
        const target = side;
        const name = adapter.units.describe( target.unit ).name;
        const close = button( '✕', 'Close this view', () => {
            side = null;
            signature = '';
            refresh();
        }, { mini: true } );
        return renderSection( `Unit ${name}`, close, ...view.rowGroups( target, ctx.rowsOf( target.unit ), { surface: 'side', scope: `side:${name}`, changes, open: () => true } ) );
    };

    const draw = ( snapshot: ReturnType<typeof changes.snapshot> ): void => {
        if ( !root || !pc ) {
            return;
        }
        keepState( pc.body, () => {
            root!.replaceChildren();
            if ( !model.entries.length && !model.pins.list().length ) {
                root!.append( div( 'kp-muted kd-hint', `Track values from the inspector or the search: click ◉, or ${ctx.options.key} + click a name.` ) );
            }
            model.entries.forEach( entry => root!.append( renderEntry( entry, snapshot ) ) );
            if ( model.pins.list().length ) {
                root!.append( renderSection( 'References', ...model.pins.list().map( pin => renderPin( pin, snapshot ) ) ) );
            }
            const sideView = renderSide();
            if ( sideView ) {
                root!.append( sideView );
            }
        } );
    };

    const updateHeader = (): void => {
        const unseen = changes.unseenCount();
        const count = model.entries.length + model.pins.list().length;
        pc?.setTitle( `Tracked values (${count})${unseen ? ` · ${unseen} changed` : ''}` );
        pc?.setBadge( count || null );
    };

    // ---------------------------------------------------------------- refresh
    function refresh(): void {
        syncOutlines();
        if ( !pc ) {
            return;
        }
        if ( dropGone() ) {
            signature = '';
        }
        const refs = model.entries.flatMap( entry => model.rowsOf( entry ).map( r => ( { scope: entry.id, category: r.category, name: r.name, read: r.read } ) ) );
        const pinRefs = model.pins.list().flatMap( pin => pinRows( pin ).map( text => ( { scope: pin.id, category: EXPRESSIONS, name: text, read: () => model.reader.read( undefined, text ) } ) ) );
        const snapshot = changes.snapshot( [...refs, ...pinRefs] );
        const structure = [
            ...model.entries.map( e => `${e.id}${e.all ? '*' : ''}${model.colorOf( e.element )}${model.isOutlined( e.element )}` ),
            ...model.pins.list().map( p => `${p.id}${pinRows( p ).join( '+' )}${model.pins.resolve( p.id ) ? '' : 'gone'}` )
        ].join( ',' );
        const next = `${structure}\u0003${side ? 'side' : ''}\u0003${changes.signatureOf( snapshot )}`;
        if ( next === signature ) {
            return;
        }
        changes.diff( snapshot, isSeen );
        draw( snapshot );
        changes.commit( snapshot );
        signature = next;
        updateHeader();
    }

    // ---------------------------------------------------------------- the panel
    /** The panel is shown when something gets tracked; closing it does not stop the tracking. */
    const reveal = (): void => {
        const handle = panel();
        if ( handle && ( model.entries.length || model.pins.list().length ) && handle.state === 'closed' ) {
            handle.open();
        }
    };

    const offChange = model.onChange( () => {
        reveal();
        signature = '';
        refresh();
    } );
    model.startRestore();

    const definition: PanelDefinition = {
        id: 'watch',
        title: 'Tracked values',
        icon: ICON,
        hotkey: 'KeyT',
        defaultPosition: 'top-right',
        mount( context ) {
            pc = context;
            root = div( 'kd-watch-body' );
            return {
                content: root,
                onShow: () => {
                    signature = '';
                    refresh();
                },
                // Entries stay tracked while the panel is minimized or closed; the panel keeps refreshing as long as there are any.
                isActive: () => model.entries.length > 0 || model.pins.list().length > 0,
                refresh,
                dispose() {
                    pc = undefined;
                    root = undefined;
                    changes.clear();
                }
            };
        }
    };

    const entryOf = ( c: { target: { unit: unknown } } ): WatchEntry | undefined => model.entries.find( e => e.unit === c.target.unit );
    const offActions = [
        ctx.actions.register( 'unit', {
            id: 'keep', icon: '▣', surfaces: ['watch'], title: 'Keep the element outlined',
            isOn: c => !!c.target.element && model.isOutlined( c.target.element ),
            run: c => c.target.element && model.toggleOutline( c.target.element )
        } ),
        ctx.actions.register( 'unit', {
            id: 'side', icon: '⧉', surfaces: ['watch'], title: 'Show the whole unit below',
            run: c => {
                side = c.target;
                signature = '';
                refresh();
            }
        } ),
        ctx.actions.register( 'unit', {
            id: 'remove', icon: '✕', surfaces: ['watch'], title: 'Stop tracking',
            run: c => {
                const entry = entryOf( c );
                if ( entry ) {
                    model.remove( entry.id );
                }
            }
        } )
    ];
    offActions.push( ctx.actions.register( 'row', {
        id: 'inspect', icon: '⌕', title: 'Inspect this value further',
        run: c => c.row && overlay.panels.open( 'inspect', { unit: c.target.unit, element: c.target.element, expression: c.row.category === 'form' ? '' : c.row.name } ),
        visible: c => !!c.row && c.row.category !== 'form' && !!overlay.panels.get( 'inspect' )
    } ) );
    const hotkeys: HotkeyBinding[] = [{
        combo: 'Escape', modifier: false, allowWhileEditing: true,
        handler: () => {
            const mini = overlay.panels.get( 'inspect' );
            if ( mini?.state === 'open' ) {
                mini.close();
                return true;
            }
            return false;
        }
    }];
    const inspectPanel = createInspectPanel( ctx, model, () => {
        reveal();
        signature = '';
        refresh();
    } );
    const offService = ctx.provide( Tracking, model.tracking );
    const reposition = (): void => syncOutlines();

    return {
        panel: definition,
        panels: [inspectPanel],
        hotkeys,
        listeners: [[window, 'scroll', reposition, true], [window, 'resize', reposition, false]],
        dispose() {
            offChange();
            offService();
            offActions.forEach( off => off() );
            model.dispose();
            outlines.forEach( box => box.remove() );
            outlines.clear();
        }
    };
}

export const watchFeature: DebugFeature = { id: 'watch', setup };
