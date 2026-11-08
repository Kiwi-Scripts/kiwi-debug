import type { GraphEdge } from './model';

export const NODE_HEIGHT = 54;
export const CHAR_WIDTH = 6.6;
export const MIN_WIDTH = 150;
export const MAX_WIDTH = 440;
export const NODE_PADDING = 10;
const GAP_X = 80;
const GAP_Y = 14;
const MARGIN = 12;
/** The distance between two rows. A node fits between two straight lines that are one row apart, and a line passes it. */
const ROW_PITCH = NODE_HEIGHT + 2 * GAP_Y;
/** How firmly an item holds the height of its row: the spine, a chain with straight lines, anything else. */
const SPINE_WEIGHT = 1e9;
const CHAIN_WEIGHT = 100;
const SINGLE_WEIGHT = 2;

export interface LayoutBox {
    x: number;
    y: number;
    w: number;
    h: number;
}

export interface GraphLayout {
    boxes: Map<number, LayoutBox>;
    width: number;
    height: number;
}

/** What a node needs for its place: an id and the lines of text it shows. */
export interface LayoutNode {
    id: number;
    lines: readonly string[];
}

/** How many characters of a line fit into a node of width `w`. */
export const charsFor = ( w: number ): number => Math.max( 4, Math.floor( ( w - 2 * NODE_PADDING ) / CHAR_WIDTH ) );

export const ellipsize = ( text: string, max: number ): string => text.length > max ? `${text.slice( 0, Math.max( 1, max - 1 ) )}…` : text;

/** The width of a node: its longest line, within the limits. */
export const widthOf = ( lines: readonly string[] ): number =>
    Math.min( MAX_WIDTH, Math.max( MIN_WIDTH, Math.ceil( Math.max( 0, ...lines.map( l => l.length ) ) * CHAR_WIDTH + 2 * NODE_PADDING ) ) );

/** Nodes that follow each other along edges that are drawn as straight lines, in one row. */
interface Chain {
    ids: number[];
    first: number;
    last: number;
    /** The columns it covers. */
    span: number;
}

/**
 * Lays the graph out in columns from left to right and in rows, by these rules:
 *
 * 1. A node's column is one more than the highest column of what it reads; then every node is pulled right as far as its readers
 *    allow, so that a value read far to the right stands next to its reader.
 * 2. The longest chain of the graph is its spine, and lies in the middle row. Where several producers are equally good, the middle
 *    one is taken, so that the others are around the spine.
 * 3. Further edges are made straight, the longest first, as long as no node has more than one straight line in and one out. The
 *    nodes that follow each other along such lines are a chain, which stays in one row. The other edges are curves.
 * 4. The chains get rows: the spine row 0, then the shortest first, each as near as it can be to the rows of what it is connected
 *    to, in a row where its columns are free, and on the side that has fewer so far. So long chains end up on the outside, where they
 *    are not in the way. A node on no chain goes where its neighbours are, if that row is free in its column, else next to it; or
 *    between two rows if there is room, so that it does not block a line.
 *
 * The heights follow from the rows, a column at a time, moving nodes apart where they would overlap.
 */
export function layoutGraph( nodes: readonly LayoutNode[], edgeList: readonly GraphEdge[] ): GraphLayout {
    const known = new Set( nodes.map( n => n.id ) );
    const index = new Map( nodes.map( ( n, i ) => [n.id, i] ) );
    const seenEdges = new Set<string>();
    const edges = edgeList.filter( e => {
        const key = `${e.from}>${e.to}`;
        if ( e.from === e.to || !known.has( e.from ) || !known.has( e.to ) || seenEdges.has( key ) ) {
            return false;
        }
        seenEdges.add( key );
        return true;
    } );
    const producers = new Map<number, number[]>();
    const consumers = new Map<number, number[]>();
    for ( const edge of edges ) {
        ( producers.get( edge.to ) ?? producers.set( edge.to, [] ).get( edge.to )! ).push( edge.from );
        ( consumers.get( edge.from ) ?? consumers.set( edge.from, [] ).get( edge.from )! ).push( edge.to );
    }

    // 1. Columns: as far left as the producers allow, then as far right as the consumers allow.
    const column = new Map<number, number>();
    const visiting = new Set<number>();
    const columnOf = ( id: number ): number => {
        const cached = column.get( id );
        if ( cached !== undefined ) {
            return cached;
        }
        if ( visiting.has( id ) ) {
            return 0;
        }
        visiting.add( id );
        let value = 0;
        for ( const producer of producers.get( id ) ?? [] ) {
            value = Math.max( value, columnOf( producer ) + 1 );
        }
        visiting.delete( id );
        column.set( id, value );
        return value;
    };
    nodes.forEach( n => columnOf( n.id ) );
    // How long the longest chain that ends at a node is; the columns change below, this does not.
    const depth = new Map( column );
    for ( const node of [...nodes].sort( ( a, b ) => column.get( b.id )! - column.get( a.id )! ) ) {
        const readers = consumers.get( node.id );
        if ( readers?.length ) {
            const latest = Math.min( ...readers.map( r => column.get( r )! ) ) - 1;
            if ( latest > column.get( node.id )! ) {
                column.set( node.id, latest );
            }
        }
    }

    // 2. The spine: back from the end of the longest chain, by main producers.
    const mainProducer = ( id: number ): number | undefined => {
        const options = ( producers.get( id ) ?? [] ).filter( p => column.get( p )! < column.get( id )! );
        if ( !options.length ) {
            return undefined;
        }
        const deepest = Math.max( ...options.map( p => depth.get( p )! ) );
        const best = options.filter( p => depth.get( p )! === deepest ).sort( ( a, b ) => index.get( a )! - index.get( b )! );
        return best[Math.floor( ( best.length - 1 ) / 2 )];
    };
    let end: number | undefined;
    for ( const node of nodes ) {
        if ( end === undefined || depth.get( node.id )! > depth.get( end )! ) {
            end = node.id;
        }
    }
    const straightOut = new Map<number, number>();
    const straightIn = new Map<number, number>();
    const makeStraight = ( from: number, to: number ): void => {
        straightOut.set( from, to );
        straightIn.set( to, from );
    };
    const spine = new Set<number>();
    for ( let id = end; id !== undefined; ) {
        spine.add( id );
        const producer = mainProducer( id );
        if ( producer !== undefined ) {
            makeStraight( producer, id );
        }
        id = producer;
    }

    // 3. More straight lines, the longest first.
    const wanting = edges
        .filter( e => column.get( e.to )! > column.get( e.from )! )
        .sort( ( p, q ) =>
            ( column.get( q.to )! - column.get( q.from )! ) - ( column.get( p.to )! - column.get( p.from )! )
            || depth.get( q.to )! - depth.get( p.to )!
            || index.get( p.from )! - index.get( q.from )! || index.get( p.to )! - index.get( q.to )! );
    for ( const edge of wanting ) {
        if ( !straightOut.has( edge.from ) && !straightIn.has( edge.to ) ) {
            makeStraight( edge.from, edge.to );
        }
    }
    const chains: Chain[] = [];
    const chainOf = new Map<number, Chain>();
    for ( const node of nodes ) {
        if ( straightIn.has( node.id ) ) {
            continue;
        }
        const ids = [node.id];
        for ( let next = straightOut.get( node.id ); next !== undefined; next = straightOut.get( next ) ) {
            ids.push( next );
        }
        const chain: Chain = { ids, first: column.get( ids[0] )!, last: column.get( ids[ids.length - 1] )!, span: 0 };
        chain.span = chain.last - chain.first;
        chains.push( chain );
        ids.forEach( id => chainOf.set( id, chain ) );
    }

    // 4. Rows. A cell is a row in a column; it holds a node, or a line that passes through.
    const cells = new Map<string, 'node' | 'line'>();
    const cellKey = ( at: number, col: number ): string => `${at * 2}:${col}`;
    const row = new Map<number, number>();
    let above = 0;
    let below = 0;
    const takeRow = ( chain: Chain, at: number ): void => {
        chain.ids.forEach( ( id, i ) => {
            row.set( id, at );
            cells.set( cellKey( at, column.get( id )! ), 'node' );
            if ( i + 1 < chain.ids.length ) {
                for ( let c = column.get( id )! + 1; c < column.get( chain.ids[i + 1] )!; c++ ) {
                    cells.set( cellKey( at, c ), 'line' );
                }
            }
        } );
        if ( at < 0 ) {
            above++;
        } else if ( at > 0 ) {
            below++;
        }
    };
    /** The row its neighbours are in, as far as they have one. */
    const attractor = ( ids: number[] ): number => {
        const own = new Set( ids );
        const rows: number[] = [];
        for ( const id of ids ) {
            for ( const other of [...producers.get( id ) ?? [], ...consumers.get( id ) ?? []] ) {
                if ( !own.has( other ) && row.has( other ) ) {
                    rows.push( row.get( other )! );
                }
            }
        }
        return rows.length ? rows.reduce( ( a, b ) => a + b, 0 ) / rows.length : 0;
    };
    /** Rows by their distance from `near`; at an equal distance the side with fewer chains, then below. */
    const candidates = ( near: number, halves: boolean ): number[] => {
        const reach = nodes.length + 2;
        const rows: number[] = [];
        for ( let r = -reach; r <= reach; r += halves ? 0.5 : 1 ) {
            // Half a row between the spine and the first row is too narrow for a node.
            if ( !Number.isInteger( r ) && Math.abs( r ) < 1.5 ) {
                continue;
            }
            rows.push( r );
        }
        const sideCount = ( r: number ): number => ( r < 0 ? above : r > 0 ? below : 0 );
        return rows.sort( ( p, q ) =>
            Math.abs( p - near ) - Math.abs( q - near ) || sideCount( p ) - sideCount( q ) || q - p );
    };

    const spineChain = chainOf.get( end ?? -1 );
    if ( spineChain ) {
        takeRow( spineChain, 0 );
    }
    // The shorter chains first, so that the longer ones end up outside; of equal ones the later first, so that the earlier are above.
    const multi = chains.filter( c => c !== spineChain && c.ids.length > 1 )
        .sort( ( p, q ) => p.span - q.span || index.get( q.ids[0] )! - index.get( p.ids[0] )! );
    for ( const chain of multi ) {
        const free = ( r: number ): boolean => {
            for ( let c = chain.first; c <= chain.last; c++ ) {
                if ( cells.has( cellKey( r, c ) ) ) {
                    return false;
                }
            }
            return true;
        };
        takeRow( chain, candidates( attractor( chain.ids ), false ).find( free ) ?? 0 );
    }
    for ( const chain of chains.filter( c => c !== spineChain && c.ids.length === 1 ) ) {
        const col = chain.first;
        const free = ( r: number ): boolean => {
            if ( Number.isInteger( r ) ) {
                return !cells.has( cellKey( r, col ) );
            }
            // Between two rows: the cell itself and the nodes above and below must be free; lines may pass.
            return !cells.has( cellKey( r, col ) ) && cells.get( cellKey( Math.floor( r ), col ) ) !== 'node' && cells.get( cellKey( Math.ceil( r ), col ) ) !== 'node';
        };
        takeRow( chain, candidates( attractor( chain.ids ), true ).find( free ) ?? 0 );
    }

    // Heights: each column has its items in the order of their rows, settled as near to their rows as they can be without overlapping.
    const byColumn: number[][] = [];
    for ( const node of nodes ) {
        ( byColumn[column.get( node.id )!] ??= [] ).push( node.id );
    }
    const width = new Map( nodes.map( n => [n.id, widthOf( n.lines )] ) );
    const top = new Map<number, number>();
    for ( const ids of byColumn ) {
        if ( !ids ) {
            continue;
        }
        ids.sort( ( p, q ) => row.get( p )! - row.get( q )! || index.get( p )! - index.get( q )! );
        const offsets = ids.map( ( _, i ) => i * ( NODE_HEIGHT + GAP_Y ) );
        const weight = ( id: number ): number => ( spine.has( id ) ? SPINE_WEIGHT : chainOf.get( id )!.ids.length > 1 ? CHAIN_WEIGHT : SINGLE_WEIGHT );
        // A weighted isotonic regression: blocks of nodes that have to stay together sit at the weighted mean of what they want.
        const blocks: { sum: number; weight: number; from: number; to: number }[] = [];
        ids.forEach( ( id, i ) => {
            const w = weight( id );
            blocks.push( { sum: ( row.get( id )! * ROW_PITCH - NODE_HEIGHT / 2 - offsets[i] ) * w, weight: w, from: i, to: i } );
            while ( blocks.length > 1 ) {
                const last = blocks[blocks.length - 1];
                const before = blocks[blocks.length - 2];
                if ( before.sum / before.weight <= last.sum / last.weight ) {
                    break;
                }
                blocks.splice( blocks.length - 2, 2, { sum: before.sum + last.sum, weight: before.weight + last.weight, from: before.from, to: last.to } );
            }
        } );
        for ( const block of blocks ) {
            for ( let i = block.from; i <= block.to; i++ ) {
                top.set( ids[i], block.sum / block.weight + offsets[i] );
            }
        }
    }
    const shift = MARGIN - Math.min( ...top.values() );

    // Columns left to right; one without nodes takes no room.
    const boxes = new Map<number, LayoutBox>();
    let x = MARGIN;
    let bottom = 0;
    for ( const ids of byColumn ) {
        if ( !ids?.length ) {
            continue;
        }
        for ( const id of ids ) {
            const y = top.get( id )! + shift;
            boxes.set( id, { x, y, w: width.get( id )!, h: NODE_HEIGHT } );
            bottom = Math.max( bottom, y + NODE_HEIGHT );
        }
        x += Math.max( ...ids.map( id => width.get( id )! ) ) + GAP_X;
    }
    return { boxes, width: Math.max( MARGIN * 2, x - GAP_X + MARGIN ), height: Math.max( MARGIN * 2, bottom + MARGIN ) };
}
