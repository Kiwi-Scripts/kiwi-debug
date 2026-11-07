import { div, span } from '@kiwi-js/panels';

import { logGroup } from './console';
import { copyValue } from './format';
import { formatSegments, type Segment } from './expressions';
import { safe } from './safe';
import { TREE_PAGE, type ValueNode } from './values';

/** What a tree remembers across redraws: which nodes are open, and how many of a long list were asked for. */
export interface ValueViewState {
    open: Set<string>;
    limits: Map<string, number>;
}

export const createValueViewState = (): ValueViewState => ( { open: new Set(), limits: new Map() } );

export interface ValueViewOptions {
    state?: ValueViewState;
    /** Deeper levels are listed but not opened by default. */
    maxDepth?: number;
    /** A node's name was clicked: the path of steps to it from the root. */
    onPick?( path: Segment[], node: ValueNode ): void;
    /** The pointer is over (or left) a node that is an element. */
    highlight?( el: Element | null ): void;
}

const MAX_DEPTH = 12;

/** Renders a value tree. Children are built when a node is opened, so only what is on screen costs anything. */
export function renderValueTree( root: ValueNode, options: ValueViewOptions = {} ): HTMLElement {
    const state = options.state ?? createValueViewState();
    const maxDepth = options.maxDepth ?? MAX_DEPTH;

    const renderNode = ( node: ValueNode, path: Segment[], id: string, depth: number ): HTMLElement => {
        const wrapper = div( 'kd-node' );
        const row = div( 'kp-row kd-node-row' );
        const chevron = span( 'kd-chev', node.expandable && depth < maxDepth ? ( state.open.has( id ) ? '▾' : '▸' ) : ' ' );
        row.append( chevron );
        if ( node.key ) {
            const key = span( `kd-name${options.onPick && node.segment ? ' kp-link' : ''}`, node.key );
            if ( options.onPick && node.segment ) {
                key.title = 'Use this path';
                key.onclick = ev => {
                    ev.stopPropagation();
                    options.onPick!( path, node );
                };
            }
            row.append( key, ': ' );
        }
        const text = span( `kd-value kd-${node.kind}`, node.text, 'Click to log the value' );
        text.onclick = ev => {
            ev.stopPropagation();
            logGroup( node.key || 'value', [['value', node.value], ['copy', safe( () => copyValue( node.value ) )]] );
        };
        row.append( text );
        if ( node.kind === 'element' && node.value instanceof Element ) {
            const el = node.value;
            row.onmouseenter = () => options.highlight?.( el );
            row.onmouseleave = () => options.highlight?.( null );
        }
        wrapper.append( row );

        if ( !node.expandable || depth >= maxDepth ) {
            return wrapper;
        }
        const body = div( 'kd-node-body' );
        const fill = (): void => {
            body.replaceChildren();
            const limit = state.limits.get( id ) ?? TREE_PAGE;
            const { nodes, total } = node.children( limit );
            for ( const childNode of nodes ) {
                const childPath = childNode.segment ? [...path, childNode.segment] : path;
                // Entries that cannot be reached by an expression step (odd map keys) still get an id of their own.
                body.append( renderNode( childNode, childPath, childNode.segment ? formatSegments( childPath ) : `${id}/${childNode.key}`, depth + 1 ) );
            }
            if ( total > nodes.length ) {
                const more = span( 'kp-muted kp-link kd-more', `… ${total - nodes.length} more` );
                more.onclick = ev => {
                    ev.stopPropagation();
                    state.limits.set( id, limit + TREE_PAGE );
                    fill();
                };
                body.append( more );
            }
        };
        const setOpen = ( open: boolean ): void => {
            if ( open ) {
                state.open.add( id );
                fill();
                wrapper.append( body );
            } else {
                state.open.delete( id );
                body.remove();
            }
            chevron.textContent = open ? '▾' : '▸';
        };
        row.classList.add( 'kd-toggle' );
        row.onclick = () => setOpen( !state.open.has( id ) );
        if ( state.open.has( id ) ) {
            setOpen( true );
        }
        return wrapper;
    };

    const tree = renderNode( root, [], '', 0 );
    tree.classList.add( 'kd-tree' );
    return tree;
}
