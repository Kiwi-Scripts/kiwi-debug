import { describeElement, keepState } from '@kiwi-js/dom';
import {
    badge, button, div, link, placeBox, renderDetails, renderSection, span,
    type HotkeyBinding, type PanelContext, type PanelDefinition, type PanelHandle
} from '@kiwi-js/panels';

import type { Unit } from '../../adapter/types';
import { createChangeTracker, type Snapshot } from '../../core/change-tracker';
import { logGroup } from '../../core/console';
import { createDirectiveView } from '../../core/directive-view';
import { safe } from '../../core/safe';
import { InspectedElement } from '../../core/services';
import type { DebugContext, DebugFeature, FeatureInstance } from '../../core/types';
import type { TrackedRow } from '../../core/units';
import { createHoverController } from './hover';

const ICON = 'M12 4.5C7 4.5 2.7 7.6 1 12c1.7 4.4 6 7.5 11 7.5s9.3-3.1 11-7.5c-1.7-4.4-6-7.5-11-7.5zM12 17a5 5 0 1 1 0-10 5 5 0 0 1 0 10zm0-8a3 3 0 1 0 0 6 3 3 0 0 0 0-6z';

interface UnitInfo {
    unit: Unit;
    name: string;
    kind: string;
    rows: TrackedRow[];
}

/** How many inspectable ancestors an element has. */
function depthOf( ctx: DebugContext, el: Element ): number {
    let depth = 0;
    for ( let at = ctx.findParent( el ); at && depth < 100; at = ctx.findParent( at ) ) {
        depth++;
    }
    return depth;
}

function setup( ctx: DebugContext ): FeatureInstance {
    const { overlay, adapter } = ctx;
    const view = createDirectiveView( ctx );
    const changes = createChangeTracker( adapter.reactivity, { detail: ctx.options.valueDetail === 'detail' } );
    const panel = (): PanelHandle | undefined => overlay.panels.get( 'inspector' );

    let target: Element | null = null;
    /** The child that `Mod + →` goes to; the element left behind when going up. */
    let selectedChild: Element | null = null;
    let signature = '';
    let pc: PanelContext | undefined;
    let root: HTMLElement | undefined;
    let outline: HTMLElement | undefined;

    const visible = (): boolean => !!panel() && ( panel()!.state === 'open' || panel()!.previewing );

    // ---------------------------------------------------------------- outline of the inspected element
    const placeOutline = (): void => {
        if ( !outline ) {
            outline = div( 'kp-highlight kd-target' );
            overlay.root.append( outline );
        }
        placeBox( outline, visible() ? target : null );
    };

    // ---------------------------------------------------------------- state
    const dropTarget = (): void => {
        const handle = panel();
        target = null;
        selectedChild = null;
        signature = '';
        changes.clear();
        if ( handle?.previewing ) {
            handle.endPreview();
        } else if ( handle?.state === 'open' ) {
            handle.close();
        }
        placeOutline();
    };

    const setTarget = ( el: Element ): void => {
        target = el;
        selectedChild = null;
        signature = '';
        changes.clear();
        refresh();
    };

    /** An element's own units, component first. */
    const unitsOf = ( el: Element ): UnitInfo[] => {
        const inspection = ctx.inspect( el );
        if ( !inspection ) {
            return [];
        }
        return [inspection.component, ...inspection.directives].filter( ( u ): u is Unit => !!u ).map( unit => {
            const description = adapter.units.describe( unit );
            return { unit, name: description.name, kind: description.kind, rows: ctx.rowsOf( unit ) };
        } );
    };

    const isSeen = ( key: string ): boolean => {
        if ( !visible() || !root ) {
            return false;
        }
        const details = Array.from( root.querySelectorAll<HTMLDetailsElement>( 'details[data-key]' ) );
        const group = details.find( d => d.dataset.key === key );
        return !!group?.open && !!group.closest( '.kd-unit' ) && ( group.closest( '.kd-unit' ) as HTMLDetailsElement ).open;
    };

    // ---------------------------------------------------------------- rendering
    const relationRow = ( el: Element, label: string, depth: number, selected = false ): HTMLElement => {
        const row = div( `kp-row kd-relation${selected ? ' kd-selected' : ''}` );
        const names = ctx.inspect( el )?.component ?? ctx.inspect( el )?.directives[0];
        const name = names ? adapter.units.describe( names ).name : '';
        row.append( span( 'kp-muted', `${label} ${'·'.repeat( Math.min( depth, 6 ) )}` ), link( `${name || describeElement( el )}`, describeElement( el ), () => {
            selectedChild = null;
            setTarget( el );
        } ) );
        row.onmouseenter = () => ctx.highlightHover( el );
        row.onmouseleave = () => ctx.highlightHover( null );
        return row;
    };

    const renderHeader = ( el: Element ): HTMLElement => {
        const head = div( 'kd-head' );
        const line = div( 'kp-row' );
        line.append( link( `<${describeElement( el )}>`, 'Click to log the element', () => logGroup( describeElement( el ), [['element', el]] ) ) );
        const sections = adapter.units.sections?.( el ) ?? [];
        for ( const section of sections ) {
            line.append( ' ', link( section.label, `Log ${section.label}`, () => logGroup( section.label, [['value', safe( () => section.read() )]] ), true ) );
        }
        const owner = adapter.units.owner?.( el );
        if ( owner ) {
            const ownerInfo = adapter.units.describe( owner );
            const ownerLink = link( `owner: ${ownerInfo.name}`, 'Click to log the owning component', () => logGroup( ownerInfo.name, [['instance', owner], ['element', ownerInfo.element ?? undefined]] ), true );
            ownerLink.onmouseenter = () => ctx.highlightHover( ownerInfo.element );
            ownerLink.onmouseleave = () => ctx.highlightHover( null );
            line.append( ' ', ownerLink );
        }
        if ( adapter.reactivity && overlay.panels.get( 'graph' ) ) {
            line.append( ' ', link( 'signal graph', 'Show the signal graph of this element', () => overlay.panels.open( 'graph', { element: el } ), true ) );
        }
        if ( adapter.forms && overlay.panels.get( 'forms' ) ) {
            line.append( ' ', link( 'forms', 'Show the forms of this element', () => overlay.panels.open( 'forms', { element: el } ), true ) );
        }
        head.append( line );
        return head;
    };

    const renderUnit = ( el: Element, info: UnitInfo, index: number, snapshot: Snapshot ): HTMLElement => {
        const target = { unit: info.unit, element: el };
        const head: ( Node | string )[] = [...view.unitActions( target, 'inspector', 'leading' ), view.nameLink( target )];
        if ( info.kind !== 'component' ) {
            head.push( badge( info.kind ) );
        }
        head.push( ...view.unitActions( target, 'inspector', 'trailing' ) );
        const profile = view.profileBadge( info.unit );
        if ( profile ) {
            head.push( profile );
        }
        return renderDetails( {
            className: 'kp-dir kd-unit',
            key: `unit:${info.name}`,
            open: index === 0,
            headRow: true,
            head,
            body: () => view.rowGroups( target, info.rows, { surface: 'inspector', scope: info.name, changes, snapshot } )
        } );
    };

    const renderSections = ( el: Element ): HTMLElement[] => ( adapter.units.sections?.( el ) ?? [] ).flatMap( section => {
        const items = section.list?.();
        if ( !items ) {
            return [];
        }
        return [renderDetails( {
            className: 'kp-dir kd-section',
            key: `section:${section.id}`,
            headRow: true,
            head: [span( 'kp-muted', section.label ), badge( String( items.length ) )],
            body: () => items.map( item => {
                const row = div( 'kp-row' );
                row.append( span( '', item.title, item.detail ), ...( item.chips ?? [] ).map( chip => badge( chip ) ), ...( item.owner ? [span( 'kp-muted', item.owner )] : [] ) );
                return row;
            } )
        } )];
    } );

    const renderRelations = ( el: Element ): HTMLElement => {
        const parent = ctx.findParent( el );
        const children = ctx.findChildren( el );
        const depth = depthOf( ctx, el );
        const nodes: HTMLElement[] = [];
        if ( parent ) {
            nodes.push( relationRow( parent, 'parent', depth - 1, selectedChild === el ) );
        }
        children.forEach( child => nodes.push( relationRow( child, 'child', depth + 1, child === selectedChild ) ) );
        return renderSection( `Relations (depth ${depth})`, ...( nodes.length ? nodes : [span( 'kp-muted', 'none' )] ) );
    };

    const renderHint = (): HTMLElement => {
        const key = ctx.options.key;
        return div( 'kp-muted kd-hint', `Hold ${key} and hover an element, or ${key} + click to pin it.` );
    };

    const updateHeader = (): void => {
        if ( !pc ) {
            return;
        }
        pc.setTitle( target ? describeElement( target ) : 'Inspector' );
        const nodes: Node[] = [];
        if ( panel()?.previewing ) {
            nodes.push( button( 'Pin', 'Pin: keep the inspector open', () => panel()?.open(), { mini: true } ) );
        } else {
            nodes.push( button( 'Pin', 'Let the inspector close', () => panel()?.close(), { mini: true, on: true } ) );
        }
        if ( target ) {
            nodes.push(
                button( '←', 'Parent (modifier + ←)', () => go( 'parent' ), { mini: true, disabled: !ctx.findParent( target ) } ),
                button( '→', 'Child (modifier + →)', () => go( 'child' ), { mini: true, disabled: !ctx.findChildren( target ).length } ) );
        }
        pc.setHeaderRight( nodes );
    };

    const render = ( infos: UnitInfo[], snapshot: Snapshot ): void => {
        if ( !root || !pc ) {
            return;
        }
        const draw = (): void => {
            root!.replaceChildren();
            if ( !target ) {
                root!.append( renderHint() );
                return;
            }
            if ( !infos.length ) {
                root!.append( div( 'kp-muted', 'Nothing inspectable on this element any more.' ) );
                return;
            }
            root!.append( renderHeader( target ), ...infos.map( ( info, i ) => renderUnit( target!, info, i, snapshot ) ), ...renderSections( target ), renderRelations( target ) );
        };
        keepState( pc.body, draw );
    };

    // ---------------------------------------------------------------- refresh
    function refresh(): void {
        placeOutline();
        if ( !pc ) {
            return;
        }
        if ( !target ) {
            updateHeader();
            render( [], new Map() );
            return;
        }
        if ( !target.isConnected ) {
            dropTarget();
            return;
        }
        const infos = unitsOf( target );
        const refs = infos.flatMap( info => info.rows.map( r => ( { scope: info.name, category: r.category, name: r.name, read: r.read } ) ) );
        const snapshot = changes.snapshot( refs );
        const structure = [infos.map( i => i.name ).join( ',' ), ctx.findChildren( target ).length, !!ctx.findParent( target ), panel()?.previewing ? 1 : 0].join( '|' );
        const next = `${structure}\u0003${changes.signatureOf( snapshot )}`;
        if ( next === signature ) {
            return;
        }
        changes.diff( snapshot, isSeen );
        updateHeader();
        render( infos, snapshot );
        changes.commit( snapshot );
        signature = next;
        pc.setBadge( changes.unseenCount() || null );
    }

    // ---------------------------------------------------------------- navigation
    function go( direction: 'parent' | 'child' | 'next' | 'previous' ): void {
        if ( !target ) {
            return;
        }
        const children = ctx.findChildren( target );
        if ( direction === 'parent' ) {
            const parent = ctx.findParent( target );
            if ( parent ) {
                const left = target;
                setTarget( parent );
                selectedChild = left;
                signature = '';
                refresh();
            }
        } else if ( direction === 'child' ) {
            const child = selectedChild && children.includes( selectedChild ) ? selectedChild : children[0];
            if ( child ) {
                setTarget( child );
            }
        } else if ( children.length ) {
            const index = selectedChild ? children.indexOf( selectedChild ) : -1;
            const step = direction === 'next' ? 1 : -1;
            selectedChild = children[( index + step + children.length * 2 ) % children.length];
            ctx.highlightHover( selectedChild );
            signature = '';
            refresh();
        }
    }

    // ---------------------------------------------------------------- hover and hotkeys
    const hover = createHoverController( ctx, { panel } );

    const navigation = ( code: string, direction: Parameters<typeof go>[0] ): HotkeyBinding => ( {
        combo: code,
        handler: () => {
            if ( !visible() || !target ) {
                return false;
            }
            go( direction );
            return true;
        }
    } );

    const hotkeys: HotkeyBinding[] = [
        {
            combo: 'Escape', modifier: false, allowWhileEditing: true,
            handler: () => {
                const handle = panel();
                if ( handle?.state === 'open' ) {
                    handle.close();
                    return true;
                }
                return false;
            }
        },
        navigation( 'ArrowLeft', 'parent' ),
        navigation( 'ArrowRight', 'child' ),
        navigation( 'ArrowUp', 'previous' ),
        navigation( 'ArrowDown', 'next' )
    ];

    // ---------------------------------------------------------------- the panel
    const definition: PanelDefinition = {
        id: 'inspector',
        title: 'Inspector',
        icon: ICON,
        className: 'kd-inspector',
        hotkey: 'KeyP',
        dockable: true,
        trayToggle: 'minimize',
        defaultPosition: 'top-right',
        mount( context ) {
            pc = context;
            root = div( 'kd-inspector-body' );
            return {
                content: root,
                onShow( args ) {
                    if ( args instanceof Element ) {
                        setTarget( args );
                    } else {
                        signature = '';
                        refresh();
                    }
                },
                onHide() {
                    target = null;
                    selectedChild = null;
                    signature = '';
                    changes.clear();
                    ctx.highlightHover( null );
                    placeOutline();
                },
                onMinimize: () => ctx.highlightHover( null ),
                refresh,
                dispose() {
                    pc = undefined;
                    root = undefined;
                }
            };
        }
    };

    const offService = ctx.provide( InspectedElement, () => visible() ? target : null );
    const reposition = (): void => placeOutline();

    return {
        panel: definition,
        hotkeys,
        listeners: [...hover.listeners, [window, 'scroll', reposition, true], [window, 'resize', reposition, false]],
        dispose() {
            offService();
            hover.dispose();
            hover.clear();
            outline?.remove();
            outline = undefined;
        }
    };
}

export const inspectorFeature: DebugFeature = { id: 'inspector', setup };
