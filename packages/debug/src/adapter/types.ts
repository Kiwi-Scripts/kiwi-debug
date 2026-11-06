/**
 * The contract between kiwi-debug and a concrete framework. See docs/kiwi-debug-spec.md, section 3.
 * One required part (`env`, `units`) and four optional capabilities; a feature is only enabled when the capabilities it needs exist.
 */

export type FeatureId = 'inspector' | 'watch' | 'search' | 'graph' | 'forms' | 'profiler';

/** Opaque, identity-stable handle for a component/directive instance (or fiber, vue instance, …). Used as a WeakMap key by the core. */
export type Unit = object;

export interface AdapterMeta {
    /** Version of the adapter contract (`FrameworkAdapter`) the adapter was written against. Integer; set it to `ADAPTER_CONTRACT`. */
    contract: number;
    id: string;
    name: string;
    /** Detected framework version. */
    version?: string;
    /** Features relying on private or unstable framework API, and on what. Shown in the feature's help text. */
    fragile?: Partial<Record<FeatureId, string>>;
}

export interface FrameworkAdapter {
    readonly meta: AdapterMeta;
    readonly env: EnvApi;
    readonly units: UnitsApi;
    /** Graph, signal rows, change versions. */
    readonly reactivity?: ReactivityApi;
    /** Forms inspector, form rows. */
    readonly forms?: FormsApi;
    /** Render profiler. */
    readonly profiler?: ProfilerApi;
    /** Persistence of tracked values. */
    readonly addressing?: AddressingApi;
}

/** What the core works with: the same shape, but no member throws (see `guardAdapter`). */
export type GuardedAdapter = FrameworkAdapter;

// ---------------------------------------------------------------------------------------------------------------------
// env

export interface EnvApi<Scope = unknown> {
    /** False in production builds: the whole overlay becomes a no-op. */
    isDev(): boolean;
    /** Runs `fn` where it cannot trigger the framework's change detection (e.g. outside the zone). Default: `fn()`. */
    runOutside?<T>( fn: () => T ): T;
    /** The framework has just rendered/committed. `scope` is the opaque owner scope of the page layer, e.g. an injector. */
    onRender?( cb: () => void, scope?: Scope ): () => void;
    /** Redraw the units under `el` now, after a programmatic state change (form actions). */
    flush?( el: Element ): void;
    /** What the runtime is executing when there is no DOM event, e.g. 'setTimeout' or 'Promise.then'. Used as a trigger label. */
    taskSource?(): string | undefined;
    /** Stack frames of the framework and its runtime, skipped when locating a cause. */
    internalFrames?: RegExp;
}

// ---------------------------------------------------------------------------------------------------------------------
// units

export interface UnitDescription {
    name: string;
    kind: 'component' | 'directive' | 'other';
    element: Element | null;
}

export interface UnitsApi {
    /** Units attached to the element, component first. `[]` means "not inspectable". */
    at( el: Element ): Unit[];
    describe( unit: Unit ): UnitDescription;
    /** Inputs, outputs and state of a unit. The core adds form rows (`forms.controlOf`) and change tracking. */
    members( unit: Unit ): Member[];
    /** The component whose template created the element. */
    owner?( el: Element ): Unit | undefined;
    /** Extra, lazily read information for an element: injector, context, listeners, providers, … */
    sections?( el: Element ): Section[];
}

export interface Member {
    group: 'inputs' | 'outputs' | 'properties' | ( string & {} );
    /** Property name. */
    name: string;
    /** Template-facing alias if it differs. */
    label?: string;
    /** May throw; the core displays `?` for a value that cannot be read. */
    read(): unknown;
}

export interface SectionItem {
    title: string;
    chips?: string[];
    owner?: string;
    detail?: string;
}

export interface Section {
    id: string;
    label: string;
    /** What clicking the link logs. */
    read(): unknown;
    /** If present the inspector shows a collapsible list with a count badge (e.g. providers). */
    list?(): SectionItem[];
}

// ---------------------------------------------------------------------------------------------------------------------
// reactivity

export interface ReactivityApi {
    /** The reactive node behind a value (signal, computed, ref, store field), or undefined for a plain value. */
    nodeOf( value: unknown ): ReactiveNode | undefined;
    /** The node of the render effect/template of the unit on `el`, if the framework has one. */
    renderNodeOf?( el: Element ): ReactiveNode | undefined;
    /** Subscribes to every write of a reactive value. Called inside the writer's context; the core hops out via `env.runOutside`. Must chain with other installed hooks. */
    onWrite( cb: ( node: ReactiveNode ) => void ): () => void;
}

export interface ReactiveNode {
    /** Display: 'signal', 'computed', 'effect', 'template', 'query', … */
    kind: string;
    /** Debug name; if missing the core derives one from the nearest named consumer. */
    name?: string;
    /** Whether `peek()` is a value worth showing (signal, computed, linked) as opposed to effects and templates. */
    holdsValue: boolean;
    /** Increments on change; lets the core diff without reading. */
    version: number;
    dirty: boolean;
    /** Counts re-runs of nodes that never change version (effects, templates), e.g. Σ of producers' last-read versions. */
    runs?: number;
    producers(): ReactiveNode[];
    consumers(): ReactiveNode[];
    /** Current value WITHOUT recomputing. A computed nobody read keeps its old value. */
    peek(): unknown;
    /** Hint: the element this node belongs to. */
    element?: Element | null;
}

// ---------------------------------------------------------------------------------------------------------------------
// forms

export interface FormsApi {
    /** All form roots in the page, in page order. */
    scan(): FormBinding[];
    /** The control a unit is bound to (for the extra value/status/errors/touched/dirty rows). */
    controlOf?( unit: Unit ): FormNode | undefined;
}

export interface FormBinding {
    root: FormNode;
    element?: Element;
    unit?: Unit;
    hint?: string;
}

export interface FormNode {
    /** Identity. */
    readonly raw: object;
    key: string;
    kind: 'control' | 'group' | 'array';
    /** Display tag: 'reactive', 'signal', … */
    model: string;
    /** Bound element. */
    element?: Element | null;
    children(): FormNode[];
    state(): FormState;
    /** updateOn, required, min, … */
    facts?(): Array<[name: string, value: string]>;
    actions?(): Array<{ id: string; label: string; run(): void }>;
    /** Root only: native event stream. Without it the core logs diffs between refreshes. */
    watch?( cb: ( ev: { kind: string; node: FormNode } ) => void ): () => void;
}

export interface FormState {
    value: unknown;
    status: 'valid' | 'invalid' | 'pending' | 'disabled';
    errors: Array<[kind: string, detail: unknown]>;
    touched: boolean;
    dirty: boolean;
    /** E.g. 'hidden'. */
    extra?: string[];
}

// ---------------------------------------------------------------------------------------------------------------------
// profiler

export interface ProfilerApi {
    /** Starts delivering events synchronously and in order. MUST cost nothing before `start` and nothing after the returned stop. */
    start( sink: ( ev: ProfileEvent ) => void ): () => void;
}

export type ProfileKind = 'cycle' | 'sync' | 'visit' | 'render' | 'create' | 'hook' | 'host' | 'post';

/**
 * One begin or end marker the framework reports. The raw input of the profiler: the core assembles ticks from the stream
 * (spec 3.2, "Profile events and ticks").
 */
export interface ProfileEvent {
    phase: 'begin' | 'end';
    kind: ProfileKind;
    /** Whatever the framework reports; the core decides by `describe( unit ).kind`. */
    unit?: Unit;
    /** Hook name for 'hook'. */
    name?: string;
    /** `performance.now()`; default: arrival time. Lets retroactive sources (React commits) emit begin/end pairs. */
    time?: number;
}

// ---------------------------------------------------------------------------------------------------------------------
// addressing

export interface AddressingApi {
    /** A string that identifies the unit in the live view tree and is stable across reloads of the same page. */
    of( unit: Unit, el: Element ): string | undefined;
    /** Inverse. Returns undefined, never a wrong unit, if anything does not match. */
    resolve( address: string ): { unit: Unit; element: Element } | undefined;
}
