import { ADAPTER_CONTRACT } from './define';
import type {
    FormNode, FormState, FrameworkAdapter, Member, ProfileEvent, ReactiveNode, Section, Unit, UnitDescription
} from './types';

export type FakeCapability = 'reactivity' | 'forms' | 'profiler' | 'addressing';

export interface FakeAdapterOptions {
    /** Optional capabilities to provide. Default: all. */
    capabilities?: readonly FakeCapability[];
    /** Default: true. */
    dev?: boolean;
    contract?: number;
    id?: string;
}

export interface FakeUnitSpec {
    name: string;
    kind?: UnitDescription['kind'];
    element?: Element | null;
    inputs?: Record<string, unknown>;
    outputs?: Record<string, unknown>;
    properties?: Record<string, unknown>;
    /** Own state of the instance that is not a member (private fields, services, …). */
    state?: Record<string, unknown>;
}

/** A unit of the fake framework: a plain object whose members are plain properties. */
export interface FakeUnit {
    readonly name: string;
    readonly kind: UnitDescription['kind'];
    readonly element: Element | null;
    readonly inputs: Record<string, unknown>;
    readonly outputs: Record<string, unknown>;
    readonly properties: Record<string, unknown>;
    /** The object behind the unit: a live view of its members, so that expressions can read them. Never replaced. */
    readonly instance: Record<string, unknown>;
}

/** A reactive node of the fake framework. */
export abstract class FakeNode implements ReactiveNode {
    abstract kind: string;
    abstract holdsValue: boolean;
    version = 0;
    dirty = false;
    element: Element | null = null;
    readonly consumerNodes: FakeNode[] = [];
    protected producerNodes: FakeNode[] = [];

    constructor( public name?: string ) {}

    producers(): ReactiveNode[] {
        return this.producerNodes;
    }

    consumers(): ReactiveNode[] {
        return this.consumerNodes;
    }

    abstract peek(): unknown;

    /** A producer changed. */
    markDirty(): void {
        if ( !this.dirty ) {
            this.dirty = true;
            this.consumerNodes.forEach( c => c.markDirty() );
        }
    }

    protected link( producers: FakeNode[] ): void {
        this.producerNodes = producers;
        producers.forEach( p => p.consumerNodes.push( this ) );
    }
}

export class FakeSignal<T = unknown> extends FakeNode {
    kind = 'signal';
    holdsValue = true;

    constructor( private value: T, name: string | undefined, private readonly onWrite: ( node: FakeNode ) => void ) {
        super( name );
    }

    peek(): T {
        return this.value;
    }

    set( value: T ): void {
        if ( Object.is( value, this.value ) ) {
            return;
        }
        this.value = value;
        this.version++;
        this.consumerNodes.forEach( c => c.markDirty() );
        this.onWrite( this );
    }
}

export class FakeComputed<T = unknown> extends FakeNode {
    kind = 'computed';
    holdsValue = true;
    private cached: T | undefined;

    constructor( private readonly compute: () => T, deps: FakeNode[], name?: string ) {
        super( name );
        this.link( deps );
        this.dirty = true;
    }

    /** What a read does: recomputes if needed. `peek()` does not. */
    get(): T {
        if ( this.dirty ) {
            this.producerNodes.forEach( p => p instanceof FakeComputed && p.get() );
            const next = this.compute();
            this.dirty = false;
            if ( !Object.is( next, this.cached ) ) {
                this.cached = next;
                this.version++;
            }
        }
        return this.cached as T;
    }

    peek(): T | undefined {
        return this.cached;
    }
}

/** The render effect of a unit. It never changes version; `runs` counts its re-runs. */
export class FakeTemplate extends FakeNode {
    kind = 'template';
    holdsValue = false;
    runs = 0;

    constructor( element: Element, deps: FakeNode[], name?: string ) {
        super( name );
        this.element = element;
        this.link( deps );
        this.dirty = true;
    }

    /** The framework re-evaluated the template. */
    run(): void {
        this.producerNodes.forEach( p => p instanceof FakeComputed && p.get() );
        this.dirty = false;
        this.runs++;
    }

    peek(): undefined {
        return undefined;
    }
}

export interface FakeControlSpec {
    value?: unknown;
    element?: Element | null;
    required?: boolean;
}

/** A node of the fake form tree. Groups derive their value and status from their children. */
export class FakeFormNode implements FormNode {
    readonly raw: object = this;
    model = 'fake';
    element: Element | null | undefined;
    touched = false;
    dirty = false;
    disabled = false;
    errors: Array<[string, unknown]> = [];
    readonly #listeners = new Set<( ev: { kind: string; node: FormNode } ) => void>();
    #value: unknown;
    #parent: FakeFormNode | undefined;

    constructor( public key: string, public kind: FormNode['kind'], private readonly childNodes: FakeFormNode[] = [], spec: FakeControlSpec = {} ) {
        this.#value = spec.value;
        this.element = spec.element;
        childNodes.forEach( c => c.#parent = this );
    }

    children(): FormNode[] {
        return this.childNodes;
    }

    state(): FormState {
        const children = this.childNodes;
        const value = this.kind === 'control' ? this.#value
            : this.kind === 'array' ? children.map( c => c.state().value )
                : Object.fromEntries( children.map( c => [c.key, c.state().value] ) );
        const errors = [...this.errors, ...children.flatMap( c => c.state().errors )];
        return {
            value,
            status: this.disabled ? 'disabled' : errors.length ? 'invalid' : 'valid',
            errors,
            touched: this.touched || children.some( c => c.state().touched ),
            dirty: this.dirty || children.some( c => c.state().dirty )
        };
    }

    facts(): Array<[string, string]> {
        return [['model', this.model]];
    }

    actions(): Array<{ id: string; label: string; run(): void }> {
        return [{ id: 'touch', label: 'Mark touched', run: () => this.markTouched() }];
    }

    watch( cb: ( ev: { kind: string; node: FormNode } ) => void ): () => void {
        this.#listeners.add( cb );
        return () => void this.#listeners.delete( cb );
    }

    setValue( value: unknown ): void {
        this.#value = value;
        this.dirty = true;
        this.#notify( 'value' );
    }

    markTouched(): void {
        this.touched = true;
        this.#notify( 'touched' );
    }

    #notify( kind: string ): void {
        for ( let at: FakeFormNode | undefined = this; at; at = at.#parent ) {
            at.#listeners.forEach( cb => cb( { kind, node: this } ) );
        }
    }
}

/**
 * The in-memory world behind a fake adapter: plain objects as units, a tiny signal graph, a tiny form tree and scripted profile
 * events. Everything the debug features need can be set up with it, so feature tests need no framework.
 */
export class FakeWorld {
    /** What `env.taskSource()` returns. */
    task: string | undefined;
    /** How often `env.runOutside` and `env.flush` were used. */
    runOutsideCalls = 0;
    readonly flushed: Element[] = [];
    /** Whether a profiler sink is installed, i.e. whether the framework pays for profiling. */
    profilerActive = false;

    readonly #units = new Map<Element, FakeUnit[]>();
    readonly #owners = new Map<Element, FakeUnit>();
    readonly #sections = new Map<Element, Section[]>();
    readonly #templates = new Map<Element, FakeTemplate>();
    readonly #renderListeners = new Set<() => void>();
    readonly #writeListeners = new Set<( node: ReactiveNode ) => void>();
    readonly #forms: Array<{ root: FakeFormNode; element?: Element; unit?: Unit }> = [];
    readonly #controls = new Map<Unit, FakeFormNode>();
    #sink: ( ( ev: ProfileEvent ) => void ) | undefined;

    /** Adds a unit; those on the same element are listed component first. */
    unit( spec: FakeUnitSpec ): FakeUnit {
        const bags = { inputs: { ...spec.inputs }, outputs: { ...spec.outputs }, properties: { ...spec.properties }, state: { ...spec.state } };
        const order = [bags.state, bags.inputs, bags.outputs, bags.properties];
        const instance = new Proxy( {} as Record<string, unknown>, {
            get: ( _t, key ) => ( order.find( bag => key in bag ) as Record<string | symbol, unknown> | undefined )?.[key],
            has: ( _t, key ) => order.some( bag => key in bag ),
            ownKeys: () => Array.from( new Set( order.flatMap( bag => Object.keys( bag ) ) ) ),
            getOwnPropertyDescriptor: ( _t, key ) => order.some( bag => key in bag ) ? { configurable: true, enumerable: true, writable: true } : undefined
        } );
        const unit: FakeUnit = {
            name: spec.name, kind: spec.kind ?? 'component', element: spec.element ?? null, ...bags, instance
        };
        if ( unit.element ) {
            const list = this.#units.get( unit.element ) ?? [];
            list.push( unit );
            list.sort( ( a, b ) => Number( b.kind === 'component' ) - Number( a.kind === 'component' ) );
            this.#units.set( unit.element, list );
        }
        return unit;
    }

    unitsAt( el: Element ): FakeUnit[] {
        return this.#units.get( el ) ?? [];
    }

    /** The unit that owns the element (the component whose template created it). */
    setOwner( el: Element, unit: FakeUnit ): void {
        this.#owners.set( el, unit );
    }

    ownerOf( el: Element ): FakeUnit | undefined {
        return this.#owners.get( el );
    }

    addSection( el: Element, section: Section ): void {
        this.#sections.set( el, [...this.#sections.get( el ) ?? [], section] );
    }

    sectionsOf( el: Element ): Section[] {
        return this.#sections.get( el ) ?? [];
    }

    signal<T>( value: T, name?: string ): FakeSignal<T> {
        return new FakeSignal( value, name, node => this.#writeListeners.forEach( cb => cb( node ) ) );
    }

    computed<T>( compute: () => T, deps: FakeNode[], name?: string ): FakeComputed<T> {
        return new FakeComputed( compute, deps, name );
    }

    /** The render node of the element's component. */
    template( element: Element, deps: FakeNode[], name?: string ): FakeTemplate {
        const node = new FakeTemplate( element, deps, name );
        this.#templates.set( element, node );
        return node;
    }

    templateOf( el: Element ): FakeTemplate | undefined {
        return this.#templates.get( el );
    }

    control( key: string, spec: FakeControlSpec = {} ): FakeFormNode {
        return new FakeFormNode( key, 'control', [], spec );
    }

    group( key: string, children: FakeFormNode[], kind: 'group' | 'array' = 'group' ): FakeFormNode {
        return new FakeFormNode( key, kind, children );
    }

    addForm( root: FakeFormNode, element?: Element, unit?: Unit ): void {
        this.#forms.push( { root, element, unit } );
    }

    /** Binds a unit to a control, for `forms.controlOf`. */
    bindControl( unit: Unit, control: FakeFormNode ): void {
        this.#controls.set( unit, control );
    }

    forms(): ReadonlyArray<{ root: FakeFormNode; element?: Element; unit?: Unit }> {
        return this.#forms;
    }

    controlOf( unit: Unit ): FakeFormNode | undefined {
        return this.#controls.get( unit );
    }

    /** The framework finished a render: calls what was registered with `env.onRender`. */
    render(): void {
        this.#renderListeners.forEach( cb => cb() );
    }

    onRender( cb: () => void ): () => void {
        this.#renderListeners.add( cb );
        return () => void this.#renderListeners.delete( cb );
    }

    onWrite( cb: ( node: ReactiveNode ) => void ): () => void {
        this.#writeListeners.add( cb );
        return () => void this.#writeListeners.delete( cb );
    }

    startProfiler( sink: ( ev: ProfileEvent ) => void ): () => void {
        this.#sink = sink;
        this.profilerActive = true;
        return () => {
            this.#sink = undefined;
            this.profilerActive = false;
        };
    }

    /** Delivers a profile event, if someone listens. */
    emit( ev: ProfileEvent ): void {
        this.#sink?.( ev );
    }

    /** `begin` and `end` of a kind around `inner`. */
    span( kind: ProfileEvent['kind'], unit: Unit | undefined, inner?: () => void, name?: string ): void {
        this.emit( { phase: 'begin', kind, unit, name } );
        inner?.();
        this.emit( { phase: 'end', kind, unit, name } );
    }
}

const pathOf = ( el: Element ): string => {
    const indices: number[] = [];
    for ( let at: Element | null = el; at && at !== document.body && at.parentElement; at = at.parentElement ) {
        indices.unshift( Array.prototype.indexOf.call( at.parentElement.children, at ) );
    }
    return indices.join( '/' );
};

export type FakeAdapter = FrameworkAdapter & { readonly world: FakeWorld };

/** An in-memory adapter over a {@link FakeWorld}; it exercises every capability. */
export function fakeAdapter( options: FakeAdapterOptions = {} ): FakeAdapter {
    const world = new FakeWorld();
    const has = ( capability: FakeCapability ): boolean => !options.capabilities || options.capabilities.includes( capability );
    const describe = ( unit: Unit ): UnitDescription => {
        const u = unit as FakeUnit;
        return { name: u.name, kind: u.kind, element: u.element };
    };
    const members = ( unit: Unit ): Member[] => {
        const u = unit as FakeUnit;
        return ( [['inputs', u.inputs], ['outputs', u.outputs], ['properties', u.properties]] as const )
            .flatMap( ( [group, bag] ) => Object.keys( bag ).map( name => ( { group, name, read: () => bag[name] } ) ) );
    };

    const adapter: FrameworkAdapter & { world: FakeWorld } = {
        world,
        meta: { contract: options.contract ?? ADAPTER_CONTRACT, id: options.id ?? 'fake', name: 'Fake', version: '0' },
        env: {
            isDev: () => options.dev !== false,
            runOutside: fn => {
                world.runOutsideCalls++;
                return fn();
            },
            onRender: cb => world.onRender( cb ),
            flush: el => void world.flushed.push( el ),
            taskSource: () => world.task,
            internalFrames: /fake-framework/
        },
        units: {
            at: el => world.unitsAt( el ),
            describe,
            members,
            instance: unit => ( unit as FakeUnit ).instance,
            owner: el => world.ownerOf( el ),
            sections: el => world.sectionsOf( el )
        },
        reactivity: has( 'reactivity' ) ? {
            nodeOf: value => value instanceof FakeNode ? value : undefined,
            renderNodeOf: el => world.templateOf( el ),
            onWrite: cb => world.onWrite( cb )
        } : undefined,
        forms: has( 'forms' ) ? {
            scan: () => world.forms().map( f => ( { ...f } ) ),
            controlOf: unit => world.controlOf( unit )
        } : undefined,
        profiler: has( 'profiler' ) ? { start: sink => world.startProfiler( sink ) } : undefined,
        addressing: has( 'addressing' ) ? {
            of: ( unit, el ) => `${pathOf( el )}=${( unit as FakeUnit ).name}`,
            resolve: address => {
                const [path, name] = address.split( '=' );
                let element: Element | null = document.body;
                for ( const index of path ? path.split( '/' ) : [] ) {
                    element = element?.children[Number( index )] ?? null;
                }
                const unit = element && world.unitsAt( element ).find( u => u.name === name );
                return unit && element ? { unit, element } : undefined;
            }
        } : undefined
    };
    return adapter;
}
