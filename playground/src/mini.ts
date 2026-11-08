/**
 * A very small "framework" for the playground: signals, computed values, effects, and units (component or directive instances)
 * that are attached to elements under an identifier. It only has to be enough for the adapter in ./adapter.ts to have something
 * real to translate.
 */

// ---------------------------------------------------------------------------------------------------------------------
// reactivity

interface Producer {
    version: number;
    consumerSet: Set<Consumer>;
}

interface Consumer {
    producerSet: Set<Producer>;
    invalidate(): void;
}

let active: Consumer | undefined;
const writeHooks = new Set<( node: ReactiveBase ) => void>();

export const onWrite = ( cb: ( node: ReactiveBase ) => void ): ( () => void ) => {
    writeHooks.add( cb );
    return () => void writeHooks.delete( cb );
};

function track( producer: Producer ): void {
    if ( active ) {
        producer.consumerSet.add( active );
        active.producerSet.add( producer );
    }
}

function withConsumer<T>( consumer: Consumer, fn: () => T ): T {
    const previous = active;
    // The old dependencies are dropped; the run finds the current ones again.
    consumer.producerSet.forEach( p => p.consumerSet.delete( consumer ) );
    consumer.producerSet.clear();
    active = consumer;
    try {
        return fn();
    } finally {
        active = previous;
    }
}

/** What the adapter sees of every reactive node. */
export abstract class ReactiveBase implements Producer {
    abstract kind: string;
    abstract holdsValue: boolean;
    version = 0;
    dirty = false;
    runs?: number;
    element?: Element | null;
    readonly consumerSet = new Set<Consumer>();

    constructor( public name?: string ) {}

    abstract peek(): unknown;

    producers(): ReactiveBase[] {
        return [];
    }

    consumers(): ReactiveBase[] {
        return Array.from( this.consumerSet ) as unknown as ReactiveBase[];
    }
}

export class Signal<T> extends ReactiveBase {
    kind = 'signal';
    holdsValue = true;

    constructor( private value: T, name?: string ) {
        super( name );
    }

    get(): T {
        track( this );
        return this.value;
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
        Array.from( this.consumerSet ).forEach( c => c.invalidate() );
        writeHooks.forEach( hook => hook( this ) );
        scheduleRender();
    }

    update( fn: ( value: T ) => T ): void {
        this.set( fn( this.value ) );
    }
}

export class Computed<T> extends ReactiveBase implements Consumer {
    kind = 'computed';
    holdsValue = true;
    readonly producerSet = new Set<Producer>();
    private cached: T | undefined;

    constructor( private readonly compute: () => T, name?: string ) {
        super( name );
        this.dirty = true;
    }

    get(): T {
        track( this );
        if ( this.dirty ) {
            const next = withConsumer( this, this.compute );
            this.dirty = false;
            if ( !Object.is( next, this.cached ) ) {
                this.cached = next;
                this.version++;
            }
        }
        return this.cached as T;
    }

    /** The last value, without recomputing: a computed nobody read since a change is still the old one. */
    peek(): T | undefined {
        return this.cached;
    }

    invalidate(): void {
        if ( !this.dirty ) {
            this.dirty = true;
            Array.from( this.consumerSet ).forEach( c => c.invalidate() );
        }
    }

    override producers(): ReactiveBase[] {
        return Array.from( this.producerSet ) as unknown as ReactiveBase[];
    }
}

/** Runs `fn` now and again (in a microtask) after any signal it read has changed. A render effect is one with the kind `template`. */
export class Effect extends ReactiveBase implements Consumer {
    kind: string;
    holdsValue = false;
    override runs = 0;
    readonly producerSet = new Set<Producer>();
    private scheduled = false;

    constructor( private readonly fn: () => void, name?: string, kind = 'effect' ) {
        super( name );
        this.kind = kind;
        this.run();
    }

    run(): void {
        this.scheduled = false;
        this.dirty = false;
        withConsumer( this, this.fn );
        this.runs++;
    }

    invalidate(): void {
        this.dirty = true;
        if ( !this.scheduled ) {
            this.scheduled = true;
            queueMicrotask( () => this.run() );
        }
    }

    peek(): undefined {
        return undefined;
    }

    override producers(): ReactiveBase[] {
        return Array.from( this.producerSet ) as unknown as ReactiveBase[];
    }
}

export const signal = <T>( value: T, name?: string ): Signal<T> => new Signal( value, name );
export const computed = <T>( fn: () => T, name?: string ): Computed<T> => new Computed( fn, name );

// ---------------------------------------------------------------------------------------------------------------------
// render notifications and tasks

const renderListeners = new Set<() => void>();
let renderScheduled = false;

/** The framework reports that it rendered; coalesced into one call per microtask burst. */
export function scheduleRender(): void {
    if ( !renderScheduled ) {
        renderScheduled = true;
        // After the effects (which are microtasks queued earlier) have run.
        queueMicrotask( () => queueMicrotask( () => {
            renderScheduled = false;
            renderListeners.forEach( cb => cb() );
        } ) );
    }
}

export const onRender = ( cb: () => void ): ( () => void ) => {
    renderListeners.add( cb );
    return () => void renderListeners.delete( cb );
};

/** What the runtime is executing outside of a DOM event; the adapter reports it as the trigger. */
export let currentTask: string | undefined;

export function inTask<T>( name: string, fn: () => T ): T {
    const previous = currentTask;
    currentTask = name;
    try {
        return fn();
    } finally {
        currentTask = previous;
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// units

export interface UnitOptions {
    kind?: 'component' | 'directive';
    /** Names of the instance properties that are inputs. */
    inputs?: string[];
    /** Names of the instance properties that are outputs. */
    outputs?: string[];
    /** What the unit's injector provides, for the "providers" section. */
    providers?: Array<{ title: string; chips?: string[]; owner?: string; detail?: string }>;
}

/** A unit: an object attached to an element under an identifier. */
export interface PlaygroundUnit {
    readonly name: string;
    readonly kind: 'component' | 'directive';
    readonly element: Element;
    readonly instance: object;
    readonly inputs: readonly string[];
    readonly outputs: readonly string[];
    readonly providers: NonNullable<UnitOptions['providers']>;
    /** The effect that renders the unit, if it has one. */
    template?: Effect;
}

const registry = new WeakMap<Element, PlaygroundUnit[]>();

/** The identifier of an attachment is the value of `data-unit` (several units on one element are separated by spaces). */
export const UNIT_ATTR = 'data-unit';

export function unitsOn( el: Element ): PlaygroundUnit[] {
    return registry.get( el ) ?? [];
}

/**
 * Attaches an instance to an element under an identifier. With `render`, the unit also gets a template effect that re-runs
 * when the signals it read change.
 */
export function attach<T extends object>(
    el: Element, name: string, instance: T, options: UnitOptions & { render?: ( self: T ) => void } = {}
): T {
    const unit: PlaygroundUnit = {
        name, kind: options.kind ?? 'component', element: el, instance,
        inputs: options.inputs ?? [], outputs: options.outputs ?? [], providers: options.providers ?? []
    };
    const list = [...unitsOn( el ), unit].sort( ( a, b ) => Number( b.kind === 'component' ) - Number( a.kind === 'component' ) );
    registry.set( el, list );
    el.setAttribute( UNIT_ATTR, list.map( u => u.name ).join( ' ' ) );
    if ( options.render ) {
        const render = options.render;
        unit.template = new Effect( () => render( instance ), `${name} template`, 'template' );
        unit.template.element = el;
        scheduleRender();
    }
    return instance;
}

export function detach( el: Element ): void {
    registry.delete( el );
    el.removeAttribute( UNIT_ATTR );
}
