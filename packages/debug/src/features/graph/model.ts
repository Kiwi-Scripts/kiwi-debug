import { describeElement, walkElements } from '@kiwi-js/dom';

import type { ReactiveNode, Unit } from '../../adapter/types';
import { preview } from '../../core/format';
import { safe } from '../../core/safe';
import type { DebugContext } from '../../core/types';

/** The most nodes a graph holds; more are left out and the graph says it is truncated. */
export const GRAPH_LIMIT = 250;

export type Direction = 'up' | 'down' | 'both';

/** Who holds a reactive node: a member of a unit, or the render node of a component. */
export interface Owner {
    unit: Unit;
    element: Element | null;
    /** The class of the unit. */
    unitName: string;
    /** The name of the member that holds the node; `template` for a render node. */
    member: string;
    isComponent: boolean;
}

export type Owners = Map<ReactiveNode, Owner>;

const MAX_ELEMENTS = 5000;
/** How far from a nameless node an owner is looked for. */
const NAMING_STEPS = 3;
/** How many consumers are followed to find the elements of a node that no element holds. */
const ELEMENT_STEPS = 20;

/**
 * Walks the page and maps each reactive node to the first owner found: the members of every unit, and the render node of every
 * component. This is how nodes get names that mean something.
 */
export function indexOwners( ctx: DebugContext ): Owners {
    const { adapter } = ctx;
    const owners: Owners = new Map();
    const seen = new Set<Unit>();
    const reactivity = adapter.reactivity;
    const visit = ( el: Element ): void => {
        for ( const unit of safe( () => adapter.units.at( el ) ) ?? [] ) {
            if ( seen.has( unit ) ) {
                continue;
            }
            seen.add( unit );
            const description = safe( () => adapter.units.describe( unit ) );
            if ( !description ) {
                continue;
            }
            const base = { unit, element: el, unitName: description.name, isComponent: description.kind === 'component' };
            for ( const row of ctx.rowsOf( unit ) ) {
                const node = row.category === 'form' ? undefined : safe( () => reactivity?.nodeOf( row.read() ) );
                if ( node && !owners.has( node ) ) {
                    owners.set( node, { ...base, member: row.name } );
                }
            }
            if ( base.isComponent ) {
                const template = safe( () => reactivity?.renderNodeOf?.( el ) );
                if ( template && !owners.has( template ) ) {
                    owners.set( template, { ...base, member: 'template' } );
                }
            }
        }
    };
    visit( document.body );
    let visited = 0;
    for ( const el of walkElements( document.body, { reject: e => ctx.overlay.inOverlay( e ), composed: true } ) ) {
        if ( ++visited > MAX_ELEMENTS ) {
            break;
        }
        visit( el );
    }
    return owners;
}

/** One node of a graph, with what is needed to draw it. */
export interface GraphNode {
    /** Stable for the lifetime of the node: it is the same in every graph and recording. */
    id: number;
    node: ReactiveNode;
    kind: string;
    name: string;
    context: string;
    owner?: Owner;
    /** `preview()` of the value, for nodes that hold one. */
    valueText?: string;
    version: number;
    dirty: boolean;
    runs: number;
    root: boolean;
}

export interface GraphEdge {
    /** The producer. */
    from: number;
    /** The consumer. */
    to: number;
}

export interface Graph {
    nodes: GraphNode[];
    edges: GraphEdge[];
    truncated: boolean;
}

const ids = new WeakMap<ReactiveNode, number>();
let nextId = 1;

/** The id of a node: the same for the same node, always. */
export function idOf( node: ReactiveNode ): number {
    let id = ids.get( node );
    if ( id === undefined ) {
        ids.set( node, id = nextId++ );
    }
    return id;
}

export const edgeKey = ( from: number, to: number ): string => `${from}>${to}`;

/** What a node is called, and where it belongs: see spec 6.5 "Naming". */
export function describeNode( node: ReactiveNode, owners: Owners ): { name: string; context: string } {
    const owner = owners.get( node );
    if ( owner ) {
        if ( owner.member === 'template' ) {
            return { name: 'template', context: owner.isComponent || !owner.element ? owner.unitName : describeElement( owner.element ) };
        }
        return { name: owner.member, context: owner.unitName };
    }
    if ( node.name !== undefined ) {
        return { name: node.name, context: '' };
    }
    // Nameless: take the name of the nearest consumer that has an owner.
    let layer: ReactiveNode[] = [node];
    const visited = new Set<ReactiveNode>( layer );
    for ( let step = 0; step < NAMING_STEPS; step++ ) {
        const next: ReactiveNode[] = [];
        for ( const current of layer ) {
            for ( const consumer of safe( () => current.consumers() ) ?? [] ) {
                const host = owners.get( consumer );
                if ( host ) {
                    return { name: `${host.member} ▸ ${node.kind}`, context: `${host.unitName} internal` };
                }
                if ( !visited.has( consumer ) ) {
                    visited.add( consumer );
                    next.push( consumer );
                }
            }
        }
        layer = next;
    }
    return { name: node.kind, context: '' };
}

/** The state of a node that a refresh compares: never its value, which for a derived node would mean computing it. */
export const stateOf = ( node: ReactiveNode ): { version: number; dirty: boolean; runs: number } =>
    ( { version: safe( () => node.version ) ?? 0, dirty: !!safe( () => node.dirty ), runs: safe( () => node.runs ) ?? 0 } );

/**
 * The graph around some root nodes: what they read (`up`), what reads them (`down`), or both. Siblings of the roots are not
 * followed, so the graph shows causes and effects of the roots, not everything that is connected to them. At most
 * {@link GRAPH_LIMIT} nodes; edges appear once.
 */
export function buildGraph( roots: readonly ReactiveNode[], direction: Direction, owners: Owners ): Graph {
    const nodes = new Map<ReactiveNode, GraphNode>();
    const edges = new Map<string, GraphEdge>();
    let truncated = false;

    const add = ( node: ReactiveNode, root: boolean ): GraphNode | undefined => {
        const known = nodes.get( node );
        if ( known ) {
            known.root ||= root;
            return known;
        }
        if ( nodes.size >= GRAPH_LIMIT ) {
            truncated = true;
            return undefined;
        }
        const { name, context } = describeNode( node, owners );
        const holds = !!safe( () => node.holdsValue );
        const entry: GraphNode = {
            id: idOf( node ), node, kind: safe( () => node.kind ) ?? '?', name, context, owner: owners.get( node ),
            valueText: holds ? safe( () => preview( node.peek() ) ) : undefined,
            ...stateOf( node ), root
        };
        nodes.set( node, entry );
        return entry;
    };

    roots.forEach( root => add( root, true ) );

    const walk = ( follow: 'producers' | 'consumers' ): void => {
        const visited = new Set<ReactiveNode>( roots );
        const stack = [...roots];
        while ( stack.length ) {
            const current = stack.pop()!;
            const from = nodes.get( current )!;
            for ( const next of safe( () => current[follow]() ) ?? [] ) {
                const to = add( next, false );
                if ( !to ) {
                    continue;
                }
                const edge: GraphEdge = follow === 'producers' ? { from: to.id, to: from.id } : { from: from.id, to: to.id };
                edges.set( edgeKey( edge.from, edge.to ), edge );
                if ( !visited.has( next ) ) {
                    visited.add( next );
                    stack.push( next );
                }
            }
        }
    };
    if ( direction !== 'down' ) {
        walk( 'producers' );
    }
    if ( direction !== 'up' ) {
        walk( 'consumers' );
    }
    return { nodes: Array.from( nodes.values() ), edges: Array.from( edges.values() ), truncated };
}

/**
 * The elements a node belongs to: its own, or the owner's, or for a node that lives in a service the elements of the render nodes
 * that read it.
 */
export function elementsOf( node: ReactiveNode, owners?: Owners ): Element[] {
    const own = safe( () => node.element ) ?? owners?.get( node )?.element;
    if ( own ) {
        return [own];
    }
    const found = new Set<Element>();
    const visited = new Set<ReactiveNode>( [node] );
    const queue = [node];
    while ( queue.length && visited.size <= ELEMENT_STEPS ) {
        const current = queue.shift()!;
        for ( const consumer of safe( () => current.consumers() ) ?? [] ) {
            if ( visited.has( consumer ) ) {
                continue;
            }
            visited.add( consumer );
            queue.push( consumer );
            const el = safe( () => consumer.kind === 'template' ? consumer.element : undefined );
            if ( el ) {
                found.add( el );
            }
        }
    }
    return Array.from( found );
}

/** The nodes in the neighbourhood of `id` in a graph, following producers and consumers (not sideways). */
export function connectedTo( id: number, edges: readonly GraphEdge[] ): Set<number> {
    const result = new Set<number>( [id] );
    for ( const direction of ['up', 'down'] as const ) {
        const stack = [id];
        const seen = new Set<number>( [id] );
        while ( stack.length ) {
            const current = stack.pop()!;
            for ( const edge of edges ) {
                const next = direction === 'up' ? ( edge.to === current ? edge.from : undefined ) : ( edge.from === current ? edge.to : undefined );
                if ( next !== undefined && !seen.has( next ) ) {
                    seen.add( next );
                    result.add( next );
                    stack.push( next );
                }
            }
        }
    }
    return result;
}
