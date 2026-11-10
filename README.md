# kiwi-debug

A framework-agnostic in-page debug overlay: a hover inspector, value tracking and diagnostic panels, built on [`@kiwi-js/panels`](https://github.com/Kiwi-Scripts/kiwi-panels).

## Packages

| Package | Path | Content |
|---|---|---|
| `@kiwi-js/debug` | [packages/debug](packages/debug) | Core and features; entry points `.`, `./adapter`, `./testkit` |
| `@kiwi-js/debug-angular` | [packages/debug-angular](packages/debug-angular) | Angular adapter |

Dependencies: `debug-angular` → `debug` → `@kiwi-js/dom` and `@kiwi-js/panels`. Further adapters get their own `packages/debug-<framework>`.

`@kiwi-js/dom` and `@kiwi-js/panels` are independent projects with their own repositories ([kiwi-dom](https://github.com/Kiwi-Scripts/kiwi-dom), [kiwi-panels](https://github.com/Kiwi-Scripts/kiwi-panels)).

## Development

The playground and checks use `@kiwi-js/dom` and `@kiwi-js/panels` from their Git repositories; neither is installed from npm. From a fresh clone, run the setup script from the repository root:

Requires Git, npm, and a Node.js version supported by the Angular dev dependencies (with the current lockfile: 22.22.3+, 24.15.0+, or 26+).

```bash
npm run setup:playground
npm run playground   # serves http://localhost:5199
npm run check        # typecheck, test and build every package
npm run typecheck
npm test
npm run build        # debug, then debug-angular
npm run pack:dry     # lists what each package would publish
```

- **Setup script:** clones `Kiwi-Scripts/kiwi-dom` and `Kiwi-Scripts/kiwi-panels` into sibling directories (`../kiwi-dom` and `../kiwi-panels`) if they are missing, installs npm dependencies in all three projects, and builds both sibling packages. It reuses existing sibling checkouts only when their package name and Git origin match; it does not pull, reset, or overwrite existing checkouts. To update those sources, update each checkout yourself and rerun `npm run setup:playground`.
- **Playground:** `npm run playground` serves a page at http://localhost:5199 with a tiny framework (signals, computed values, units attached to elements under identifiers), a dummy adapter for it ([playground/src/adapter.ts](playground/src/adapter.ts), a compact example of what an adapter does) and a demo app with deliberately varied data. A control bar changes the overlay's options live (modifier, `valueDetail`, action presets, on/off); the "Things to try" list walks through the features. `@kiwi-js/debug` resolves to the sources here, `@kiwi-js/panels` and `@kiwi-js/dom` to the built sibling projects.
- **No build needed between the workspace packages:** tests and type checking resolve them to their sources (`paths` in `tsconfig.base.json`, aliases in `tooling/aliases.ts`; keep the two in sync). Builds resolve them through `node_modules`, so build order matters.
- **Internal version ranges** are `^0.0.0`, which means exactly `0.0.0` while versions are `0.0.x`. Bump the ranges together with the versions (or move to a release tool such as changesets before the first publish).

## Publishing

The packages are not currently published to npm. The notes below describe a future release process; local development and the playground use the Git checkouts above.

Every package has `publishConfig.access: public`, ships `dist` (ESM, CJS and type declarations for both) with its README and LICENCE, and runs typecheck, tests and build in `prepublishOnly`. Publish in dependency order: `@kiwi-js/dom` and `@kiwi-js/panels` (their own projects) first, then `debug`, then `debug-angular`.

```bash
npm publish -w packages/debug
```

The repository URL in the `package.json` files (`Kiwi-Scripts/kiwi-debug`) is assumed from the panels repository; adjust it if the repository is named differently.
