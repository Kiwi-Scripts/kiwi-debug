// Entry points of the overlay.
export { disableDebug, enableDebug, isSwitchedOff, resetDebug, setSwitchedOff } from './core/layers';
export { mountOverlay, enabledFeatures } from './core/mount';
export type { MountHooks } from './core/mount';

// Types for options, custom features and the context they work with.
export type { DebugContext, DebugFeature, DebugOptions, EffectiveOptions, FeatureInstance, ListenerTuple } from './core/types';
export type { Inspection, TrackedRow, UnitReaders } from './core/units';
export { Profiler, Tracking, InspectedElement, serviceKey } from './core/services';
export type { ProfilerService, ServiceKey, TrackTarget } from './core/services';
export { createChangeTracker, groupKey, rowKey } from './core/change-tracker';
export type { ChangeNote, ChangeTracker, Reading, Snapshot, TrackedRef } from './core/change-tracker';
export { DEFAULT_ACTIONS } from './core/builtin-actions';
export type { ActionConfig, ActionContext, ActionDef, ActionLists, ActionRegistry, ActionScope } from './core/actions';
export { createDirectiveView } from './core/directive-view';
export type { DirectiveView, RowGroupsOptions } from './core/directive-view';
export { copyValue, preview, stringifyCopy } from './core/format';
export { logGroup, LOG_PREFIX } from './core/console';
export { safe, safeOr } from './core/safe';
export { DEFAULT_TRACKED_COLORS } from './features/watch/model';
export { BUILTIN_FEATURES } from './features';

// The adapter contract, also available from '@kiwi-js/debug/adapter'.
export * from './adapter';
