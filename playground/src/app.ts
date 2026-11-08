import { htmlEl } from '@kiwi-js/dom';

import { attach, computed, inTask, signal, type Signal } from './mini';

/**
 * The demo app. Every piece is a unit attached to an element; the data is chosen to exercise the overlay: signals and computed
 * values, nested objects, arrays that need paging, Map and Set, a cycle, a getter, state that is not a member, outputs, and
 * several units on one element.
 */

// ---------------------------------------------------------------------------------------------------------------------
// Tooltip: a directive that sits on other units' elements

function tooltip( el: Element, text: string, placement = 'top' ): void {
    attach( el, 'Tooltip', { text, placement, shown: signal( false, 'shown' ) }, { kind: 'directive', inputs: ['text', 'placement'] } );
    el.setAttribute( 'title', text );
}

// ---------------------------------------------------------------------------------------------------------------------
// Counter

/** A service that several units are given: the Pears get an instance of their own, as if the injector had been overridden for them. */
const appLogger = { level: 'debug', lines: [] as string[] };

class CounterState {
    readonly count: Signal<number>;
    readonly double;
    history: number[] = [];
    /** An output: just an object that components could subscribe to. */
    readonly changed = { subscribers: 0, last: null as number | null };
    /** Not a member (it starts with an underscore), but reachable through an expression: `_cache.hits`. */
    _cache = { hits: 0, byStep: new Map<number, number>() };

    constructor( public label: string, public step: number, start: number, public logger = appLogger ) {
        this.count = signal( start, `${label} count` );
        this.double = computed( () => this.count.get() * 2, `${label} double` );
    }

    get summary(): string {
        return `${this.label}: ${this.count.peek()}`;
    }

    bump( by: number ): void {
        this.count.update( v => v + by );
        this.history.push( this.count.peek() );
        this._cache.hits++;
        this._cache.byStep.set( by, ( this._cache.byStep.get( by ) ?? 0 ) + 1 );
        this.changed.last = this.count.peek();
    }
}

function counter( label: string, step: number, start = 0, logger = appLogger ): HTMLElement {
    const root = htmlEl( 'section', { class: 'card' } );
    const state = new CounterState( label, step, start, logger );
    const text = htmlEl( 'span', { class: 'value' } );
    const plus = htmlEl( 'button', { text: `+${step}`, on: { click: () => state.bump( step ) } } );
    const minus = htmlEl( 'button', { text: `-${step}`, on: { click: () => state.bump( -step ) } } );
    const reset = htmlEl( 'button', { text: 'reset', on: { click: () => { state.count.set( 0 ); state.history = []; } } } );
    root.append( htmlEl( 'h3', { text: label } ), text, htmlEl( 'div', { class: 'row' }, plus, minus, reset ) );
    tooltip( plus, `Adds ${step}` );
    tooltip( minus, `Subtracts ${step}`, 'bottom' );
    attach( root, 'Counter', state, {
        inputs: ['label', 'step'],
        outputs: ['changed'],
        providers: [{ title: 'CounterService', chips: ['root'] }, { title: 'LOG_LEVEL', chips: ['value', 'debug'], detail: 'InjectionToken' }],
        render: self => void ( text.textContent = `${self.count.get()}  (×2 = ${self.double.get()})` )
    } );
    return root;
}

// ---------------------------------------------------------------------------------------------------------------------
// Todo list

interface Todo {
    id: number;
    text: string;
    done: Signal<boolean>;
    tags: string[];
    meta: { created: Date; owner: { name: string } };
}

const todo = ( id: number, text: string, tags: string[] = [], done = false ): Todo => ( {
    id, text, done: signal( done, `todo ${id} done` ), tags, meta: { created: new Date( 2026, 0, id ), owner: { name: id % 2 ? 'Ann' : 'Ben' } }
} );

function todoItem( item: Todo, remove: () => void ): HTMLElement {
    const li = htmlEl( 'li' );
    const box = htmlEl( 'input', { attrs: { type: 'checkbox' }, on: { change: () => item.done.set( !item.done.peek() ) } } );
    const label = htmlEl( 'span' );
    const del = htmlEl( 'button', { text: '✕', class: 'icon', on: { click: remove } } );
    li.append( box, label, del );
    tooltip( del, 'Remove' );
    attach( li, 'TodoItem', { todo: item, selected: false }, {
        key: String( item.id ),
        inputs: ['todo'],
        render: () => {
            box.checked = item.done.get();
            label.textContent = item.text;
            label.classList.toggle( 'done', item.done.get() );
        }
    } );
    return li;
}

function todoList(): HTMLElement {
    const root = htmlEl( 'section', { class: 'card' } );
    const todos = signal<Todo[]>( [todo( 1, 'Read the spec', ['docs'] ), todo( 2, 'Try the overlay', ['ui', 'fun'] ), todo( 3, 'Write a test', ['tests'], true )], 'todos' );
    const filter = signal<'all' | 'open' | 'done'>( 'all', 'filter' );
    const visible = computed( () => todos.get().filter( t => filter.get() === 'all' || ( filter.get() === 'done' ) === t.done.get() ), 'visible' );
    const list = htmlEl( 'ul' );
    let nextId = 4;
    const input = htmlEl( 'input', { attrs: { placeholder: 'new todo' } } );
    const add = (): void => {
        if ( input.value.trim() ) {
            todos.update( all => [...all, todo( nextId++, input.value.trim(), ['new'] )] );
            input.value = '';
        }
    };
    const filters = ( ['all', 'open', 'done'] as const ).map( f => htmlEl( 'button', { text: f, on: { click: () => filter.set( f ) } } ) );
    root.append( htmlEl( 'h3', { text: 'Todos' } ), htmlEl( 'div', { class: 'row' }, ...filters ), list, htmlEl( 'div', { class: 'row' }, input, htmlEl( 'button', { text: 'add', on: { click: add } } ) ) );
    attach( root, 'TodoList', { todos, filter, visible }, {
        // The list is rebuilt when the todos or the filter change; the items re-render themselves when one is ticked.
        render: () => {
            list.querySelectorAll( '[data-unit]' ).forEach( el => el.remove() );
            list.replaceChildren( ...visible.get().map( item => todoItem( item, () => todos.update( all => all.filter( t => t !== item ) ) ) ) );
        },
        providers: [{ title: 'TodoStore', chips: ['root', 'stateful'], detail: 'keeps the todos in memory' }]
    } );
    return root;
}

// ---------------------------------------------------------------------------------------------------------------------
// User card: deep, odd data

interface User {
    id: number;
    name: string;
    address: { street: string; city: string; geo: { lat: number; lng: number } };
    roles: Set<string>;
    prefs: Map<string, unknown>;
    scores: number[];
    manager: User | null;
    reports: User[];
    createdAt: Date;
}

function makeUsers(): User {
    const boss: User = {
        id: 1, name: 'Dana Boss', address: { street: '1 Main St', city: 'Springfield', geo: { lat: 39.78, lng: -89.65 } },
        roles: new Set( ['admin', 'owner'] ), prefs: new Map<string, unknown>( [['theme', 'dark'], ['limits', { daily: 10, weekly: 50 }]] ),
        scores: [], manager: null, reports: [], createdAt: new Date( 2020, 5, 1 )
    };
    const user: User = {
        id: 2, name: 'Eli Worker', address: { street: '22 Side Rd', city: 'Shelbyville', geo: { lat: 39.4, lng: -88.8 } },
        roles: new Set( ['editor'] ), prefs: new Map<string, unknown>( [['theme', 'light'], ['tags', ['a', 'b']]] ),
        // A long array: it needs paging in the value tree.
        scores: Array.from( { length: 120 }, ( _, i ) => i * 3 ), manager: boss, reports: [], createdAt: new Date( 2024, 2, 14 )
    };
    boss.reports.push( user );
    return user;
}

class UserCardState {
    readonly lastSeen = signal( { when: new Date( 2026, 0, 1 ), page: '/home' }, 'lastSeen' );
    _cache = { hits: 0 };

    constructor( public user: User, public compact: boolean ) {}

    /** A getter on the prototype: not a member, but an expression can read it (`fullName`). */
    get fullName(): string {
        return `${this.user.name} (#${this.user.id})`;
    }
}

function userCard(): HTMLElement {
    const root = htmlEl( 'section', { class: 'card' } );
    const state = new UserCardState( makeUsers(), false );
    const name = htmlEl( 'span', { class: 'value' } );
    const touch = htmlEl( 'button', { text: 'touch', on: { click: () => {
        // The same content again: the signal was written, but its text does not change ("value written").
        state.lastSeen.set( { when: state.lastSeen.peek().when, page: state.lastSeen.peek().page } );
        state._cache.hits++;
    } } } );
    const move = htmlEl( 'button', { text: 'move', on: { click: () => {
        // A plain mutation nobody is notified about: it shows up with `valueDetail: 'detail'`.
        state.user.address.city = state.user.address.city === 'Shelbyville' ? 'Capital City' : 'Shelbyville';
        state.user.address.geo.lat += 1;
    } } } );
    const page = htmlEl( 'button', { text: 'next page', on: { click: () => state.lastSeen.set( { when: new Date(), page: `/page/${Math.floor( Math.random() * 90 + 10 )}` } ) } } );
    root.append( htmlEl( 'h3', { text: 'User card' } ), name, htmlEl( 'div', { class: 'row' }, touch, move, page ) );
    tooltip( move, 'Mutates the address in place' );
    attach( root, 'UserCard', state, {
        inputs: ['user', 'compact'],
        render: self => void ( name.textContent = `${self.fullName} — ${self.lastSeen.get().page}` )
    } );
    return root;
}

// ---------------------------------------------------------------------------------------------------------------------
// Ticker: writes outside of any DOM event

function ticker(): HTMLElement {
    const root = htmlEl( 'section', { class: 'card' } );
    const state = { logger: appLogger, ticks: signal( 0, 'ticks' ), interval: 1000, running: signal( true, 'running' ), startedAt: new Date() };
    const text = htmlEl( 'span', { class: 'value' } );
    const toggle = htmlEl( 'button', { text: 'pause', on: { click: () => state.running.update( v => !v ) } } );
    root.append( htmlEl( 'h3', { text: 'Ticker' } ), text, htmlEl( 'div', { class: 'row' }, toggle ) );
    // Written from a timer, so the trigger of a change is a task and not a click.
    setInterval( () => inTask( 'setInterval', () => state.running.peek() && state.ticks.update( v => v + 1 ) ), state.interval );
    attach( root, 'Ticker', state, {
        inputs: ['interval'],
        render: () => {
            text.textContent = `${state.ticks.get()} ticks`;
            toggle.textContent = state.running.get() ? 'pause' : 'resume';
        }
    } );
    return root;
}

// ---------------------------------------------------------------------------------------------------------------------
// One element, several units

function multi(): HTMLElement {
    const root = htmlEl( 'section', { class: 'card' } );
    const panel = htmlEl( 'div', { class: 'row' } );
    const button = htmlEl( 'button', { text: 'component + 2 directives' } );
    panel.append( button );
    root.append( htmlEl( 'h3', { text: 'Several units' } ), panel );
    // Directives are attached first on purpose: the component is still listed first.
    attach( button, 'Highlight', { color: 'gold', active: signal( false, 'active' ) }, { kind: 'directive', inputs: ['color'] } );
    attach( button, 'Tooltip', { text: 'Three units share this button', placement: 'right', shown: signal( false, 'shown' ) }, { kind: 'directive', inputs: ['text', 'placement'] } );
    const fancy = { variant: 'primary', pressed: signal( 0, 'pressed' ) };
    attach( button, 'FancyButton', fancy, {
        inputs: ['variant'],
        render: self => void button.setAttribute( 'data-pressed', String( self.pressed.get() ) )
    } );
    button.addEventListener( 'click', () => fancy.pressed.update( v => v + 1 ) );
    return root;
}

// ---------------------------------------------------------------------------------------------------------------------
// Root

export function buildApp( container: HTMLElement ): void {
    const shell = htmlEl( 'main', { class: 'app' } );
    const grid = htmlEl( 'div', { class: 'grid' } );
    grid.append( counter( 'Apples', 1, 3 ), counter( 'Pears', 5, 0, { level: 'warn', lines: [] } ), todoList(), userCard(), ticker(), multi() );
    shell.append( htmlEl( 'h2', { text: 'Demo app' } ), grid );
    const config = { env: 'playground', flags: { beta: true, experiments: ['a', 'b'] }, startedAt: new Date() };
    attach( shell, 'AppRoot', { title: 'Kiwi playground', theme: signal<'dark' | 'light'>( 'dark', 'theme' ), config }, {
        inputs: ['title'],
        providers: [{ title: 'Router', chips: ['root'] }, { title: 'AppConfig', chips: ['root', 'value'], detail: 'static configuration' }]
    } );
    container.append( shell );
}
