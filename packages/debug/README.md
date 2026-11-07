# @kiwi-js/debug

A framework-agnostic in-page debug overlay: a hover inspector, value tracking and diagnostic panels. It never talks to a framework directly; a framework **adapter** (for example [`@kiwi-js/debug-angular`](https://www.npmjs.com/package/@kiwi-js/debug-angular)) translates between the two. Built on [`@kiwi-js/panels`](https://github.com/Kiwi-Scripts/kiwi-panels).

## Entry points

| Import | Content |
|---|---|
| `@kiwi-js/debug` | `enableDebug`, options and feature types |
| `@kiwi-js/debug/adapter` | The adapter contract and `defineAdapter`; what adapter packages import |
| `@kiwi-js/debug/testkit` | `fakeAdapter` and the adapter conformance suite; for adapter tests |

## Customizing the buttons

The buttons of a value row and of a unit head are *actions*. Without configuration you get the defaults (rows: `track`, `graph`, `inspect`; units: `track`, `graph`, `address`, `keep`, `side`, `remove`, each where it makes sense). A list replaces the default of its kind; items are built-ins by name or your own definitions:

```ts
enableDebug( {
    adapter,
    actions: {
        row: [
            'track', 'inspect',
            { id: 'copy', icon: '⧉', title: 'Copy the value as JSON', run: ( { row } ) => navigator.clipboard.writeText( JSON.stringify( row?.read() ) ) }
        ]
    }
} );
```

A definition may also set `slot` ('leading' before the name, 'trailing' after the value), `surfaces`, `visible( c )` and `isOn( c )` for toggles.

## Looking deeper into values

- `valueDetail: 'detail'` lets arrays and objects open in place in every value row (default `'summary'`: one line per value).
- The `inspect` action opens a small panel with a path input (`items[0].name`, `a?.b`, `$1.users[2]`) and the live, detailed value it leads to. Click a name in the tree to extend the path. `Track` keeps the path as a tracked value in the watch list, `Pin` turns an object into a reference `$n` that paths can start at. Paths are re-evaluated on every refresh; calls and operators are not part of the syntax.
- An adapter can add `units.instance( unit )` so that paths may start at anything on the instance, not just its inputs and properties.

## Peer dependencies

`@kiwi-js/panels` is a peer dependency, so that the application has exactly one overlay shell.
