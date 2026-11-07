import { describeElement, keepState, walkElements } from '@kiwi-js/dom';
import { badge, div, renderDetails, span, type HotkeyBinding, type PanelContext, type PanelDefinition, type PanelHandle } from '@kiwi-js/panels';

import type { Unit } from '../../adapter/types';
import { createChangeTracker } from '../../core/change-tracker';
import { createDirectiveView } from '../../core/directive-view';
import { Tracking } from '../../core/services';
import type { DebugContext, DebugFeature, FeatureInstance } from '../../core/types';
import type { TrackedRow } from '../../core/units';
import {
    groupByName, haystackOf, isEmptyQuery, matchEntries, matchFields, MAX_RESULTS, parseQuery, type ParsedQuery, type SearchEntry
} from './query';

const ICON = 'M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z';

/** The index is rebuilt at most this often by a refresh. */
const REINDEX_MS = 1000;

interface Result {
    entry: SearchEntry;
    /** Only the rows of a field search. */
    rows?: TrackedRow[];
}

function setup( ctx: DebugContext ): FeatureInstance {
    const { overlay, adapter } = ctx;
    const view = createDirectiveView( ctx );
    const changes = createChangeTracker( adapter.reactivity, { detail: ctx.options.valueDetail === 'detail' } );
    const panel = (): PanelHandle | undefined => overlay.panels.get( 'search' );

    const ids = new WeakMap<Unit, string>();
    let counter = 0;
    let index: SearchEntry[] = [];
    let indexedAt = 0;
    let pc: PanelContext | undefined;
    let input: HTMLInputElement | undefined;
    let results: HTMLElement | undefined;
    let signature = '';
    /** The expansion the user chose per key (`e:<id>`, `g:<class>`); what was opened automatically does not count. */
    const userOpen = new Map<string, boolean>();

    // ---------------------------------------------------------------- index
    const buildIndex = (): void => {
        const seen = new Set<Unit>();
        const entries: SearchEntry[] = [];
        const visit = ( el: Element ): void => {
            for ( const unit of adapter.units.at( el ) ) {
                if ( seen.has( unit ) ) {
                    continue;
                }
                seen.add( unit );
                let id = ids.get( unit );
                if ( !id ) {
                    ids.set( unit, id = `s${++counter}` );
                }
                const description = adapter.units.describe( unit );
                entries.push( { id, unit, element: el, kind: description.kind, name: description.name, tag: el.localName, haystack: haystackOf( description.name, el ) } );
            }
        };
        visit( document.body );
        for ( const el of walkElements( document.body, { reject: e => overlay.inOverlay( e ), composed: true } ) ) {
            visit( el );
        }
        index = entries;
        indexedAt = Date.now();
    };

    const search = ( query: ParsedQuery ): Result[] => {
        if ( isEmptyQuery( query ) ) {
            return [];
        }
        const found: Result[] = [];
        for ( const entry of matchEntries( index, query ) ) {
            if ( found.length >= MAX_RESULTS ) {
                break;
            }
            if ( !query.fields.length ) {
                found.push( { entry } );
                continue;
            }
            const rows = matchFields( ctx.rowsOf( entry.unit ), query.fields );
            if ( rows ) {
                found.push( { entry, rows } );
            }
        }
        return found;
    };

    // ---------------------------------------------------------------- rendering
    let lastResults: Result[] = [];

    const isOpen = ( key: string, auto: boolean ): boolean => userOpen.get( key ) ?? auto;
    const remember = ( key: string, auto: boolean ) => ( open: boolean ): void => {
        if ( open !== isOpen( key, auto ) || userOpen.has( key ) ) {
            userOpen.set( key, open );
        }
    };

    const renderEntry = ( result: Result, autoOpen: boolean ): HTMLElement => {
        const { entry } = result;
        const target = { unit: entry.unit, element: entry.element };
        const head: ( Node | string )[] = [
            ...view.unitActions( target, 'search', 'leading' ), view.nameLink( target ), span( 'kp-muted', ` <${describeElement( entry.element )}>` ),
            ...view.unitActions( target, 'search', 'trailing' )
        ];
        const profile = view.profileBadge( entry.unit );
        if ( profile ) {
            head.push( profile );
        }
        const key = `e:${entry.id}`;
        const details = renderDetails( {
            className: 'kp-dir kd-result',
            key,
            open: isOpen( key, autoOpen ),
            headRow: true,
            head,
            body: () => view.rowGroups( target, result.rows ?? ctx.rowsOf( entry.unit ), {
                surface: 'search', scope: `search:${entry.id}`, changes, open: () => !!result.rows
            } ),
            onToggle: remember( key, autoOpen )
        } );
        const address = adapter.addressing?.of( entry.unit, entry.element );
        details.onmouseenter = () => {
            ctx.highlightHover( entry.element );
            if ( address !== undefined ) {
                details.title = address;
            }
        };
        details.onmouseleave = () => ctx.highlightHover( null );
        return details;
    };

    const renderResults = ( found: Result[], query: ParsedQuery ): void => {
        if ( !results || !pc ) {
            return;
        }
        const container = results;
        const autoOpen = query.fields.length > 0;
        keepState( pc.body, () => {
            container.replaceChildren();
            if ( isEmptyQuery( query ) ) {
                container.append( div( 'kp-muted kd-hint', 'Type a name, tag, id or class. Several terms narrow the search; @name finds inputs and properties.' ) );
                return;
            }
            if ( !found.length ) {
                container.append( div( 'kp-muted kd-hint', 'Nothing found.' ) );
                return;
            }
            for ( const [name, group] of groupByName( found.map( r => ( { ...r, name: r.entry.name } ) ) ) ) {
                const key = `g:${name}`;
                container.append( renderDetails( {
                    className: 'kp-dir kd-group-result',
                    key,
                    open: isOpen( key, true ),
                    headRow: true,
                    head: [span( '', name ), badge( String( group.length ) )],
                    body: () => group.map( r => renderEntry( r, autoOpen ) ),
                    onToggle: remember( key, true )
                } ) );
            }
        } );
    };

    const run = ( force = false ): void => {
        if ( !input ) {
            return;
        }
        const query = parseQuery( input.value );
        lastResults = search( query );
        const next = `${input.value}\u0003${lastResults.map( r => r.entry.id ).join( ',' )}`;
        if ( next === signature && !force ) {
            return;
        }
        signature = next;
        renderResults( lastResults, query );
        pc?.setBadge( lastResults.length || null );
    };

    // ---------------------------------------------------------------- the panel
    const definition: PanelDefinition = {
        id: 'search',
        title: 'Search',
        icon: ICON,
        hotkey: 'KeyF',
        defaultPosition: 'top-left',
        mount( context ) {
            pc = context;
            const root = div( 'kd-search-body' );
            input = document.createElement( 'input' );
            input.type = 'search';
            input.className = 'kp-input kd-search-input';
            input.placeholder = 'Search units… (@name for inputs and properties)';
            input.oninput = () => run();
            input.onkeydown = ev => {
                if ( ev.key === 'Enter' && lastResults[0] ) {
                    const { unit, element } = lastResults[0].entry;
                    ctx.use( Tracking )?.toggleDirectiveWatch( { unit, element } );
                }
            };
            results = div( 'kd-results' );
            root.append( input, results );
            return {
                content: root,
                onShow() {
                    buildIndex();
                    run( true );
                    input?.focus();
                },
                refresh() {
                    if ( Date.now() - indexedAt >= REINDEX_MS ) {
                        buildIndex();
                    }
                    run();
                },
                onHide: () => ctx.highlightHover( null ),
                dispose() {
                    pc = undefined;
                    input = undefined;
                    results = undefined;
                    signature = '';
                    index = [];
                    lastResults = [];
                }
            };
        }
    };

    const hotkeys: HotkeyBinding[] = [{
        combo: 'Escape', modifier: false, allowWhileEditing: true,
        handler: () => {
            const handle = panel();
            if ( handle?.state === 'open' ) {
                handle.close();
                return true;
            }
            return false;
        }
    }];

    return { panel: definition, hotkeys };
}

export const searchFeature: DebugFeature = { id: 'search', setup };
