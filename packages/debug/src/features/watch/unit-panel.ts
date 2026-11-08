import { keepState } from '@kiwi-js/dom';
import type { PanelDefinition } from '@kiwi-js/panels';
import { div } from '@kiwi-js/panels';

import { createChangeTracker } from '../../core/change-tracker';
import type { DirectiveView } from '../../core/directive-view';
import type { TrackTarget } from '../../core/services';
import type { DebugContext } from '../../core/types';

const isTarget = ( value: unknown ): value is TrackTarget => typeof value === 'object' && value !== null && 'unit' in value;

/**
 * A panel next to the list of tracked values (on its left, else on its right) that shows every member of one unit, with the same
 * buttons as the list. It stays where it is while the list scrolls, which a section appended to the list did not.
 * Open it with `overlay.panels.open( 'unit', target )`.
 */
export function createUnitPanel( ctx: DebugContext, view: DirectiveView ): PanelDefinition {
    const { adapter } = ctx;
    return {
        id: 'unit',
        title: 'Unit',
        tray: false,
        size: { width: 380 },
        className: 'kd-unit-panel',
        defaultPosition: { anchor: () => ctx.overlay.panels.get( 'watch' )?.element, steps: ['left+8 start clamp', 'right+8 start clamp'] },
        mount( pc ) {
            const changes = createChangeTracker( adapter.reactivity, { detail: ctx.options.valueDetail === 'detail' } );
            const root = div( 'kd-unit' );
            let target: TrackTarget | undefined;
            let signature = '';

            const refresh = ( force: boolean ): void => {
                if ( !target ) {
                    return;
                }
                const current = target;
                const rows = ctx.rowsOf( current.unit );
                const snapshot = changes.snapshot( rows.map( r => ( { scope: 'unit', category: r.category, name: r.name, read: r.read } ) ) );
                const next = changes.signatureOf( snapshot );
                if ( next === signature && !force ) {
                    return;
                }
                changes.diff( snapshot, () => true );
                keepState( pc.body, () => root.replaceChildren(
                    ...view.rowGroups( current, rows, { surface: 'side', scope: 'unit', changes, snapshot, open: () => true } ) ) );
                changes.commit( snapshot );
                signature = next;
            };

            return {
                content: root,
                onShow( args ) {
                    if ( isTarget( args ) ) {
                        target = args;
                        signature = '';
                        changes.clear();
                        pc.setTitle( `Unit ${adapter.units.describe( args.unit ).name}` );
                        refresh( true );
                    } else if ( !target ) {
                        // Restored from the saved state of an earlier page load: there is no unit to show.
                        queueMicrotask( () => pc.panel.close() );
                    }
                },
                refresh: () => refresh( false ),
                dispose: () => changes.clear()
            };
        }
    };
}
