# TPS Watchlist

Monitor web pages, JSON APIs, and RSS/Atom feeds, recording meaningful changes in your vault.

Current release: [0.2.7](https://github.com/ZachTish/tps-watchlist/releases/tag/0.2.7) · Obsidian 1.10.0+ · Desktop and mobile.

## Install with BRAT

Add `ZachTish/tps-watchlist` to BRAT. Use manual updates with `Latest`, or freeze an exact numeric tag for a controlled rollout. Each release supplies `main.js`, `manifest.json`, and `styles.css`; release notes record validation and artifact hashes. A published release is not evidence that any device has installed it.

## Create and run a watch

Use **Create watch** to choose the source, extraction, condition, interval, event location, and notification preference. **Open Watchlist** opens the dashboard; reusable Watchlist and Watch Events Bases show durable records.

Page watches use selectors and optional extraction patterns; they do not run page JavaScript. JSON watches resolve explicit paths. RSS/Atom watches track the leading matching item's identity. The initial observation establishes a baseline; transition and deduplication rules control later events.

## Settings

- **Checks & reliability**: automatic execution, intervals, request limits, concurrency, and repeated failures.
- **Files & events**: folders, Base paths, event ownership, and Ensure Bases.
- **Notifications & logs**: notification defaults and diagnostics.

Per-watch configuration stays in the watch note. Route selection is transient, and narrow screens use a horizontal settings strip. No settings key was renamed or migrated by this documentation maintenance.

## Integrations and limits

GCM supplies shared entities and actions; TPS Notifier delivers configured notifications; optional AI Gateway operations remain capability-scoped. Watches never purchase products, execute trades, or turn fetched page text into instructions.

Do not put secrets or sensitive query parameters in a source URL. Bot protection, rendered-only pages, and unstable selectors can prevent reliable checks. Stock comparisons require an explicit source/basis; the plugin does not infer a previous close. See [the detailed reference](REFERENCE.md) for provider fields, public API, transition rules, and validation.

## Development and repository policy

`main` is the stable source line. Numeric tags identify immutable released artifacts. `optimization` is an unreleased work-in-progress lane; do not install it through BRAT or merge it into stable without separate validation.

The supported build lives inside `Obsidian Plugin Test Vault/Plugin Development`, with `TPS-Watchlist (Dev)` as the mapped stable source. These repositories depend on adjacent shared tooling including `deploy-runtime.mjs`; a standalone clone is not currently self-contained.

From the contained workspace, prepare dependencies using the shared helper, then run tests and a separate final build:

```sh
# From Plugin Development:
node ./prepare-dependencies.mjs "TPS-Watchlist (Dev)"
cd "TPS-Watchlist (Dev)"
npm test
npm run build
```

Dependencies stay in the vault's `.plugin-dev-cache.nosync` through a relative `node_modules` symlink. Use a clean, current checkout; preserve unrelated changes and never build an old dirty worktree into the test runtime. Stable builds deploy only shipped artifacts to the test vault. Optimization builds are build-only. Runtime `data.json`, secrets, caches, and session state never belong in Git.

Documentation-only maintenance does not create a new plugin version. Published release tags and assets are preserved. Do not rely on legacy version/release scripts without reviewing their current behavior. Production updates remain the user's BRAT handoff.

For prior feature details and release-specific evidence, see [REFERENCE.md](REFERENCE.md) and [GitHub releases](https://github.com/ZachTish/tps-watchlist/releases). The September 16 cleanup changes documentation and repository metadata, not shipped behavior.
