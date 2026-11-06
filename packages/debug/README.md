# @kiwi-js/debug

A framework-agnostic in-page debug overlay: a hover inspector, value tracking and diagnostic panels. It never talks to a framework directly; a framework **adapter** (for example [`@kiwi-js/debug-angular`](https://www.npmjs.com/package/@kiwi-js/debug-angular)) translates between the two. Built on [`@kiwi-js/panels`](https://github.com/Kiwi-Scripts/kiwi-panels).

## Entry points

| Import | Content |
|---|---|
| `@kiwi-js/debug` | `enableDebug`, options and feature types |
| `@kiwi-js/debug/adapter` | The adapter contract and `defineAdapter`; what adapter packages import |
| `@kiwi-js/debug/testkit` | `fakeAdapter` and the adapter conformance suite; for adapter tests |

## Peer dependencies

`@kiwi-js/panels` is a peer dependency, so that the application has exactly one overlay shell.
