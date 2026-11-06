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

An npm workspace; one `npm install` at the root.

```bash
npm install
npm run check        # typecheck, test and build every package
npm run typecheck
npm test
npm run build        # debug, then debug-angular
npm run pack:dry     # lists what each package would publish
```

- **No build needed between the workspace packages:** tests and type checking resolve them to their sources (`paths` in `tsconfig.base.json`, aliases in `tooling/aliases.ts`; keep the two in sync). Builds resolve them through `node_modules`, so build order matters.
- **Sibling projects:** `@kiwi-js/panels` and `@kiwi-js/dom` are not on npm yet, so they are linked from sibling checkouts (`../kiwi-panels`, `../kiwi-dom`), which must be built first (`npm run build` in each; `npm run dev` there rebuilds on change). `panels` is a `file:` dev dependency of `packages/debug`; `dom` is redirected by `overrides` in the root `package.json` (the root is private, so this never reaches a published package, which keeps a plain `dependencies` range). Once they are published, remove the `file:` link and the override. The published `debug` declares `panels` as a peer dependency, `>=0.0.0` for now; tighten the range with the first panels release.
- **Internal version ranges** are `^0.0.0`, which means exactly `0.0.0` while versions are `0.0.x`. Bump the ranges together with the versions (or move to a release tool such as changesets before the first publish).

## Publishing

Every package has `publishConfig.access: public`, ships `dist` (ESM, CJS and type declarations for both) with its README and LICENCE, and runs typecheck, tests and build in `prepublishOnly`. Publish in dependency order: `@kiwi-js/dom` and `@kiwi-js/panels` (their own projects) first, then `debug`, then `debug-angular`.

```bash
npm publish -w packages/debug
```

The repository URL in the `package.json` files (`Kiwi-Scripts/kiwi-debug`) is assumed from the panels repository; adjust it if the repository is named differently.
