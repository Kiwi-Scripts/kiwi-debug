import { describeElement } from '@kiwi-js/dom';
import { button, div, span, type HotkeyBinding, type PanelContext, type PanelDefinition } from '@kiwi-js/panels';

import type { ReactiveNode, Unit } from '../../adapter/types';
import { logGroup } from '../../core/console';
import { ICONS } from '../../core/icons';
import { startPick } from '../../core/pick';
import { safe } from '../../core/safe';
import type { DebugContext, DebugFeature, FeatureInstance, ListenerTuple } from '../../core/types';
import { preview } from '../../core/format';
import { layoutGraph, type GraphLayout } from './layout';
import { buildGraph, elementsOf, indexOwners, stateOf, type Direction, type Graph, type Owners } from './model';
import {
    changesOf, createOrigins, createRecorder, locationOf, MAX_GAP_MS, stateAt, timelineLines,
    type Origins, type Recorder, type Timeline
} from './recorder';
import { createGraphView, type GraphView, type ViewEdge, type ViewNode } from './view';

/** What the graph is about. */
export type GraphTarget =
    | { element: Element }
    | { directive: Unit }
    | { owner: Unit; name: string; read(): unknown };

/** The graph is built again from the roots at most this often while recording. */
const REBUILD_MS = 100;
/** The page is searched for owners at most this often. */
const SCAN_MS = 1000;
/** In a live view, every Nth refresh looks for new dependencies. */
const REBUILD_EVERY = 5;
const IDLE_POLL_MS = 250;
/** How long a node that was written shows it. */
const PULSE_MS = 700;
const RECORD_POLL_MS = 40;
const SPEEDS = [0.25, 1, 4, 16] as const;

const isTarget = ( value: unknown ): value is GraphTarget =>
    typeof value === 'object' && value !== null && ( 'element' in value || 'directive' in value || 'owner' in value );

const edgeId = ( from: number, to: number ): string => `${from}>${to}`;

function setup( ctx: DebugContext ): FeatureInstance {
    const { overlay, adapter } = ctx;
    const reactivity = adapter.reactivity!;
    const runOutside = <T>( fn: () => T ): T => adapter.env.runOutside ? adapter.env.runOutside( fn ) : fn();
    const panel = () => overlay.panels.get( 'graph' );

    // ------------------------------------------------------------------ state that outlives the panel
    let target: GraphTarget | undefined;
    let direction: Direction = 'both';
    let recorder: Recorder | undefined;
    let origins: Origins | undefined;
    let timeline: Timeline | undefined;
    let recordTimer: ReturnType<typeof setInterval> | undefined;
    let stopRender: ( () => void ) | undefined;
    let pointer = { x: 0, y: 0 };
    let picking: ( () => void ) | undefined;
    const recording = (): boolean => !!recorder && !timeline;

    // ------------------------------------------------------------------ the graph
    let owners: Owners = new Map();
    let ownersAt = 0;
    const scan = ( force = false ): void => {
        if ( force || Date.now() - ownersAt > SCAN_MS ) {
            owners = indexOwners( ctx );
            ownersAt = Date.now();
        }
    };

    const rootsOfUnit = ( unit: Unit, element: Element | null ): ReactiveNode[] => {
        const found = new Set<ReactiveNode>();
        for ( const row of ctx.rowsOf( unit ) ) {
            const node = row.category === 'form' ? undefined : safe( () => reactivity.nodeOf( row.read() ) );
            if ( node ) {
                found.add( node );
            }
        }
        const description = safe( () => adapter.units.describe( unit ) );
        const host = element ?? description?.element ?? null;
        if ( host && description?.kind === 'component' ) {
            const template = safe( () => reactivity.renderNodeOf?.( host ) );
            if ( template ) {
                found.add( template );
            }
        }
        return Array.from( found );
    };

    const resolveRoots = (): ReactiveNode[] => {
        if ( !target ) {
            return [];
        }
        if ( 'element' in target ) {
            const el = target.element;
            const found = new Set<ReactiveNode>();
            for ( const unit of safe( () => adapter.units.at( el ) ) ?? [] ) {
                rootsOfUnit( unit, el ).forEach( node => found.add( node ) );
            }
            const template = safe( () => reactivity.renderNodeOf?.( el ) );
            if ( template ) {
                found.add( template );
            }
            return Array.from( found );
        }
        if ( 'directive' in target ) {
            return rootsOfUnit( target.directive, null );
        }
        const node = safe( () => reactivity.nodeOf( target && 'read' in target ? target.read() : undefined ) );
        return node ? [node] : [];
    };

    const titleOf = (): string => {
        if ( !target ) {
            return 'Signal graph';
        }
        if ( 'element' in target ) {
            return `Signal graph · ${describeElement( target.element )}`;
        }
        const unit = 'directive' in target ? target.directive : target.owner;
        const name = safe( () => adapter.units.describe( unit ).name ) ?? '?';
        return 'directive' in target ? `Signal graph · ${name}` : `Signal graph · ${name}.${target.name}`;
    };

    const linesOf = ( n: Graph['nodes'][number] ): string[] => [
        n.name, n.context ? `${n.kind} · ${n.context}` : n.kind,
        n.valueText !== undefined ? `v${n.version} = ${n.valueText}` : n.runs ? `${n.runs}× run` : ''
    ];

    // ------------------------------------------------------------------ the panel
    let pc: PanelContext | undefined;
    let view: GraphView | undefined;
    let note: HTMLElement | undefined;
    let toolbar: { direction: Record<Direction, HTMLButtonElement>; fit: HTMLButtonElement; arrange: HTMLButtonElement; pick: HTMLButtonElement } | undefined;
    /** In the header, so that it stays in reach when the panel is folded during a recording. */
    let recordButton: HTMLButtonElement | undefined;
    let replayBox: HTMLElement | undefined;
    let idle: ReturnType<typeof setInterval> | undefined;

    let graph: Graph | undefined;
    let layout: GraphLayout | undefined;
    let refreshes = 0;
    let drawn = '';
    let lastRebuild = 0;
    let pinned: number | null = null;
    let hovered: number | null = null;
    /** The version and run count each node had when it was drawn last, to let the ones written since pulse. */
    let seen = new Map<number, string>();

    /** The nodes of the graph by id, and the element each one is shown for (worked out when it is first hovered). */
    let byId = new Map<number, Graph['nodes'][number]>();
    const elementOfNode = new Map<number, Element | null>();
    let pulseTimer: ReturnType<typeof setTimeout> | undefined;

    /**
     * Builds the graph again from its roots. The page is searched for owners only when asked to (`rescan`): that walks every
     * element, which is far too much for something that runs several times a second.
     */
    const rebuild = ( rescan = false ): void => {
        if ( rescan || !owners.size ) {
            scan( true );
        }
        graph = buildGraph( resolveRoots(), direction, owners );
        byId = new Map( graph.nodes.map( n => [n.id, n] ) );
        elementOfNode.clear();
        lastRebuild = Date.now();
    };

    /** Reads what can change without a rebuild: version, dirty flag and run count. A value is read only when its version changed. */
    const readStates = ( g: Graph ): void => {
        for ( const n of g.nodes ) {
            const state = stateOf( n.node );
            if ( n.valueText !== undefined && state.version !== n.version ) {
                n.valueText = safe( () => preview( n.node.peek() ) );
            }
            Object.assign( n, state );
        }
    };

    const setFocus = (): void => view?.setFocus( pinned ?? hovered );

    const draw = (): void => {
        if ( !view || !graph || !layout ) {
            return;
        }
        const g = graph;
        const l = layout;
        const nextSeen = new Map<number, string>();
        const nodes: ViewNode[] = g.nodes.map( n => {
            const stamp = `${n.version}:${n.runs}`;
            nextSeen.set( n.id, stamp );
            const classes: string[] = [];
            if ( n.root ) {
                classes.push( 'kd-root' );
            }
            // A derived node nobody read keeps its old value: it needs an update.
            if ( n.dirty ) {
                classes.push( 'kd-dashed' );
            }
            if ( seen.size && seen.get( n.id ) !== undefined && seen.get( n.id ) !== stamp ) {
                classes.push( 'kd-pulse' );
            }
            return { id: n.id, box: l.boxes.get( n.id )!, lines: linesOf( n ), kind: n.kind, classes };
        } );
        seen = nextSeen;
        view.set( nodes, g.edges, { width: l.width, height: l.height } );
        setFocus();
        // What pulsed is drawn plain again a moment later.
        if ( pulseTimer === undefined && nodes.some( n => n.classes?.includes( 'kd-pulse' ) ) ) {
            pulseTimer = setTimeout( () => {
                pulseTimer = undefined;
                if ( view && graph ) {
                    draw();
                }
            }, PULSE_MS );
        }
    };

    /** What shows the graph again if it changed: the ids and states, and the shape. */
    const signatureOf = ( g: Graph ): string =>
        g.nodes.map( n => `${n.id}:${n.version}:${n.dirty ? 1 : 0}:${n.runs}` ).join( ',' ) + '|' + g.edges.map( e => edgeId( e.from, e.to ) ).join( ',' );

    const showNote = (): void => {
        if ( !note ) {
            return;
        }
        if ( !target ) {
            note.textContent = `Hold ${ctx.options.key} and press G over an element, or use ⌖ Pick.`;
        } else if ( graph && !graph.nodes.length ) {
            note.textContent = 'No reactive values here.';
        } else if ( graph?.truncated ) {
            note.textContent = 'The graph is cut off: only the first 250 nodes are shown.';
        } else {
            note.textContent = '';
        }
    };

    const liveRefresh = ( force = false ): void => {
        if ( !view || timeline || recording() ) {
            return;
        }
        if ( !target ) {
            showNote();
            return;
        }
        refreshes++;
        if ( force || !graph || refreshes % REBUILD_EVERY === 0 ) {
            const before = graph ? signatureOf( graph ) : '';
            rebuild( force );
            // New nodes may belong to units that were not there when the page was searched last.
            if ( !force && signatureOf( graph! ) !== before && Date.now() - ownersAt > SCAN_MS ) {
                rebuild( true );
            }
        } else {
            readStates( graph );
        }
        // Nothing is laid out or drawn unless something changed.
        const signature = signatureOf( graph! );
        if ( !force && signature === drawn ) {
            return;
        }
        drawn = signature;
        layout = layoutGraph( graph!.nodes.map( n => ( { id: n.id, lines: linesOf( n ) } ) ), graph!.edges );
        draw();
        showNote();
    };

    // ------------------------------------------------------------------ node interaction
    const onHover = ( id: number | null ): void => {
        hovered = id;
        setFocus();
        let element: Element | null = null;
        if ( id !== null && !timeline && byId.has( id ) ) {
            if ( !elementOfNode.has( id ) ) {
                elementOfNode.set( id, elementsOf( byId.get( id )!.node, owners )[0] ?? null );
            }
            element = elementOfNode.get( id )!;
        }
        ctx.highlightHover( element );
    };

    const onClick = ( id: number | null ): void => {
        pinned = id === pinned ? null : id;
        setFocus();
        const entry = id === null || timeline ? undefined : byId.get( id );
        if ( !entry ) {
            return;
        }
        const peek = safe( () => entry.node.peek() );
        logGroup( `${entry.name}${entry.context ? ` (${entry.context})` : ''}`, [
            ['kind', entry.kind], ['value', entry.valueText === undefined ? undefined : peek],
            ['owner', entry.owner?.unit], ['element', entry.owner?.element ?? undefined],
            ['producers', safe( () => entry.node.producers() )], ['consumers', safe( () => entry.node.consumers() )]
        ] );
    };

    // ------------------------------------------------------------------ recording
    const known = new Set<ReactiveNode>();
    let lastCaptureGraph = 0;

    /** The shape of the graph at the last rebuild; looking at every edge on each capture would cost more than the capture. */
    let recordedStructure = '';

    const capture = (): void => {
        if ( !recorder || !target ) {
            return;
        }
        if ( !graph || Date.now() - lastRebuild >= REBUILD_MS || !lastCaptureGraph ) {
            const before = recordedStructure;
            rebuild();
            recordedStructure = graph!.edges.map( e => edgeId( e.from, e.to ) ).join( ',' );
            // New nodes may belong to units that were not there when the page was searched last (at most once a second).
            if ( lastCaptureGraph && recordedStructure !== before && Date.now() - ownersAt > SCAN_MS ) {
                rebuild( true );
            }
            lastCaptureGraph = Date.now();
            known.clear();
            graph!.nodes.forEach( n => known.add( n.node ) );
        } else {
            readStates( graph );
        }
        recorder.capture( graph!, recordedStructure, origins!.take() );
        if ( recorder.limited ) {
            stopRecording();
        }
    };

    /** Folds the panel and puts it at the top center of the viewport. It unfolds in the same place. */
    const park = (): void => {
        const handle = panel();
        if ( !handle ) {
            return;
        }
        const width = handle.element.getBoundingClientRect().width || definition.size?.width || 640;
        handle.moveTo( { left: Math.max( 8, Math.round( ( window.innerWidth - width ) / 2 ) ), top: 8 } );
        handle.setCollapsed( true );
    };

    const startRecording = (): void => {
        if ( !target || recording() ) {
            return;
        }
        stopPlayback();
        timeline = undefined;
        replayBox?.replaceChildren();
        pc?.body.classList.remove( 'kd-replaying' );
        recorder = createRecorder();
        origins = createOrigins( ctx, node => known.has( node ) );
        scan( true );
        lastCaptureGraph = 0;
        origins.start();
        capture();
        recordTimer = runOutside( () => setInterval( capture, RECORD_POLL_MS ) );
        stopRender = adapter.env.onRender?.( capture, ctx.options.scope );
        // The panel folds up at the top center and nothing is drawn while recording; the graph is drawn again in the replay.
        park();
        pc?.setTitle( titleOf().replace( 'Signal graph', '● Recording' ) );
        updateToolbar();
        pc?.updateTray();
    };

    function stopRecording(): void {
        if ( !recorder || timeline ) {
            return;
        }
        if ( recordTimer !== undefined ) {
            runOutside( () => clearInterval( recordTimer ) );
        }
        recordTimer = undefined;
        stopRender?.();
        stopRender = undefined;
        capture();
        origins?.stop();
        origins = undefined;
        timeline = recorder.compile();
        panel()?.setCollapsed( false );
        pc?.setTitle( titleOf() );
        showReplay();
        updateToolbar();
        pc?.updateTray();
    }

    function leaveReplay(): void {
        stopPlayback();
        timeline = undefined;
        recorder = undefined;
        replayBox?.replaceChildren();
        pc?.body.classList.remove( 'kd-replaying' );
        liveRefresh( true );
        updateToolbar();
    }

    // ------------------------------------------------------------------ replay
    let frame = 0;
    let speedIndex = 1;
    let playing: ReturnType<typeof setTimeout> | undefined;
    let replayParts: { label: HTMLElement; slider: HTMLInputElement; play: HTMLButtonElement; list: HTMLElement } | undefined;

    function stopPlayback(): void {
        if ( playing !== undefined ) {
            clearTimeout( playing );
            playing = undefined;
        }
        replayParts?.play && ( replayParts.play.textContent = '▶' );
    }

    function drawFrame(): void {
        if ( !timeline || !view || !replayParts ) {
            return;
        }
        const t = timeline;
        const state = stateAt( t, frame );
        const changed = frame > 0 ? t.frames[frame].changed : new Map();
        const nodes: ViewNode[] = Array.from( t.nodes.values(), info => {
            const nodeState = state.nodes.get( info.id );
            const classes: string[] = [];
            if ( !nodeState ) {
                classes.push( 'kd-faded' );
            } else {
                if ( changed.has( info.id ) ) {
                    classes.push( 'kd-changed' );
                }
                if ( nodeState.dirty ) {
                    classes.push( 'kd-dashed' );
                }
            }
            return { id: info.id, box: t.layout.boxes.get( info.id )!, lines: timelineLines( t, info.id, nodeState ), kind: info.kind, classes };
        } );
        const edges: ViewEdge[] = t.graph.edges.map( e => ( { ...e, classes: state.edges.has( edgeId( e.from, e.to ) ) ? [] : ['kd-faded'] } ) );
        view.set( nodes, edges, t.size );

        const current = t.frames[frame];
        replayParts.label.textContent = `${frame + 1} / ${t.frames.length} · ${Math.round( current?.time ?? 0 )} ms${t.limited ? ' · stopped at the limit' : ''}`;
        replayParts.slider.value = String( frame );
        const lines = changesOf( t, frame );
        const rows = lines.map( line => {
            const row = div( 'kp-row kd-gline' );
            row.append( span( '', line.text ) );
            if ( line.cause ) {
                const cause = line.cause;
                const where = locationOf( cause, adapter.env.internalFrames );
                const label = span( 'kp-muted kp-link', `← ${cause.trigger}`, where ? `${where}\n(click to log the whole stack)` : 'no stack available' );
                label.onclick = () => logGroup( `Cause of ${line.text}`, [['trigger', cause.trigger], ['stack', cause.error?.stack]] );
                row.append( ' ', label );
            } else if ( line.via ) {
                row.append( ' ', span( 'kp-muted', `via ${line.via}` ) );
            }
            return row;
        } );
        replayParts.list.replaceChildren( ...( rows.length ? rows : [div( 'kp-muted', frame === 0 ? 'The state when the recording began.' : 'Nothing changed.' )] ) );
    }

    function goTo( next: number ): void {
        if ( !timeline ) {
            return;
        }
        frame = Math.min( timeline.frames.length - 1, Math.max( 0, next ) );
        drawFrame();
    }

    function play(): void {
        if ( !timeline ) {
            return;
        }
        if ( playing !== undefined ) {
            stopPlayback();
            return;
        }
        if ( frame >= timeline.frames.length - 1 ) {
            frame = 0;
        }
        replayParts!.play.textContent = '⏸';
        const step = (): void => {
            if ( !timeline ) {
                return;
            }
            drawFrame();
            if ( frame >= timeline.frames.length - 1 ) {
                stopPlayback();
                return;
            }
            const gap = Math.min( MAX_GAP_MS, timeline.frames[frame + 1].time - timeline.frames[frame].time );
            playing = setTimeout( () => {
                frame++;
                step();
            }, gap / SPEEDS[speedIndex] );
        };
        step();
    }

    function showReplay(): void {
        if ( !timeline || !replayBox ) {
            return;
        }
        pc?.body.classList.add( 'kd-replaying' );
        frame = 0;
        const label = span( 'kp-muted kd-replay-label', '' );
        const slider = document.createElement( 'input' );
        slider.type = 'range';
        slider.min = '0';
        slider.max = String( Math.max( 0, timeline.frames.length - 1 ) );
        slider.value = '0';
        slider.className = 'kd-scrub';
        slider.oninput = () => {
            stopPlayback();
            goTo( Number( slider.value ) );
        };
        const playButton = button( '▶', 'Play', () => play(), { mini: true } );
        const speed = button( `${SPEEDS[speedIndex]}×`, 'Playback speed', () => {
            speedIndex = ( speedIndex + 1 ) % SPEEDS.length;
            speed.textContent = `${SPEEDS[speedIndex]}×`;
        }, { mini: true } );
        const controls = div( 'kp-row kd-replay-controls' );
        controls.append(
            button( '‹', 'Previous change', () => { stopPlayback(); goTo( frame - 1 ); }, { mini: true } ),
            playButton, speed,
            button( '›', 'Next change', () => { stopPlayback(); goTo( frame + 1 ); }, { mini: true } ),
            slider, label,
            button( 'Live', 'Leave the replay', () => leaveReplay(), { mini: true } ) );
        const list = div( 'kd-replay-list' );
        const splitter = div( 'kd-splitter' );
        splitter.title = 'Drag to resize the list';
        splitter.onpointerdown = down => {
            down.preventDefault();
            const start = { y: down.clientY, height: list.offsetHeight };
            const move = ( ev: PointerEvent ): void => {
                list.style.height = `${Math.max( 60, Math.min( ( pc?.body.clientHeight ?? 600 ) - 140, start.height + start.y - ev.clientY ) )}px`;
            };
            const up = (): void => {
                window.removeEventListener( 'pointermove', move );
                window.removeEventListener( 'pointerup', up );
            };
            window.addEventListener( 'pointermove', move );
            window.addEventListener( 'pointerup', up );
        };
        replayParts = { label, slider, play: playButton, list };
        replayBox.replaceChildren( splitter, controls, list );
        graph = undefined;
        drawFrame();
    }

    // ------------------------------------------------------------------ toolbar and picking
    const updateToolbar = (): void => {
        if ( !toolbar ) {
            return;
        }
        for ( const key of ['up', 'both', 'down'] as const ) {
            toolbar.direction[key].classList.toggle( 'kp-on', direction === key );
            toolbar.direction[key].disabled = !!timeline || recording();
        }
        toolbar.pick.disabled = recording();
        if ( recordButton ) {
            recordButton.textContent = recording() ? '■ Stop' : '● Rec';
            recordButton.title = `${recording() ? 'Stop the recording and replay it' : 'Record the changes of this graph'} (${ctx.options.key} + Shift + G)`;
            recordButton.classList.toggle( 'kp-on', recording() );
            recordButton.disabled = !target && !recording();
        }
    };

    const setDirection = ( next: Direction ): void => {
        direction = next;
        updateToolbar();
        liveRefresh( true );
    };

    const stopPicking = (): void => {
        picking?.();
        picking = undefined;
    };

    const beginPick = (): void => {
        stopPicking();
        const handle = panel();
        if ( handle ) {
            picking = startPick( ctx, { hide: handle.element, onPick: el => open( { element: el } ), onEnd: () => void ( picking = undefined ) } );
        }
    };

    // ------------------------------------------------------------------ opening
    function open( next?: GraphTarget ): void {
        const handle = panel();
        if ( !handle ) {
            return;
        }
        handle.open( next );
    }

    const retarget = ( next: GraphTarget ): void => {
        if ( recording() ) {
            stopRecording();
        }
        if ( timeline ) {
            stopPlayback();
            timeline = undefined;
            recorder = undefined;
            replayBox?.replaceChildren();
            pc?.body.classList.remove( 'kd-replaying' );
        }
        target = next;
        graph = undefined;
        drawn = '';
        pinned = null;
        hovered = null;
        seen = new Map();
        view?.arrange();
        pc?.setTitle( titleOf() );
        updateToolbar();
        liveRefresh( true );
    };

    const definition: PanelDefinition = {
        id: 'graph',
        title: 'Signal graph',
        icon: ICONS.GRAPH,
        hotkey: 'KeyG',
        className: 'kd-graph-panel',
        size: { width: 640, height: 480 },
        minSize: { width: 360, height: 240 },
        fullscreenable: true,
        defaultPosition: { at: 'top-right', stack: ['left', 'down'] },
        mount( context ) {
            pc = context;
            const root = div( 'kd-graph' );
            view = createGraphView( { hover: onHover, click: onClick } );
            note = div( 'kp-muted kd-graph-note' );
            const directionButton = ( key: Direction, text: string, title: string ): HTMLButtonElement => button( text, title, () => setDirection( key ), { mini: true } );
            const row = div( 'kp-row kd-graph-tools' );
            toolbar = {
                direction: {
                    up: directionButton( 'up', '←', 'What the values read' ),
                    both: directionButton( 'both', '↔', 'What they read and what reads them' ),
                    down: directionButton( 'down', '→', 'What reads the values' )
                },
                fit: button( 'Fit', 'Fit the graph into the panel', () => view?.fit(), { mini: true } ),
                arrange: button( 'Arrange', 'Put the nodes that were moved back where the layout has them', () => view?.arrange(), { mini: true } ),
                pick: button( '⌖ Pick', 'Pick an element on the page', () => beginPick(), { mini: true } )
            };
            row.append( toolbar.direction.up, toolbar.direction.both, toolbar.direction.down, toolbar.fit, toolbar.arrange, toolbar.pick );
            recordButton = button( '● Rec', '', () => ( recording() ? stopRecording() : startRecording() ), { mini: true } );
            context.setHeaderRight( [recordButton] );
            replayBox = div( 'kd-replay' );
            root.append( row, note, view.el, legend(), replayBox );
            updateToolbar();
            return {
                content: root,
                onShow( args ) {
                    const next = args instanceof Element ? { element: args } : isTarget( args ) ? args : undefined;
                    if ( next ) {
                        retarget( next );
                    } else if ( timeline && replayBox && !replayBox.childElementCount ) {
                        showReplay();
                    } else {
                        pc?.setTitle( titleOf() );
                        liveRefresh( true );
                    }
                    showNote();
                    idle ??= runOutside( () => setInterval( () => liveRefresh(), IDLE_POLL_MS ) );
                },
                // The first close of a recording only stops it; the replay shows in its place.
                beforeClose() {
                    if ( recording() ) {
                        stopRecording();
                        return false;
                    }
                },
                onHide() {
                    stopPicking();
                    clearTimeout( pulseTimer );
                    pulseTimer = undefined;
                    if ( recording() ) {
                        stopRecording();
                    }
                    stopPlayback();
                    ctx.highlightHover( null );
                    if ( idle !== undefined ) {
                        runOutside( () => clearInterval( idle ) );
                        idle = undefined;
                    }
                },
                refresh: () => liveRefresh(),
                // A recording that is minimized keeps running, and the tray button says so.
                isActive: () => recording(),
                dispose() {
                    view?.dispose();
                    view = undefined;
                    note = undefined;
                    toolbar = undefined;
                    recordButton = undefined;
                    replayBox = undefined;
                    replayParts = undefined;
                    pc = undefined;
                    graph = undefined;
                    drawn = '';
                }
            };
        }
    };

    /** What the colors and lines of the nodes mean. */
    const legend = (): HTMLElement => {
        const box = div( 'kd-graph-legend' );
        const item = ( swatch: string, text: string, title: string ): HTMLElement => {
            const el = div( 'kd-lg-item' );
            el.title = title;
            el.append( span( `kd-lg-swatch ${swatch}`, '' ), span( 'kp-muted', text ) );
            return el;
        };
        box.append(
            item( 'kd-lg-signal', 'signal', 'A value that is written to' ),
            item( 'kd-lg-computed', 'computed', 'A value derived from others' ),
            item( 'kd-lg-effect', 'effect, template', 'Runs again when something it read has changed' ),
            item( 'kd-lg-other', 'other', 'Any other kind of node' ),
            item( 'kd-lg-dashed', 'needs update', 'Not read since a producer changed: it shows an old value' ),
            item( 'kd-lg-root', 'start', 'Where the graph starts' ) );
        return box;
    };

    // ------------------------------------------------------------------ hotkeys
    const elementUnderCursor = (): Element | null => {
        const raw = document.elementFromPoint( pointer.x, pointer.y );
        return raw && !overlay.inOverlay( raw ) ? ctx.findParent( raw, true ) : null;
    };

    const hotkeys: HotkeyBinding[] = [
        {
            combo: 'KeyG',
            handler: () => {
                const handle = panel();
                if ( !handle ) {
                    return false;
                }
                if ( recording() ) {
                    stopRecording();
                    return true;
                }
                const el = ctx.inspectedElement() ?? elementUnderCursor();
                const current = target && 'element' in target ? target.element : null;
                if ( handle.state === 'open' ) {
                    // Again over the same element, or over nothing, closes it.
                    if ( !el || el === current ) {
                        handle.close();
                    } else {
                        handle.open( { element: el } );
                    }
                } else {
                    handle.open( el ? { element: el } : undefined );
                }
                return true;
            }
        },
        {
            // Starts a recording at once, over the element under the pointer; again, it stops it.
            combo: 'Shift+KeyG',
            handler: () => {
                const handle = panel();
                if ( !handle ) {
                    return false;
                }
                if ( recording() ) {
                    stopRecording();
                    return true;
                }
                const el = ctx.inspectedElement() ?? elementUnderCursor();
                const current = target && 'element' in target ? target.element : null;
                if ( handle.state !== 'open' || ( el && el !== current ) ) {
                    handle.open( el ? { element: el } : undefined );
                }
                startRecording();
                return true;
            }
        },
        {
            combo: 'Escape', modifier: false, allowWhileEditing: true,
            handler: () => {
                if ( picking ) {
                    stopPicking();
                    return true;
                }
                if ( recording() ) {
                    stopRecording();
                    return true;
                }
                return false;
            }
        }
    ];

    const track = ( ev: PointerEvent ): void => {
        pointer = { x: ev.clientX, y: ev.clientY };
    };
    const listeners: ListenerTuple[] = [[document, 'pointermove', track, true]];

    return {
        panel: definition,
        hotkeys,
        listeners,
        isActive: recording,
        dispose() {
            stopPicking();
            if ( recordTimer !== undefined ) {
                runOutside( () => clearInterval( recordTimer ) );
            }
            stopRender?.();
            origins?.stop();
            if ( idle !== undefined ) {
                runOutside( () => clearInterval( idle ) );
            }
            stopPlayback();
        }
    };
}

export const graphFeature: DebugFeature = { id: 'graph', requires: ['reactivity'], setup };
