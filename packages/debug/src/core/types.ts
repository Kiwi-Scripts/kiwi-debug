import type { HotkeyBinding, ModifierKey, Overlay, OverlayOptions, PanelDefinition } from '@kiwi-js/panels';

import type { FeatureId, GuardedAdapter, FrameworkAdapter, Unit } from '../adapter/types';
import type { ActionLists, ActionRegistry } from './actions';
import type { Inspection, TrackedRow } from './units';
import type { ServiceKey } from './services';

/** A listener the overlay attaches (outside the framework's change detection) and removes again. */
export type ListenerTuple = readonly [target: EventTarget, type: string, fn: ( ev: any ) => void, capture: boolean];

export interface DebugOptions {
    /** First layer that sets it wins; it never changes at runtime. */
    adapter?: FrameworkAdapter;
    /** The modifier key. Default: 'Alt'. */
    key?: ModifierKey;
    /** Default palette for tracked values, assigned in order. */
    trackedColors?: string[];
    /** Start recording renders at mount. Default: false. */
    profileRenders?: boolean;
    disabled?: boolean;
    /** Opaque owner scope for `env.onRender`; the framework glue sets it. */
    scope?: unknown;
    /** Default: all built-in features. Custom features can be added. */
    features?: Array<FeatureId | DebugFeature>;
    overlay?: Pick<OverlayOptions, 'tray' | 'theme' | 'storage' | 'container'>;
    /**
     * The buttons of unit heads and value rows, in order: a built-in action by name, or a definition of your own. A list given here
     * replaces the default list of that kind. Built-ins: rows `track`, `graph`, `expressions`; units `track`, `graph`, `address`, `keep`, `side`, `remove`.
     */
    actions?: Partial<ActionLists>;
    /** Whether arrays and objects in value rows can be opened in place. Default: 'summary', one line per value. */
    valueDetail?: 'summary' | 'detail';
    /**
     * Properties that an object's one-line preview shows when it has them, so that `{…}` says more: `{ id: 3, name: "Ada", … }`.
     * Default: id, name, key, title. An empty list turns it off.
     */
    previewKeys?: string[];
}

/** The options after merging the layers and applying defaults. */
export interface EffectiveOptions {
    adapter: FrameworkAdapter;
    key: ModifierKey;
    trackedColors: string[];
    profileRenders: boolean;
    scope: unknown;
    features: Array<FeatureId | DebugFeature>;
    overlay: NonNullable<DebugOptions['overlay']>;
    actions: ActionLists;
    valueDetail: 'summary' | 'detail';
    previewKeys?: readonly string[];
}

export interface FeatureInstance {
    /** Registered with the tray in feature order. */
    panel?: PanelDefinition;
    /** Further panels of the feature, e.g. small ones without a tray button (`PanelDefinition.tray`). */
    panels?: PanelDefinition[];
    /** Bound in registration order; earlier ones consume first. */
    hotkeys?: HotkeyBinding[];
    /** Attached outside the framework zone. */
    listeners?: ListenerTuple[];
    /** For the non-panel part of a feature (e.g. the hover controller). */
    refresh?(): void;
    isActive?(): boolean;
    dispose?(): void;
}

export interface DebugFeature {
    id: FeatureId | ( string & {} );
    /** `env` and `units` are always there. */
    requires?: Array<'reactivity' | 'forms' | 'profiler' | 'addressing'>;
    setup( ctx: DebugContext ): FeatureInstance | undefined;
}

export interface DebugContext {
    readonly overlay: Overlay;
    readonly adapter: GuardedAdapter;
    readonly options: Readonly<EffectiveOptions>;
    /** Readers built on `adapter.units` (all guarded). */
    inspect( el: Element ): Inspection | null;
    findParent( start: Element, includeSelf?: boolean ): Element | null;
    /** The nearest inspectable descendants only. */
    findChildren( start: Element ): Element[];
    /** Inputs, outputs, properties, plus form rows. */
    rowsOf( unit: Unit ): TrackedRow[];
    /** How features reach each other without importing each other. */
    provide<T>( key: ServiceKey<T>, impl: T ): () => void;
    use<T>( key: ServiceKey<T> ): T | undefined;
    /** Whether the modifier is held (or latched) for the event; always true without a modifier. */
    isHeld( ev: KeyboardEvent | MouseEvent ): boolean;
    /** What the inspector shows, if it is there. */
    inspectedElement(): Element | null;
    /** The shared dashed box over the element hovered; `null` hides it. */
    highlightHover( el: Element | null ): void;
    /** The actions available for unit heads and value rows (see `DebugOptions.actions`). Features register their own. */
    readonly actions: ActionRegistry;
    /** A small toggle button for tracking. */
    watchButton( title: string, isOn: () => boolean, toggle: () => void ): HTMLElement;
    /** Runs code where it cannot trigger the framework's change detection. */
    runOutside<T>( fn: () => T ): T;
}
