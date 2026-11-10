# @kiwi-js/debug-angular

The Angular adapter for [`@kiwi-js/debug`](https://www.npmjs.com/package/@kiwi-js/debug): it implements the framework adapter contract on top of Angular's dev-mode APIs (`ng.*`, signals, the profiler hook) and provides the Angular-flavoured entry points (`injectDebugOverlay`, `disableDebugOverlay`).

Requires Angular 19 or later (`afterEveryRender`). Parts of it rely on private Angular APIs (`ɵ*`, `LView` internals) and may break with other versions; the adapter reports this through `meta.fragile`.
