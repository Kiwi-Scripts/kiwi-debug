# @kiwi-js/debug

A framework-agnostic in-page debug overlay: a hover inspector, value tracking and diagnostic panels. It never talks to a framework directly; a framework **adapter** (for example [`@kiwi-js/debug-angular`](https://www.npmjs.com/package/@kiwi-js/debug-angular)) translates between the two. Built on [`@kiwi-js/panels`](https://github.com/Kiwi-Scripts/kiwi-panels).

## Entry points

| Import | Content |
|---|---|
| `@kiwi-js/debug` | `enableDebug`, options and feature types |
| `@kiwi-js/debug/adapter` | The adapter contract and `defineAdapter`; what adapter packages import |
| `@kiwi-js/debug/testkit` | `fakeAdapter` and the adapter conformance suite; for adapter tests |

## Customizing the buttons

The buttons of a value row and of a unit head are *actions*. Without configuration you get the defaults (rows: `track`, `graph`, `expressions`; units: `track`, `graph`, `address`, `keep`, `side`, `remove`, each where it makes sense). A list replaces the default of its kind; items are built-ins by name or your own definitions:

```ts
enableDebug( {
    adapter,
    actions: {
        row: [
            'track', 'expressions',
            { id: 'copy', icon: '⧉', title: 'Copy the value as JSON', run: ( { row } ) => navigator.clipboard.writeText( JSON.stringify( row?.read() ) ) }
        ]
    }
} );
```

A definition may also set `slot` ('leading' before the name, 'trailing' after the value), `surfaces`, `visible( c )` and `isOn( c )` for toggles.

## Looking deeper into values

- `valueDetail: 'detail'` lets arrays and objects open in place in every value row (default `'summary'`: one line per value), references included.
- The one-line preview of an object shows its `id`, `name`, `key` and `title` when it has them (`{ id: 3, name: "Ada", … }`); `previewKeys` changes which. Only objects, arrays and functions log to the console when clicked; a string or a number is just what is shown.
- The `expressions` panel (tray button, `E`, or the `expressions` action on a row) is a small panel with a path input (its ‹ › buttons step through the last 20 inputs, like a browser: an input is kept when it is replaced, e.g. by Pin, or tracked) (`items[0].name`, `a?.b`, `$1.users[2]`) and the live, detailed value it leads to. Click a name in the tree to extend the path. `Track` keeps the path as a tracked value in the watch list, `Pin` turns an object into a reference `$n` that paths can start at. Paths are re-evaluated on every refresh; calls and operators are not part of the syntax.
- References are kept: a pin remembers the path that led to its object and the address of the unit that path starts at, so it comes back after a reload (the adapter needs `addressing`). Hovering a reference outlines the element it was found on, and the title of a pin tracks the value it was found at, and `other refs` lists the other places that hold the same object (`Ticker.logger`), so a service that was overridden for some units shows up as missing there. Only direct members of units are looked at.
- Tracked units whose element leaves the page (a re-rendered list, say) stay in the list as `gone`, and take the unit that shows up at their address again. For lists, an adapter can make the address depend on the item rather than its position.
- The inspector and the signal graph both have a `⌖` pick button: click an element on the page (the click does not reach it) to look at it.
- An adapter can add `units.instance( unit )` so that paths may start at anything on the instance, not just its inputs and properties.

## The signal graph

For adapters with `reactivity`: `Mod + G` over an element (or the tray button, the `⬡` button of a row or unit, the inspector's `signal graph` link) draws the signals, computed values and render nodes of that element: what feeds each value and what reads it. Nodes are named after the member that holds them; a render node is `template`; a nameless node is named after the nearest consumer that has an owner (`template ▸ computed`). A derived node nobody has read since a change keeps its old value and is drawn dashed.

- `←` `↔` `→` choose what is followed (what the values read, both, what reads them); `Fit` fits the graph, `Pick` takes an element from the page. Drag the background to pan, wheel to zoom, drag a node to move it (`Arrange` puts moved nodes back). The layout puts a value next to what reads it, draws every edge as one curve, and orders the columns to keep crossings few, and places the nodes by rows: the longest chain is the spine in the middle row (the middle one of equally good producers), further edges are made straight, the longest first, and the nodes along such lines form a chain in one row of its own; chains get rows from the shortest out, so that long lines end up on the outside, and on the side that has fewer; a node on no chain goes next to what it is connected to, between two lines if it has to. Hovering a node outlines its element and draws its edges in the accent color above everything else; clicking it logs it and keeps its neighbours lit.
- `● Rec` in the header (or `Mod + Shift + G`, which also opens the graph over the element under the pointer) records every change of the graph. The panel folds up at the top center while it runs, and `■ Stop`, `Esc`, `Mod + G` or the first click on `✕` stop it and unfold it there as a replay: step with `‹ ›`, play at 0.25 to 16×, scrub, and read the list of what changed in each step and what caused it (the event or task, and on V8 the place in your code under the cause). `Live` leaves the replay. A recording stops by itself after 5 000 steps.
- Causes come from `reactivity.onWrite`: a write that the adapter does not report is not shown, and a write after an `await` shows the task, not the click behind it.
- Colors: green signals, blue computed values, yellow effects and templates; dashed means the value is out of date, a thick border marks where the graph starts (the legend under the graph says so).
- A graph holds at most 250 nodes.

## Peer dependencies

`@kiwi-js/panels` is a peer dependency, so that the application has exactly one overlay shell.
