import { safe, safeOr } from '../core/safe';
import type {
    AddressingApi, EnvApi, FormNode, FormsApi, FormState, FrameworkAdapter, GuardedAdapter, Member, ProfilerApi, ReactiveNode,
    ReactivityApi, Section, UnitDescription, UnitsApi
} from './types';

/** The version of the adapter contract this core implements. Adapter packages set `meta.contract` to it at build time. */
export const ADAPTER_CONTRACT = 1;

/** The contracts the core accepts. Keeps the previous one for a release, by shimming the difference, so adapters can lag by one. */
export const SUPPORTED_CONTRACTS: readonly number[] = [ADAPTER_CONTRACT];

/** The identity function that types an adapter. */
export function defineAdapter<A extends FrameworkAdapter>( adapter: A ): A {
    return adapter;
}

/** Why the core cannot use the adapter, or `undefined` if it can. */
export function checkAdapter( adapter: FrameworkAdapter | undefined ): string | undefined {
    if ( !adapter?.meta || typeof adapter.env?.isDev !== 'function' || typeof adapter.units?.at !== 'function' ) {
        return 'the adapter lacks `meta`, `env` or `units`';
    }
    const { id, contract } = adapter.meta;
    if ( !SUPPORTED_CONTRACTS.includes( contract ) ) {
        const range = SUPPORTED_CONTRACTS.length > 1 ? `${Math.min( ...SUPPORTED_CONTRACTS )}..${Math.max( ...SUPPORTED_CONTRACTS )}` : String( SUPPORTED_CONTRACTS[0] );
        return `adapter "${id}" implements contract ${contract}, core supports ${range}`;
    }
    return undefined;
}

const EMPTY_STATE: FormState = { value: undefined, status: 'valid', errors: [], touched: false, dirty: false };
const UNKNOWN_UNIT: UnitDescription = { name: '?', kind: 'other', element: null };

function guardEnv( env: EnvApi ): EnvApi {
    return {
        isDev: () => safeOr( () => !!env.isDev(), false ),
        runOutside: env.runOutside && (<T>( fn: () => T ): T => env.runOutside!( fn )),
        onRender: env.onRender && (( cb, scope ) => {
            const off = safe( () => env.onRender!( () => void safe( cb ), scope ) );
            return () => void safe( () => off?.() );
        }),
        flush: env.flush && (el => void safe( () => env.flush!( el ) )),
        taskSource: env.taskSource && (() => safe( () => env.taskSource!() )),
        internalFrames: env.internalFrames
    };
}

function guardUnits( units: UnitsApi, guardSection: ( section: Section ) => Section ): UnitsApi {
    return {
        at: el => safeOr( () => Array.from( units.at( el ) ).filter( u => typeof u === 'object' && u !== null ), [] ),
        describe: unit => safeOr( () => units.describe( unit ) ?? UNKNOWN_UNIT, UNKNOWN_UNIT ),
        // `Member.read` is left as it is: a value that cannot be read is displayed as `?` by the caller.
        members: unit => safeOr<Member[]>( () => Array.from( units.members( unit ) ), [] ),
        owner: units.owner && (el => safe( () => units.owner!( el ) )),
        sections: units.sections && (el => safeOr( () => Array.from( units.sections!( el ) ).map( guardSection ), [] ))
    };
}

function guardSection( section: Section ): Section {
    return {
        id: section.id,
        label: section.label,
        read: () => safe( () => section.read() ),
        list: section.list && (() => safeOr( () => Array.from( section.list!() ), [] ))
    };
}

/** Wraps a reactive node lazily; the same raw node gives the same wrapper, since the core keys on identity. */
function createNodeGuard(): ( raw: ReactiveNode ) => ReactiveNode {
    const cache = new WeakMap<object, ReactiveNode>();
    const guardNode = ( raw: ReactiveNode ): ReactiveNode => {
        let guarded = cache.get( raw );
        if ( !guarded ) {
            guarded = {
                get kind() { return safeOr( () => raw.kind, '?' ); },
                get name() { return safe( () => raw.name ); },
                get holdsValue() { return safeOr( () => !!raw.holdsValue, false ); },
                get version() { return safeOr( () => raw.version, 0 ); },
                get dirty() { return safeOr( () => !!raw.dirty, false ); },
                get runs() { return safe( () => raw.runs ); },
                get element() { return safe( () => raw.element ); },
                producers: () => safeOr( () => Array.from( raw.producers() ).map( guardNode ), [] ),
                consumers: () => safeOr( () => Array.from( raw.consumers() ).map( guardNode ), [] ),
                // Like `Member.read`, thrown to the caller, which displays `?`.
                peek: () => raw.peek()
            };
            cache.set( raw, guarded );
        }
        return guarded;
    };
    return guardNode;
}

function guardReactivity( api: ReactivityApi, guardNode: ( raw: ReactiveNode ) => ReactiveNode ): ReactivityApi {
    return {
        nodeOf: value => {
            const node = safe( () => api.nodeOf( value ) );
            return node && guardNode( node );
        },
        renderNodeOf: api.renderNodeOf && (el => {
            const node = safe( () => api.renderNodeOf!( el ) );
            return node && guardNode( node );
        }),
        onWrite: cb => {
            const off = safe( () => api.onWrite( node => void safe( () => cb( guardNode( node ) ) ) ) );
            return () => void safe( () => off?.() );
        }
    };
}

function createFormGuard(): ( raw: FormNode ) => FormNode {
    const cache = new WeakMap<object, FormNode>();
    const guardForm = ( raw: FormNode ): FormNode => {
        let guarded = cache.get( raw.raw ?? raw );
        if ( !guarded ) {
            guarded = {
                raw: raw.raw,
                get key() { return safeOr( () => raw.key, '?' ); },
                get kind() { return safeOr( () => raw.kind, 'control' as const ); },
                get model() { return safeOr( () => raw.model, '?' ); },
                get element() { return safe( () => raw.element ); },
                children: () => safeOr( () => Array.from( raw.children() ).map( guardForm ), [] ),
                state: () => safeOr( () => raw.state(), EMPTY_STATE ),
                facts: raw.facts && (() => safeOr( () => Array.from( raw.facts!() ), [] )),
                actions: raw.actions && (() => safeOr( () => Array.from( raw.actions!() ).map( action => ( { ...action, run: () => void safe( () => action.run() ) } ) ), [] )),
                watch: raw.watch && (cb => {
                    const off = safe( () => raw.watch!( ev => void safe( () => cb( { ...ev, node: guardForm( ev.node ) } ) ) ) );
                    return () => void safe( () => off?.() );
                })
            };
            cache.set( raw.raw ?? raw, guarded );
        }
        return guarded;
    };
    return guardForm;
}

function guardForms( api: FormsApi, guardForm: ( raw: FormNode ) => FormNode ): FormsApi {
    return {
        scan: () => safeOr( () => Array.from( api.scan() ).map( binding => ( { ...binding, root: guardForm( binding.root ) } ) ), [] ),
        controlOf: api.controlOf && (unit => {
            const node = safe( () => api.controlOf!( unit ) );
            return node && guardForm( node );
        })
    };
}

function guardProfiler( api: ProfilerApi ): ProfilerApi {
    return {
        start: sink => {
            const stop = safe( () => api.start( sink ) );
            return () => void safe( () => stop?.() );
        }
    };
}

function guardAddressing( api: AddressingApi ): AddressingApi {
    return {
        of: ( unit, el ) => safe( () => api.of( unit, el ) ),
        resolve: address => safe( () => api.resolve( address ) )
    };
}

/**
 * Wraps the adapter once, at mount: no member throws (a throw gives `undefined`, `[]` or a neutral value), nodes and form nodes are
 * wrapped lazily with the same rule, and an absent capability or method stays absent. Features only ever see the guarded adapter.
 * Check {@link checkAdapter} first; this assumes the adapter is usable.
 */
export function guardAdapter( raw: FrameworkAdapter ): GuardedAdapter {
    const guardNode = createNodeGuard();
    const guardForm = createFormGuard();
    return {
        meta: raw.meta,
        env: guardEnv( raw.env ),
        units: guardUnits( raw.units, guardSection ),
        reactivity: raw.reactivity && guardReactivity( raw.reactivity, guardNode ),
        forms: raw.forms && guardForms( raw.forms, guardForm ),
        profiler: raw.profiler && guardProfiler( raw.profiler ),
        addressing: raw.addressing && guardAddressing( raw.addressing )
    };
}
