import type { FeatureId } from '../adapter/types';
import type { DebugFeature } from '../core/types';
import { inspectorFeature } from './inspector';

/**
 * The built-in features. Their order is the order in which they are set up: services come before the features that use them.
 * Features that are not implemented yet are missing and silently skipped.
 */
export const BUILTIN_FEATURES: Partial<Record<FeatureId, DebugFeature>> = {
    inspector: inspectorFeature
};

/** The order in which features are set up. */
export const SETUP_ORDER: readonly FeatureId[] = ['watch', 'search', 'inspector', 'graph', 'forms', 'profiler'];

/** The order of the tray buttons (panel ids). */
export const TRAY_ORDER: readonly string[] = ['inspector', 'search', 'graph', 'forms', 'profiler', 'watch'];

export const ALL_FEATURE_IDS: readonly FeatureId[] = ['inspector', 'watch', 'search', 'graph', 'forms', 'profiler'];
