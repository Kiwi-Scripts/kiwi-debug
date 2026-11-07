import { SUPPORTED_CONTRACTS } from './define';
import type { FrameworkAdapter, ProfileEvent, ReactiveNode, Unit } from './types';

export interface ConformanceFixture {
    /** Elements to probe; they should carry units (and, ideally, a few that carry none). */
    elements: Element[];
    /** Changes some reactive value that is reachable from `elements`, to check that versions only increase. */
    mutate?(): void;
    /** Makes the framework emit some work while the profiler listens (a render of a component, say). */
    emitProfile?(): void;
    /** Whether the framework currently pays for profiling (a global hook installed). Needed for the zero-cost check. */
    profilerHookInstalled?(): boolean;
}

export interface ConformanceFailure {
    check: string;
    message: string;
}

export interface ConformanceReport {
    /** The checks that ran and passed. */
    passed: string[];
    failures: ConformanceFailure[];
    /** The checks that did not apply, e.g. because a capability is absent. */
    skipped: string[];
}

/** Throws one error listing every failure; for use in a test: `assertConformance( runAdapterConformance( adapter, fixture ) )`. */
export function assertConformance( report: ConformanceReport ): void {
    if ( report.failures.length ) {
        throw new Error( `Adapter conformance failed:\n${report.failures.map( f => `- ${f.check}: ${f.message}` ).join( '\n' )}` );
    }
}

/**
 * Checks an adapter against the contract: a supported version, identity stability, that nothing throws, `units.at` ordering (component
 * first), symmetry of producers and consumers, monotonic versions, `resolve( of( x ) ) === x`, balanced profile events and a profiler
 * that costs nothing before `start` and after the returned stop. It runs against the raw adapter, so that throws are found.
 */
export function runAdapterConformance( adapter: FrameworkAdapter, fixture: ConformanceFixture ): ConformanceReport {
    const report: ConformanceReport = { passed: [], failures: [], skipped: [] };

    const check = ( name: string, run: () => string | undefined | void ): void => {
        try {
            const problem = run();
            if ( problem ) {
                report.failures.push( { check: name, message: problem } );
            } else {
                report.passed.push( name );
            }
        } catch ( error ) {
            report.failures.push( { check: name, message: `threw ${error instanceof Error ? error.message : String( error )}` } );
        }
    };
    const skip = ( name: string ): void => void report.skipped.push( name );

    const unitsOf = ( el: Element ): Unit[] => adapter.units.at( el );

    check( 'contract', () => SUPPORTED_CONTRACTS.includes( adapter.meta.contract ) ? undefined : `contract ${adapter.meta.contract} is not supported` );

    check( 'identity', () => {
        for ( const el of fixture.elements ) {
            const a = unitsOf( el );
            const b = unitsOf( el );
            if ( a.length !== b.length || a.some( ( u, i ) => u !== b[i] ) ) {
                return 'units.at() returned different objects for the same element';
            }
        }
    } );

    check( 'instance', () => {
        for ( const el of fixture.elements ) {
            for ( const unit of unitsOf( el ) ) {
                const instance = adapter.units.instance?.( unit );
                if ( instance !== undefined && ( typeof instance !== 'object' || instance !== adapter.units.instance!( unit ) ) ) {
                    return `instance( ${adapter.units.describe( unit ).name} ) is not the same object every time`;
                }
            }
        }
    } );

    check( 'no-throw', () => {
        for ( const el of fixture.elements ) {
            adapter.units.owner?.( el );
            adapter.units.sections?.( el ).forEach( s => {
                s.list?.();
            } );
            adapter.reactivity?.renderNodeOf?.( el );
            for ( const unit of unitsOf( el ) ) {
                const description = adapter.units.describe( unit );
                if ( typeof description?.name !== 'string' ) {
                    return 'describe() returned no name';
                }
                for ( const member of adapter.units.members( unit ) ) {
                    try {
                        adapter.reactivity?.nodeOf( member.read() );
                    } catch {
                        // `read()` may throw, the core shows `?`.
                    }
                }
            }
        }
        adapter.env.isDev();
        adapter.env.taskSource?.();
        adapter.forms?.scan();
    } );

    check( 'units-order', () => {
        for ( const el of fixture.elements ) {
            const kinds = unitsOf( el ).map( u => adapter.units.describe( u ).kind );
            if ( kinds.lastIndexOf( 'component' ) > 0 ) {
                return `a component is not first on <${el.localName}>: ${kinds.join( ', ' )}`;
            }
        }
    } );

    if ( adapter.reactivity ) {
        const reactivity = adapter.reactivity;
        const nodes = (): Set<ReactiveNode> => {
            const found = new Set<ReactiveNode>();
            const visit = ( node: ReactiveNode | undefined ): void => {
                if ( node && !found.has( node ) ) {
                    found.add( node );
                    node.producers().forEach( visit );
                    node.consumers().forEach( visit );
                }
            };
            for ( const el of fixture.elements ) {
                visit( reactivity.renderNodeOf?.( el ) );
                for ( const unit of unitsOf( el ) ) {
                    for ( const member of adapter.units.members( unit ) ) {
                        try {
                            visit( reactivity.nodeOf( member.read() ) );
                        } catch {
                            // ignored, see above
                        }
                    }
                }
            }
            return found;
        };

        check( 'node-symmetry', () => {
            for ( const node of nodes() ) {
                for ( const producer of node.producers() ) {
                    if ( !producer.consumers().includes( node ) ) {
                        return `${node.name ?? node.kind} lists a producer that does not list it as a consumer`;
                    }
                }
                for ( const consumer of node.consumers() ) {
                    if ( !consumer.producers().includes( node ) ) {
                        return `${node.name ?? node.kind} lists a consumer that does not list it as a producer`;
                    }
                }
            }
        } );

        if ( fixture.mutate ) {
            check( 'version-monotonic', () => {
                const before = new Map( Array.from( nodes(), n => [n, n.version] ) );
                fixture.mutate!();
                for ( const [node, version] of before ) {
                    if ( node.version < version ) {
                        return `${node.name ?? node.kind} went from version ${version} to ${node.version}`;
                    }
                }
            } );
        } else {
            skip( 'version-monotonic' );
        }
    } else {
        skip( 'node-symmetry' );
        skip( 'version-monotonic' );
    }

    if ( adapter.addressing ) {
        const addressing = adapter.addressing;
        check( 'addressing', () => {
            for ( const el of fixture.elements ) {
                for ( const unit of unitsOf( el ) ) {
                    const address = addressing.of( unit, el );
                    if ( address === undefined ) {
                        continue;
                    }
                    const resolved = addressing.resolve( address );
                    if ( resolved?.unit !== unit || resolved.element !== el ) {
                        return `"${address}" does not resolve to the unit it was made for`;
                    }
                }
            }
            if ( addressing.resolve( '\0no such address' ) !== undefined ) {
                return 'resolve() invented a unit for an address that does not exist';
            }
        } );
    } else {
        skip( 'addressing' );
    }

    if ( adapter.profiler ) {
        const profiler = adapter.profiler;
        check( 'profiler-balance', () => {
            const events: ProfileEvent[] = [];
            const stop = profiler.start( ev => void events.push( ev ) );
            fixture.emitProfile?.();
            stop();
            const open: ProfileEvent[] = [];
            for ( const ev of events ) {
                if ( ev.phase === 'begin' ) {
                    open.push( ev );
                } else {
                    const index = open.map( o => o.kind ).lastIndexOf( ev.kind );
                    if ( index < 0 ) {
                        return `an end of "${ev.kind}" without a begin`;
                    }
                    open.splice( index, 1 );
                }
            }
            if ( open.length ) {
                return `unbalanced: "${open[0].kind}" began and never ended`;
            }
        } );

        if ( fixture.profilerHookInstalled ) {
            check( 'profiler-zero-cost', () => {
                if ( fixture.profilerHookInstalled!() ) {
                    return 'a hook is installed before start()';
                }
                const stop = profiler.start( () => undefined );
                if ( !fixture.profilerHookInstalled!() ) {
                    return 'start() did not install anything, so nothing can be measured';
                }
                stop();
                if ( fixture.profilerHookInstalled!() ) {
                    return 'a hook is still installed after stop()';
                }
            } );
        } else {
            skip( 'profiler-zero-cost' );
        }
    } else {
        skip( 'profiler-balance' );
        skip( 'profiler-zero-cost' );
    }

    return report;
}
