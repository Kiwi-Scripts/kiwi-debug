import { charsFor, ellipsize, NODE_PADDING, type LayoutBox } from './layout';
import type { GraphEdge } from './model';

const SVG = 'http://www.w3.org/2000/svg';

/** A node as the view draws it. Which classes it has says how: `kd-dashed`, `kd-changed`, `kd-faded`, `kd-pulse`, `kd-root`. */
export interface ViewNode {
    id: number;
    box: LayoutBox;
    lines: readonly string[];
    kind: string;
    classes?: readonly string[];
}

export interface ViewEdge extends GraphEdge {
    classes?: readonly string[];
}

export interface GraphViewHandlers {
    /** The pointer is over a node, or left it (`null`). */
    hover( id: number | null ): void;
    /** A node was clicked; `null` for a click on the background. */
    click( id: number | null ): void;
}

export interface GraphView {
    readonly el: HTMLElement;
    /** Draws the nodes and edges anew. The pan, the zoom, the focus and the places the user moved nodes to stay. */
    set( nodes: readonly ViewNode[], edges: readonly ViewEdge[], size: { width: number; height: number } ): void;
    /** Zooms and pans so that all of it is seen. */
    fit(): void;
    /** Whether the user panned or zoomed, so that a resize no longer fits the graph by itself. */
    readonly moved: boolean;
    /** The node that is in focus: it and everything connected to it stay lit, the rest is dimmed. */
    setFocus( id: number | null ): void;
    /** Puts the nodes that were moved back where the layout has them. */
    arrange(): void;
    dispose(): void;
}

const svg = <K extends keyof SVGElementTagNameMap>( tag: K, attributes: Record<string, string | number> = {}, className?: string ): SVGElementTagNameMap[K] => {
    const el = document.createElementNS( SVG, tag );
    for ( const [name, value] of Object.entries( attributes ) ) {
        el.setAttribute( name, String( value ) );
    }
    if ( className ) {
        el.setAttribute( 'class', className );
    }
    return el;
};

const MIN_SCALE = 0.1;
const MAX_SCALE = 3;
const DRAG_THRESHOLD = 3;

/** The graph as SVG, with panning by dragging the background, moving nodes by dragging them, and zooming with the wheel. */
export function createGraphView( handlers: GraphViewHandlers ): GraphView {
    const el = document.createElement( 'div' );
    el.className = 'kd-graph-view';
    // The drawing sits on a stage that is moved and scaled with CSS, so that panning is the compositor's job and does not repaint it.
    const stage = document.createElement( 'div' );
    stage.className = 'kd-graph-stage';
    // What the geometry rests on is set here and not in the stylesheet, so that a stale one cannot throw the zooming off.
    stage.style.cssText = 'position:absolute;left:0;top:0;transform-origin:0 0';
    const root = svg( 'svg', { width: 0, height: 0 } );
    root.style.overflow = 'visible';
    const defs = svg( 'defs' );
    for ( const [id, className] of [['kd-arrow', 'kd-arrow'], ['kd-arrow-hot', 'kd-arrow kd-arrow-hot']] ) {
        const marker = svg( 'marker', { id, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' } );
        marker.append( svg( 'path', { d: 'M0 0L10 5L0 10z' }, className ) );
        defs.append( marker );
    }
    const scene = svg( 'g' );
    // Edges of the node in focus are drawn here, above the nodes, so that they can be followed even where they pass behind others.
    const hotLayer = svg( 'g', { class: 'kd-hot-layer' } );
    root.append( defs, scene, hotLayer );
    stage.append( root );
    el.append( stage );

    let scale = 1;
    let tx = 0;
    let ty = 0;
    let moved = false;
    let content = { width: 0, height: 0 };
    let focus: number | null = null;
    let structure = '';
    let lastNodes: readonly ViewNode[] = [];
    let lastEdges: readonly ViewEdge[] = [];

    interface NodeRefs {
        group: SVGElement;
        texts: SVGTextElement[];
        title: SVGElement;
        classes: Set<string>;
        lines: string[];
        dim: boolean;
        focused: boolean;
    }
    interface EdgeRefs {
        edge: ViewEdge;
        path: SVGElement;
        classes: Set<string>;
        dim: boolean;
        hot: boolean;
    }
    let edgeLayer: SVGElement = svg( 'g' );
    const nodeRefs = new Map<number, NodeRefs>();
    let edgeRefs: EdgeRefs[] = [];
    /** What feeds each node, and what it feeds, for finding what is connected to a node without looking at every edge. */
    let up = new Map<number, number[]>();
    let down = new Map<number, number[]>();
    /** The edges at each node, to draw them again when it is moved. */
    let edgesAt = new Map<number, EdgeRefs[]>();
    /** Where the layout put the nodes, and how far the user moved them from there. */
    const boxes = new Map<number, LayoutBox>();
    const offsets = new Map<number, { dx: number; dy: number }>();

    const apply = (): void => void ( stage.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})` );

    /** Where the nodes are now: the layout's place plus what the user moved them by. */
    const current = new Map<number, LayoutBox>();
    const refreshBox = ( id: number ): void => {
        const box = boxes.get( id );
        const offset = offsets.get( id );
        if ( box ) {
            current.set( id, offset ? { ...box, x: box.x + offset.dx, y: box.y + offset.dy } : box );
        }
    };

    /** The path of an edge: one curve from the right side of the producer to the left side of the consumer, level where it meets them. */
    const pathOf = ( edge: ViewEdge ): string | undefined => {
        const from = current.get( edge.from );
        const to = current.get( edge.to );
        if ( !from || !to ) {
            return undefined;
        }
        const x1 = from.x + from.w;
        const y1 = from.y + from.h / 2;
        const bend = Math.max( 20, ( to.x - x1 ) / 2 );
        return `M${x1} ${y1}C${x1 + bend} ${y1} ${to.x - bend} ${to.y + to.h / 2} ${to.x} ${to.y + to.h / 2}`;
    };

    /** The nodes connected to `id`, following producers up and consumers down, not sideways. */
    const connected = ( id: number ): Set<number> => {
        const result = new Set<number>( [id] );
        for ( const side of [up, down] ) {
            const stack = [id];
            const seen = new Set<number>( [id] );
            while ( stack.length ) {
                for ( const next of side.get( stack.pop()! ) ?? [] ) {
                    if ( !seen.has( next ) ) {
                        seen.add( next );
                        result.add( next );
                        stack.push( next );
                    }
                }
            }
        }
        return result;
    };

    /** Dims what is not connected to the focus. Only what changes is written to the document. */
    const applyFocus = (): void => {
        const lit = focus === null ? undefined : connected( focus );
        nodeRefs.forEach( ( refs, id ) => {
            const dim = !!lit && !lit.has( id );
            if ( dim !== refs.dim ) {
                refs.dim = dim;
                refs.group.classList.toggle( 'kd-dim', dim );
            }
            const focused = focus === id;
            if ( focused !== refs.focused ) {
                refs.focused = focused;
                refs.group.classList.toggle( 'kd-focused', focused );
            }
        } );
        for ( const refs of edgeRefs ) {
            const dim = !!lit && !( lit.has( refs.edge.from ) && lit.has( refs.edge.to ) );
            if ( dim !== refs.dim ) {
                refs.dim = dim;
                refs.path.classList.toggle( 'kd-dim', dim );
            }
            // The edges at the node in focus stand out, in a layer above the nodes.
            const hot = focus !== null && ( refs.edge.from === focus || refs.edge.to === focus );
            if ( hot !== refs.hot ) {
                refs.hot = hot;
                refs.path.classList.toggle( 'kd-hot', hot );
                refs.path.style.stroke = hot ? 'var(--kp-accent)' : '';
                refs.path.style.strokeWidth = hot ? '2.4' : '';
                refs.path.setAttribute( 'marker-end', hot ? 'url(#kd-arrow-hot)' : 'url(#kd-arrow)' );
                ( hot ? hotLayer : edgeLayer ).append( refs.path );
            }
        }
    };

    const fit = (): void => {
        const w = el.clientWidth;
        const h = el.clientHeight;
        if ( !w || !h || !content.width ) {
            return;
        }
        scale = Math.min( 1, ( w - 16 ) / content.width, ( h - 16 ) / content.height );
        scale = Math.max( MIN_SCALE, scale );
        tx = ( w - content.width * scale ) / 2;
        ty = Math.max( 8, ( h - content.height * scale ) / 2 );
        apply();
    };

    const setClasses = ( target: SVGElement, current: Set<string>, next: readonly string[] ): void => {
        const wanted = new Set( next );
        current.forEach( name => {
            if ( !wanted.has( name ) ) {
                target.classList.remove( name );
                current.delete( name );
            }
        } );
        wanted.forEach( name => {
            if ( !current.has( name ) ) {
                target.classList.add( name );
                current.add( name );
            }
        } );
    };

    const lineClass = ( i: number ): string => ( i === 0 ? 'kd-gname' : i === 1 ? 'kd-gmeta' : 'kd-gvalue' );

    /** Writes the texts of a node, only the ones that differ from what is there. */
    const setLines = ( refs: NodeRefs, node: ViewNode ): void => {
        const max = charsFor( node.box.w );
        node.lines.forEach( ( line, i ) => {
            if ( refs.lines[i] === line ) {
                return;
            }
            refs.lines[i] = line;
            refs.texts[i].textContent = ellipsize( line, max );
            refs.texts[i].style.display = line ? '' : 'none';
        } );
        refs.title.textContent = node.lines.filter( Boolean ).join( '\n' );
    };

    const reroute = ( refs: readonly EdgeRefs[] ): void => {
        for ( const edge of refs ) {
            const d = pathOf( edge.edge );
            if ( d ) {
                edge.path.setAttribute( 'd', d );
            }
        }
    };

    /** Moves a node to where it is now, with the edges at it. The other edges are found anew when the move is over. */
    const placeNode = ( id: number ): void => {
        refreshBox( id );
        const box = current.get( id );
        const refs = nodeRefs.get( id );
        if ( box && refs ) {
            refs.group.setAttribute( 'transform', `translate(${box.x} ${box.y})` );
        }
        reroute( edgesAt.get( id ) ?? [] );
    };

    /** Everything is drawn anew: the nodes or their places changed. */
    const build = ( nodes: readonly ViewNode[], edges: readonly ViewEdge[] ): void => {
        scene.replaceChildren();
        hotLayer.replaceChildren();
        nodeRefs.clear();
        edgeRefs = [];
        up = new Map();
        down = new Map();
        edgesAt = new Map();
        boxes.clear();
        nodes.forEach( n => boxes.set( n.id, n.box ) );
        // What was moved stays moved, as long as the node is there.
        offsets.forEach( ( _, id ) => void ( boxes.has( id ) || offsets.delete( id ) ) );
        current.clear();
        boxes.forEach( ( _, id ) => refreshBox( id ) );
        edgeLayer = svg( 'g' );
        for ( const edge of edges ) {
            const d = pathOf( edge );
            if ( !d ) {
                continue;
            }
            const path = svg( 'path', { d, 'marker-end': 'url(#kd-arrow)', class: 'kd-gedge' } );
            edgeLayer.append( path );
            const refs: EdgeRefs = { edge, path, classes: new Set(), dim: false, hot: false };
            setClasses( path, refs.classes, edge.classes ?? [] );
            edgeRefs.push( refs );
            ( up.get( edge.to ) ?? up.set( edge.to, [] ).get( edge.to )! ).push( edge.from );
            ( down.get( edge.from ) ?? down.set( edge.from, [] ).get( edge.from )! ).push( edge.to );
            for ( const id of [edge.from, edge.to] ) {
                ( edgesAt.get( id ) ?? edgesAt.set( id, [] ).get( id )! ).push( refs );
            }
        }
        scene.append( edgeLayer );
        for ( const node of nodes ) {
            const box = current.get( node.id )!;
            const group = svg( 'g', { transform: `translate(${box.x} ${box.y})`, class: `kd-gnode kd-gk-${node.kind}` } );
            group.dataset.id = String( node.id );
            group.append( svg( 'rect', { width: node.box.w, height: node.box.h, rx: 5 } ) );
            const texts = [0, 1, 2].map( i => svg( 'text', { x: NODE_PADDING, y: 16 + i * 16 }, lineClass( i ) ) );
            const title = svg( 'title' );
            group.append( ...texts, title );
            scene.append( group );
            const refs: NodeRefs = { group, texts, title, classes: new Set(), lines: [], dim: false, focused: false };
            setClasses( group, refs.classes, node.classes ?? [] );
            setLines( refs, node );
            nodeRefs.set( node.id, refs );
        }
        applyFocus();
    };

    /** Only classes and texts changed: the nodes stay where they are, so nothing is rebuilt and a hover is not lost. */
    const update = ( nodes: readonly ViewNode[], edges: readonly ViewEdge[] ): void => {
        for ( const node of nodes ) {
            const refs = nodeRefs.get( node.id );
            if ( refs ) {
                setClasses( refs.group, refs.classes, node.classes ?? [] );
                setLines( refs, node );
            }
        }
        const byKey = new Map( edges.map( e => [`${e.from}>${e.to}`, e] ) );
        for ( const refs of edgeRefs ) {
            const next = byKey.get( `${refs.edge.from}>${refs.edge.to}` );
            setClasses( refs.path, refs.classes, next?.classes ?? [] );
        }
    };

    const draw = ( nodes: readonly ViewNode[], edges: readonly ViewEdge[] ): void => {
        lastNodes = nodes;
        lastEdges = edges;
        const key = nodes.map( n => `${n.id}:${n.kind}:${n.box.x}:${n.box.y}:${n.box.w}` ).join( '|' ) + '#' + edges.map( e => `${e.from}>${e.to}` ).join( ',' );
        if ( key === structure ) {
            update( nodes, edges );
            return;
        }
        structure = key;
        build( nodes, edges );
    };

    // The pointer over a node, and over nothing: one listener for all of them.
    let overId: number | null = null;
    root.addEventListener( 'pointerover', ev => {
        const node = ( ev.target as Element ).closest?.( '.kd-gnode' ) as SVGElement | null;
        const id = node?.dataset.id === undefined ? null : Number( node.dataset.id );
        if ( id !== overId ) {
            overId = id;
            handlers.hover( id );
        }
    } );

    // ------------------------------------------------------------------ pan, move and zoom
    // A press on the background that moves pans the graph; a press on a node that moves moves the node; a press that does not
    // move is a click, taken on release. The pointer is captured only once it is dragging, so that the click is not taken away.
    let drag: { x: number; y: number; tx: number; ty: number; id: number | null; offset: { dx: number; dy: number }; pointer: number } | undefined;
    let dragged = false;
    el.addEventListener( 'pointerdown', ev => {
        if ( ev.button !== 0 ) {
            return;
        }
        const node = ( ev.target as Element ).closest?.( '.kd-gnode' ) as SVGElement | null;
        const id = node?.dataset.id === undefined ? null : Number( node.dataset.id );
        drag = { x: ev.clientX, y: ev.clientY, tx, ty, id, offset: { ...( id === null ? { dx: 0, dy: 0 } : offsets.get( id ) ?? { dx: 0, dy: 0 } ) }, pointer: ev.pointerId };
        dragged = false;
    } );
    el.addEventListener( 'pointermove', ev => {
        if ( !drag ) {
            return;
        }
        const dx = ev.clientX - drag.x;
        const dy = ev.clientY - drag.y;
        if ( !dragged && Math.hypot( dx, dy ) > DRAG_THRESHOLD ) {
            dragged = true;
            el.setPointerCapture?.( drag.pointer );
            // Panning moves a layer of its own; it is not painted again for every step.
            if ( drag.id === null ) {
                stage.classList.add( 'kd-panning' );
            }
        }
        if ( !dragged ) {
            return;
        }
        if ( drag.id === null ) {
            moved = true;
            tx = drag.tx + dx;
            ty = drag.ty + dy;
            apply();
        } else {
            offsets.set( drag.id, { dx: drag.offset.dx + dx / scale, dy: drag.offset.dy + dy / scale } );
            placeNode( drag.id );
        }
    } );
    const release = ( click: boolean ): void => {
        const pressed = drag;
        const wasDragged = dragged;
        drag = undefined;
        dragged = false;
        stage.classList.remove( 'kd-panning' );
        if ( pressed && !wasDragged && click ) {
            handlers.click( pressed.id );
        }
        // Where a node was left, other edges may now pass through it.
        if ( pressed && wasDragged && pressed.id !== null ) {
            reroute( edgeRefs );
        }
    };
    el.addEventListener( 'pointerup', () => release( true ) );
    el.addEventListener( 'pointercancel', () => release( false ) );
    el.addEventListener( 'wheel', ev => {
        ev.preventDefault();
        const rect = el.getBoundingClientRect();
        const px = ev.clientX - rect.left;
        const py = ev.clientY - rect.top;
        const next = Math.min( MAX_SCALE, Math.max( MIN_SCALE, scale * ( ev.deltaY < 0 ? 1.15 : 1 / 1.15 ) ) );
        // The point under the pointer stays where it is.
        tx = px - ( px - tx ) * ( next / scale );
        ty = py - ( py - ty ) * ( next / scale );
        scale = next;
        moved = true;
        apply();
    }, { passive: false } );
    el.addEventListener( 'pointerleave', () => {
        overId = null;
        handlers.hover( null );
    } );

    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver( () => void ( moved || fit() ) );
    observer?.observe( el );

    return {
        el,
        set( nodes, edges, size ) {
            const first = !content.width;
            content = size;
            root.setAttribute( 'width', String( size.width ) );
            root.setAttribute( 'height', String( size.height ) );
            draw( nodes, edges );
            if ( first || !moved ) {
                fit();
            }
        },
        fit() {
            moved = false;
            fit();
        },
        get moved() {
            return moved;
        },
        setFocus( id ) {
            focus = id;
            applyFocus();
        },
        arrange() {
            if ( !offsets.size ) {
                return;
            }
            offsets.clear();
            structure = '';
            draw( lastNodes, lastEdges );
        },
        dispose() {
            observer?.disconnect();
        }
    };
}
