import type { Unit } from '../adapter/types';

/** A typed key for a service one feature provides and others use, so that features never import each other. */
export interface ServiceKey<T> {
    readonly id: string;
    /** Only carries the type. */
    readonly type?: T;
}

export const serviceKey = <T>( id: string ): ServiceKey<T> => ( { id } );

/** A unit that is tracked (or can be), with the element it was found on. */
export interface TrackTarget {
    unit: Unit;
    element: Element | null;
}

/** Provided by the watch list; used by the inspector, the search and the directive view. */
export interface Tracking {
    /** Whether the unit is tracked as a whole, or, with `category` and `name`, whether that value is. */
    isWatched( unit: Unit, category?: string, name?: string ): boolean;
    toggleDirectiveWatch( target: TrackTarget ): void;
    toggleValueWatch( target: TrackTarget, category: string, name: string ): void;
}

/** Provided by the render profiler; used for the renders and checks badge of the directive view. */
export interface ProfilerService {
    /** Counts of a component class, only if it has been counted. */
    countsOf( unit: Unit ): { renders: number; checks: number; rendering: boolean } | undefined;
}

export const Tracking = serviceKey<Tracking>( 'tracking' );
export const Profiler = serviceKey<ProfilerService>( 'profiler' );
/** The element the inspector shows, provided by the inspector. */
export const InspectedElement = serviceKey<() => Element | null>( 'inspected-element' );

export interface Services {
    provide<T>( key: ServiceKey<T>, impl: T ): () => void;
    use<T>( key: ServiceKey<T> ): T | undefined;
}

export function createServices(): Services {
    const services = new Map<string, unknown>();
    return {
        provide( key, impl ) {
            services.set( key.id, impl );
            return () => void ( services.get( key.id ) === impl && services.delete( key.id ) );
        },
        use: key => services.get( key.id ) as never
    };
}
