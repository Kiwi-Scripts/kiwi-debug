import { describeElement } from '@kiwi-js/dom';

import type { ReactiveNode } from '../../adapter/types';
import type { DebugContext } from '../../core/types';
import { layoutGraph, type GraphLayout } from './layout';
import { edgeKey, idOf, type Graph, type GraphEdge } from './model';

export const MAX_FRAMES = 5000;
/** In a replay, a pause longer than this is shortened to it. */
export const MAX_GAP_MS = 600;
const MAX_PENDING_CAUSES = 200;
const STACK_LIMIT = 25;

/** What a recording remembers of a node at one moment. */
export interface NodeState {
    version: number;
    dirty: boolean;
    runs: number;
    value?: string;
}

/** What is known of a node that does not change: how it is drawn and named. */
export interface NodeInfo {
    id: number;
    kind: string;
    name: string;
    context: string;
}

/** What made a node change: the event or task it was written in, and where in the code. */
export interface Cause {
    trigger: string;
    /** Carries the stack (V8 only); formatted when somebody asks for it. */
    error?: Error;
}

/** One step of a recording. It holds only what differs from the step before. */
export interface Frame {
    time: number;
    changed: Map<number, NodeState>;
    gone: number[];
    edgesAdded: string[];
    edgesRemoved: string[];
    causes?: Map<number, Cause>;
}

export interface Timeline {
    startedAt: number;
    frames: Frame[];
    /** Every node and edge seen during the recording. */
    graph: { nodes: NodeInfo[]; edges: GraphEdge[] };
    layout: GraphLayout;
    size: { width: number; height: number };
    nodes: Map<number, NodeInfo>;
    /** The recording stopped by itself because it reached {@link MAX_FRAMES}. */
    limited: boolean;
}

export interface Recorder {
    /**
     * Stores what differs from the last capture, if anything. A node differs if it is new or its version, dirty flag or run count
     * changed. Edges are compared only when a structure signature is passed and differs from the last one. Returns `false`, and
     * stores nothing, if there is no difference (or the recording is full).
     */
    capture( graph: Graph, structure?: string, causes?: ReadonlyMap<number, Cause> ): boolean;
    readonly frameCount: number;
    readonly limited: boolean;
    compile(): Timeline;
}

/** The lines a node shows in a replay: its name, kind and context, and the widest of the values it had. */
const linesOf = ( info: NodeInfo, widest: string ): string[] => [info.name, info.context ? `${info.kind} · ${info.context}` : info.kind, widest];

export function createRecorder( now: () => number = () => performance.now() ): Recorder {
    const startedAt = now();
    const frames: Frame[] = [];
    const last = new Map<number, NodeState>();
    const infos = new Map<number, NodeInfo>();
    const everEdges = new Map<string, GraphEdge>();
    const widest = new Map<number, string>();
    let lastEdges = new Set<string>();
    let lastStructure: string | undefined;
    let limited = false;

    const widen = ( id: number, state: NodeState ): void => {
        const text = `v${state.version}${state.value === undefined ? '' : ` = ${state.value}`}`;
        if ( text.length > ( widest.get( id )?.length ?? 0 ) ) {
            widest.set( id, text );
        }
    };

    return {
        capture( graph, structure, causes ) {
            if ( limited ) {
                return false;
            }
            const changed = new Map<number, NodeState>();
            const present = new Set<number>();
            for ( const node of graph.nodes ) {
                present.add( node.id );
                const state: NodeState = { version: node.version, dirty: node.dirty, runs: node.runs, value: node.valueText };
                const before = last.get( node.id );
                if ( !before || before.version !== state.version || before.dirty !== state.dirty || before.runs !== state.runs ) {
                    changed.set( node.id, state );
                }
            }
            const gone = Array.from( last.keys() ).filter( id => !present.has( id ) );

            let edgesAdded: string[] = [];
            let edgesRemoved: string[] = [];
            let edges = lastEdges;
            if ( !frames.length || ( structure !== undefined && structure !== lastStructure ) ) {
                edges = new Set( graph.edges.map( e => edgeKey( e.from, e.to ) ) );
                edgesAdded = Array.from( edges ).filter( key => !lastEdges.has( key ) );
                edgesRemoved = Array.from( lastEdges ).filter( key => !edges.has( key ) );
            }
            if ( !changed.size && !gone.length && !edgesAdded.length && !edgesRemoved.length ) {
                lastStructure = structure ?? lastStructure;
                return false;
            }

            const frame: Frame = { time: now() - startedAt, changed, gone, edgesAdded, edgesRemoved };
            const kept = new Map<number, Cause>();
            for ( const id of changed.keys() ) {
                const cause = causes?.get( id );
                if ( cause ) {
                    kept.set( id, cause );
                }
            }
            if ( kept.size ) {
                frame.causes = kept;
            }
            for ( const node of graph.nodes ) {
                if ( !infos.has( node.id ) ) {
                    infos.set( node.id, { id: node.id, kind: node.kind, name: node.name, context: node.context } );
                }
            }
            for ( const [id, state] of changed ) {
                widen( id, state );
                last.set( id, state );
            }
            gone.forEach( id => last.delete( id ) );
            for ( const edge of graph.edges ) {
                everEdges.set( edgeKey( edge.from, edge.to ), edge );
            }
            lastEdges = edges;
            lastStructure = structure ?? lastStructure;
            frames.push( frame );
            if ( frames.length >= MAX_FRAMES ) {
                limited = true;
            }
            return true;
        },
        get frameCount() {
            return frames.length;
        },
        get limited() {
            return limited;
        },
        compile() {
            const nodes = Array.from( infos.values() );
            const edges = Array.from( everEdges.values() );
            // All that was ever seen is laid out once, so that nothing moves during the replay.
            const layout = layoutGraph( nodes.map( info => ( { id: info.id, lines: linesOf( info, widest.get( info.id ) ?? '' ) } ) ), edges );
            return { startedAt, frames, graph: { nodes, edges }, layout, size: { width: layout.width, height: layout.height }, nodes: infos, limited };
        }
    };
}

/** The lines of a node of a timeline, with the widest of its values; the layout measured the same. */
export const timelineLines = ( timeline: Timeline, id: number, state?: NodeState ): string[] => {
    const info = timeline.nodes.get( id );
    if ( !info ) {
        return [];
    }
    const text = state ? `v${state.version}${state.value === undefined ? '' : ` = ${state.value}`}` : '';
    return [info.name, info.context ? `${info.kind} · ${info.context}` : info.kind, text];
};

/** The state of the graph after frame `index`: which nodes exist, what they were, and which edges. */
export interface ReplayState {
    nodes: Map<number, NodeState>;
    edges: Set<string>;
}

/** Every this many frames the state is kept, so that a frame is reached from the nearest one before it. */
const CHECKPOINT_EVERY = 64;
const checkpoints = new WeakMap<Timeline, Map<number, ReplayState>>();

const copyOf = ( state: ReplayState ): ReplayState => ( { nodes: new Map( state.nodes ), edges: new Set( state.edges ) } );

const apply = ( state: ReplayState, frame: Frame ): void => {
    frame.changed.forEach( ( node, id ) => state.nodes.set( id, node ) );
    frame.gone.forEach( id => state.nodes.delete( id ) );
    frame.edgesAdded.forEach( key => state.edges.add( key ) );
    frame.edgesRemoved.forEach( key => state.edges.delete( key ) );
};

/** A copy of the state after frame `index`; the caller may keep it. */
export function stateAt( timeline: Timeline, index: number ): ReplayState {
    let saved = checkpoints.get( timeline );
    if ( !saved ) {
        checkpoints.set( timeline, saved = new Map() );
    }
    const last = Math.min( index, timeline.frames.length - 1 );
    let from = Math.floor( last / CHECKPOINT_EVERY ) * CHECKPOINT_EVERY;
    while ( from > 0 && !saved.has( from ) ) {
        from -= CHECKPOINT_EVERY;
    }
    const state = from > 0 || saved.has( 0 ) ? copyOf( saved.get( from )! ) : { nodes: new Map<number, NodeState>(), edges: new Set<string>() };
    for ( let i = from > 0 || saved.has( 0 ) ? from + 1 : 0; i <= last; i++ ) {
        apply( state, timeline.frames[i] );
        if ( i % CHECKPOINT_EVERY === 0 && !saved.has( i ) ) {
            saved.set( i, copyOf( state ) );
        }
    }
    return state;
}

/** One line of the list of changes of a frame. */
export interface ChangeLine {
    id: number;
    text: string;
    cause?: Cause;
    /** The name of the changed node that made this one change, if the cause is not known. */
    via?: string;
}

const MAX_LINES = 40;

/** What changed in a frame, in words: version, value, re-evaluated, needs update. The first frame has none. */
export function changesOf( timeline: Timeline, index: number ): ChangeLine[] {
    if ( index <= 0 || index >= timeline.frames.length ) {
        return [];
    }
    const before = stateAt( timeline, index - 1 );
    const frame = timeline.frames[index];
    const lines: ChangeLine[] = [];
    const producersOf = ( id: number ): number[] => timeline.graph.edges.filter( e => e.to === id ).map( e => e.from );
    for ( const [id, state] of frame.changed ) {
        const info = timeline.nodes.get( id );
        const previous = before.nodes.get( id );
        if ( !info ) {
            continue;
        }
        const parts: string[] = [];
        if ( !previous ) {
            parts.push( 'appeared' );
        } else {
            if ( state.version !== previous.version ) {
                parts.push( `version ${previous.version} → ${state.version}` );
            }
            if ( state.value !== previous.value && state.value !== undefined ) {
                parts.push( `value ${previous.value ?? '?'} → ${state.value}` );
            }
            if ( state.runs !== previous.runs ) {
                parts.push( 're-evaluated' );
            }
            if ( state.dirty && !previous.dirty ) {
                parts.push( 'needs update' );
            }
        }
        const cause = frame.causes?.get( id );
        const via = !cause ? producersOf( id ).find( p => frame.changed.has( p ) ) : undefined;
        lines.push( {
            id, text: `${info.name}: ${parts.join( ', ' ) || 'changed'}`, cause,
            via: via === undefined ? undefined : timeline.nodes.get( via )?.name
        } );
        if ( lines.length >= MAX_LINES ) {
            break;
        }
    }
    return lines;
}

// ---------------------------------------------------------------------------------------------------------------------
// causes

export interface Origins {
    /** Starts to note the cause of every write of a known node. */
    start(): void;
    stop(): void;
    /** Hands over the causes noted since the last call, and forgets them. */
    take(): Map<number, Cause>;
}

/** The text of a trigger for the event that is running, or else the task the adapter reports. */
function triggerOf( ctx: DebugContext ): string {
    const event = typeof window === 'undefined' ? undefined : ( window as { event?: Event } ).event;
    if ( event ) {
        const target = event.target instanceof Element ? ` on ${describeElement( event.target )}` : '';
        return `${event.type}${target}`;
    }
    return ctx.adapter.env.taskSource?.() ?? 'unknown, outside of an event or task';
}

/**
 * Notes why nodes were written: the event or task, and on V8 the stack, so that the place in the application can be shown. Writes
 * that the adapter's `onWrite` does not report are not seen, and a write after an `await` shows the task, not the click behind it.
 */
export function createOrigins( ctx: DebugContext, isKnown: ( node: ReactiveNode ) => boolean ): Origins {
    let pending = new Map<number, Cause>();
    let stop: ( () => void ) | undefined;

    const hook = ( node: ReactiveNode ): void => {
        try {
            if ( pending.size >= MAX_PENDING_CAUSES || !isKnown( node ) ) {
                return;
            }
            const id = idOf( node );
            if ( pending.has( id ) ) {
                return;
            }
            const cause: Cause = { trigger: triggerOf( ctx ) };
            const capture = ( Error as { captureStackTrace?: ( target: object, hide?: unknown ) => void } ).captureStackTrace;
            if ( capture ) {
                const limit = Error.stackTraceLimit;
                Error.stackTraceLimit = STACK_LIMIT;
                const error = new Error();
                capture.call( Error, error, hook );
                Error.stackTraceLimit = limit;
                cause.error = error;
            }
            pending.set( id, cause );
        } catch {
            // A failure in noting a cause must never reach the application that is being written to.
        }
    };

    return {
        start() {
            stop ??= ctx.adapter.reactivity?.onWrite( hook );
        },
        stop() {
            stop?.();
            stop = undefined;
        },
        take() {
            const taken = pending;
            pending = new Map();
            return taken;
        }
    };
}

/** Where in the application a cause lies: the first stack frame that is not the framework's. `undefined` without a stack. */
export function locationOf( cause: Cause, internal?: RegExp ): string | undefined {
    const stack = cause.error?.stack;
    if ( !stack ) {
        return undefined;
    }
    const frames = stack.split( '\n' ).slice( 1 ).map( line => line.trim() ).filter( line => line.startsWith( 'at ' ) );
    if ( !frames.length ) {
        return undefined;
    }
    return frames.find( frame => !internal?.test( frame ) ) ?? 'framework internal';
}
