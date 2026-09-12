## 0.2.7 — cleaner settings copy

Removed generic settings introductions and repeated navigation/page descriptions. Existing destinations, default route, optional disclosures, control labels/options, commands/actions, conditional visibility, focus behavior, and narrow-screen layout remain unchanged. Useful guidance about consequences, ownership, credentials, and non-obvious inputs stays beside its setting; dynamic status/counts remain. This presentation patch changes no settings schema, defaults, note data, provider behavior, or automation.

Validated on 2026-09-12: source control/action/option/binding inventories preserved; full `npm test` passed (35 tests). Separate `npm run build` deployed to the isolated test vault. Reloaded settings routes render without generic subtitles, and route navigation leaves settings unchanged. Native navigation, focus styles, and existing narrow-screen strips are retained. Release notes record exact results, route verification, and SHA-256 hashes. Minimum Obsidian remains 1.10.0. Production installation is the user's BRAT pull. Unrelated working-tree changes are excluded.

# TPS Watchlist

## 0.2.6

- Scheduled watch selection now combines active/due filtering, draft classification, warning-path collection, and valid-definition collection in one ordered traversal.
- Every due definition is validated once instead of twice; draft-warning count and first-five path order, valid-watch order, batch arguments, scheduler guards, providers, state, and user-facing behavior remain unchanged.
- Exact public `0.2.5` and candidate runtime methods matched across 1,000 seeded scenarios containing 151,599 active, inactive, due, not-due, valid, and invalid rows with zero selected-output or warning-payload mismatches.
- A 20,000-watch due fixture reduces validation calls from 40,000 to 20,000. Across 51 interleaved actual-method rounds, median selection time fell 82.44% and p95 fell 74.42%; the production bundle is 46 bytes smaller.
- No cache, state, fallback, retry, monkeypatch, timer, listener, persisted field, unsupported API, setting, command, or migration was added.
- This backward-compatible performance/reliability patch keeps the minimum supported Obsidian version at 1.10.0.

## 0.2.5

- JSON watches and their regression tests now share the same resolver in the live provider module; the unused duplicate resolver in the general core module has been removed.
- Path tokenization now trims and skips raw split tokens in one traversal instead of allocating separate mapped and filtered arrays.
- Root, dot, bracket-index, quoted-key, empty-segment, missing-key, non-object, output, and exact error behavior remain unchanged.
- Exact public `0.2.4` and candidate provider modules matched across 500,060 supported JSON/path cases with zero value or error-message mismatches. In a 300,000-resolution nested-path benchmark, median time improved 7.24% and p95 improved 7.40%.
- The combined runtime source is 22 lines smaller, the production bundle is 7 bytes smaller, and no cache, state, fallback, retry, monkeypatch, or unsupported API was added.
- This backward-compatible performance/reliability patch keeps the minimum supported Obsidian version at 1.10.0 and requires no migration.

## 0.2.4

- Opening a new Watchlist dashboard now renders through Obsidian's public `View.onOpen` lifecycle once instead of immediately rebuilding the whole dashboard a second time.
- Reopening an existing dashboard still performs one explicit refresh, so its latest watch state and current search text remain intact. Leaf creation, view state, reveal order, row order, errors, commands, settings, providers, integrations, and persisted data are unchanged.
- Against exact public `0.2.3`, 300 first opens over 10,000 Markdown fixtures reduced dashboard renders from 600 to 300 and watch-definition parses from 6,000,000 to 3,000,000. Median time improved from 1.065 ms to 0.544 ms per ten-open sample and p95 from 1.111 ms to 0.713 ms.
- This backward-compatible performance patch keeps the minimum supported Obsidian version at 1.10.0 and requires no migration. Validation covers 34 declared checks, exact-release lifecycle/error parity, a separate final build, and test-vault first-open/reopen QA; exact evidence and artifact hashes are in `release-notes/0.2.4.md`.

## 0.2.3

- Watch batches now rebuild open dashboards once after all workers finish instead of once per failed watch plus once at batch completion.
- Direct check, pause/resume, and dashboard actions retain one operation-owned refresh, with refresh failures isolated from the completed watch result.
- A deterministic 100-failure batch over 1,000 Markdown files falls from 101 dashboard rebuilds and 101,000 file parses to one rebuild and 1,000 parses.
- Provider checks, failure counters, state persistence, events, notifications, commands, settings, public APIs, and minimum Obsidian compatibility are unchanged.

## 0.2.2

- Overlapping watch-state saves now keep the active persistence operation and only the newest superseding snapshot in each queued group.
- Settings writes remain hard ordering boundaries, and a failed state attempt still rejects one original caller while later original save requests retain their own attempt.
- In the deterministic 100-call overlap regression, persistence work falls from 100 serialized read/write pairs to two while every call still takes an independent JSON snapshot.
- This backward-compatible reliability and performance patch preserves watch behavior, settings, stored data, and the minimum supported Obsidian version of 1.10.0.

## 0.2.1

- Vault-wide watch discovery now builds rows in one ordered pass instead of creating map/filter/map intermediates.
- Concurrent batches claim their existing shallow definition snapshot by index instead of repeatedly shifting the front of an array.
- Watch order, worker concurrency, completion-order results, persistence/recovery, provider behavior, settings, and stored watch state remain unchanged.
- This backward-compatible performance patch keeps the minimum supported Obsidian version at 1.10.0 and requires no migration.

## 0.2.0

- Settings now use three clean destinations for checks/reliability, files/events, and notifications/logs, rendering only the selected page.
- Always-visible **Create watch** and **Open Watchlist** shortcuts make per-watch rules discoverable without duplicating those properties as global settings.
- Existing watch notes, runtime state, and settings keys are unchanged. This backward-compatible minor release keeps the minimum supported Obsidian version at 1.10.0 and requires no migration.

## Development and deployment

Canonical source, tests, Git metadata, and dependencies live in `/Users/zachtisherman/TishOS Plugin Development/TPS-Watchlist (Dev)`, outside both vaults. `npm run build` and watch builds deploy byte-changed runtime artifacts by default only to `/Users/zachtisherman/Library/Mobile Documents/iCloud~md~obsidian/Documents/Obsidian Plugin Test Vault/.obsidian/plugins/tps-watchlist`; `npm test` is therefore isolated even though it ends with a production-mode build. Promotion to `/Users/zachtisherman/TishOS v0.1/.obsidian/plugins/tps-watchlist` is an explicit guarded post-validation action. Neither target overwrites `data.json` or other runtime-owned state.

- 2026-07-16 isolation validation: all 15 declared tests and the required final `npm run build` passed with `[runtime-deploy] target=test ... unchanged`. Obsidian 1.12.7 loaded Watchlist in the registered test vault with no watch records or outbound requests and created only its empty QA Bases. No live promotion occurred, and production runtime checksums remained unchanged.
- 2026-07-24 settings-release validation: the 20 core tests and four routed-settings tests all passed. The required final standalone build deployed only to `[runtime-deploy] target=test`. Obsidian 1.12.7 was reloaded with `Reload app without saving`; all three settings destinations and the shared nine-plugin `Choose what to configure` pattern were inspected in the registered test vault without creating a watch, running a check, changing settings, or sending a notification. Runtime-owned state remained absent and production was not accessed or promoted.
- 2026-07-28 efficiency validation: all 22 core tests and four routed-settings tests passed, including executable coverage of one-parse ordered discovery, snapshot isolation, bounded worker claiming, and completion-order results. The required standalone build deployed only to `[runtime-deploy] target=test`. After **Reload app without saving**, Obsidian 1.12.7 registered the Watchlist commands and rendered the empty dashboard. No watch was created, no check or outbound request ran, runtime-owned state remained absent, and production was not accessed or promoted.
- 2026-07-30 persistence-release validation: all 26 core tests and four routed-settings tests passed, including exact coverage of active-plus-newest state coalescing, per-caller transient-failure progression, settings-write barriers, synchronized/unknown-field preservation, and serialized writes. The required standalone build deployed only to `[runtime-deploy] target=test` and a second post-QA build was byte-unchanged. After **Reload app without saving**, Obsidian 1.12.7 rendered all three settings destinations and the empty Watchlist dashboard. No setting changed, no watch was created, no check or outbound request ran, runtime-owned `data.json` remained absent, and production was not accessed or promoted.
- 2026-07-30 first-open render validation: exact public `0.2.3` passed 32 declared checks and candidate `0.2.4` passed 34. An exact-source comparator preserved lifecycle, row-order, reveal, and failure behavior across first-open and existing-view paths while halving first-open dashboard renders and watch-definition parses. The required separate final build deployed only to `[runtime-deploy] target=test`. After **Reload app without saving**, Obsidian 1.12.7 rendered the empty dashboard on first open and refreshed the same single tab on reopen. No watch was created, no check or outbound request ran, runtime-owned `data.json` remained absent, and production was not accessed or promoted.
- 2026-07-30 dashboard-refresh validation: the exact 0.2.2 path rebuilt views 101 times and parsed 101,000 Markdown fixtures for a 100-failure batch over a 1,000-file vault. Version 0.2.3 produced the same 100 failed results, failure counters, and 101 persistence requests while rebuilding once and parsing 1,000 files. Direct successful and failed checks each refreshed once, and a synthetic refresh rejection remained isolated. All 28 core tests and four routed-settings tests passed. Obsidian 1.12.7 reloaded the registered test vault and rendered the empty dashboard; **Check all**, **New watch**, and outbound integrations were not invoked. Runtime-owned `data.json` remained absent, and production was not accessed.

## Install with BRAT

Add the public repository `ZachTish/tps-watchlist` to BRAT and select **Latest** so BRAT follows numbered releases without a private-repository token. Freeze a numeric version when a device should remain pinned.

TPS Watchlist is the contract-native monitoring domain for products, prices, availability, releases, feeds, market data endpoints, industry news, and other external changes.

The plugin treats a watch as a durable entity note, an observation as derived state, and a meaningful transition as a typed instance line. Watches remain inspectable and editable without the plugin.

## Storage contract

- Watch definitions are Markdown notes with `kind: watch`.
- Watch discovery is vault-wide and does not depend on the configured creation folder.
- New watches default to `Watches/`, but that folder is only a creation target.
- Initial successful observations establish a silent baseline.
- Unchanged polls do not write Markdown.
- Meaningful transitions create `watchEvent` bullets.
- Daily notes own events by default.
- Event lines remain human-readable and keep machine fields in a compact HTML comment.
- Baselines, fingerprints, current values, check health, cooldown state, and notification dedupe state live in plugin `data.json`.
- Settings saves and watch-state saves use separate serialized merge paths. State-only writes first reload `data.json` and preserve synchronized settings and unknown fields; settings writes preserve the newest states and unknown top-level data. Superseded queued state snapshots coalesce without crossing an active write or settings boundary. Every caller retains a call-time JSON snapshot and observable failure opportunity, and a failed reload aborts that attempt without stranding later requests.
- Provider response bodies are never persisted.
- Tasks are created only through an explicit follow-up workflow; watch events are not checkboxes.

Example watch:

```yaml
---
title: Herman Miller Embody under $900
kind: watch
status: working
watchId: watch-example
source: https://example.com/embody
watchProvider: page
watchSelector: .product-price
watchPattern: '\$([\d,.]+)'
watchCondition: below
watchTarget: "900"
watchIntervalMinutes: 30
watchNotify: true
---
```

Example event:

```md
- [[Watches/Herman Miller Embody under $900|Herman Miller Embody under $900]]: condition met: 875 <!-- [type:: watchEvent] [watch:: [[Watches/Herman Miller Embody under $900]]] [event:: condition-met] [value:: 875] [previousValue:: 1050] [observedAt:: 2026-07-11 09:42:00] [watchEventId:: watch-event-example] -->
```

## Providers

### Web page

`watchProvider: page` fetches HTML through Obsidian's CORS-free `requestUrl` API.

- `watchSelector` selects one or more CSS elements.
- Matching element text is normalized and joined.
- Without a selector, the plugin monitors normalized page text after removing scripts, styles, templates, SVG, and noscript content.
- `watchPattern` can extract a regular-expression match or capture group 1.
- CSS selectors are strongly recommended because whole pages often contain rotating or personalized content.

Typical uses include price, availability, sale text, release dates, and status pages.

### JSON API

`watchProvider: json` reads one value from a JSON response.

- `watchJsonPath` is required.
- Dot paths and bracket indexes are supported.
- Examples: `$.quote.price`, `data.items[0].status`, and `$['results'][0]['name']`.
- Objects and arrays are serialized with stable key ordering before fingerprinting.
- `watchPattern` can further extract from the resolved value.

This is the preferred route for stock prices and other numeric sources when a reliable API is available.

### RSS and Atom

`watchProvider: rss` reads RSS `item` and Atom `entry` elements.

- `watchQuery` optionally filters title, summary/content, and category text.
- The first matching item is the current observation.
- GUID, Atom ID, link, title, and date supply stable source identity.
- `watchCondition: new-item` emits when the leading matching item changes after baseline.

Typical uses include product releases, company announcements, regulatory feeds, IPO/news feeds, and industry monitoring.

## Conditions

| Condition | Behavior |
|---|---|
| `changed` | Emit whenever the extracted value fingerprint changes after baseline. |
| `new-item` | Emit whenever the leading matching feed item changes after baseline. |
| `contains` | Emit when the value transitions from not containing the target to containing it. |
| `not-contains` | Emit when the value transitions from containing the target to not containing it. |
| `equals` | Emit when the value transitions to exact equality. |
| `above` | Parse the first number and emit on a false-to-true threshold crossing. |
| `below` | Parse the first number and emit on a false-to-true threshold crossing. |
| `available` | Emit when selected content becomes available. A target can provide explicit availability text; blank uses built-in positive/negative phrases. |

Text matching is case-insensitive unless `watchCaseSensitive: true`.

Numeric parsing supports signs, thousands separators, decimals, currency text, and percentages by extracting the first numeric value.

## Transition and deduplication behavior

- The first valid observation never alerts.
- Text and threshold conditions alert only on false-to-true transitions.
- `changed` and `new-item` alert only on fingerprint changes.
- `new-item` fingerprints use the feed item's stable GUID, Atom ID, or item link. Editing the title or summary of the same identified item does not create a false new-item alert; feeds without those identifiers fall back to title plus publication date.
- The first successful `new-item` check after upgrading a pre-0.1.1 stored baseline silently adopts the stable-identity fingerprint before later item changes can alert.
- `watchCooldownMinutes` can suppress events that occur too close to the previous event.
- `watchEventId` is deterministic from watch identity, event kind, and observation fingerprint.
- The target Markdown file is atomically processed to check the event ID and append against its latest content, so concurrent user or plugin edits are preserved.
- Manual, dashboard, GCM, API, and scheduled requests for the same watch path share one in-flight provider check and delivery result.
- A missing/rebuilt plugin cache safely establishes a new baseline instead of replaying unknown history.
- Consecutive failures are counted without writing one log per poll.
- Reaching the configured failure threshold writes one error event and optionally sends one notification.
- A failed identity write, provider request, failure-event append, state save, or dashboard refresh is isolated to that watch. Concurrent workers continue checking the rest of the batch, and the batch returns one result per requested watch instead of rejecting wholesale.
- Batch state changes are rendered together in one final dashboard refresh. Direct single-watch checks refresh once after either success or failure.
- If the threshold error event cannot be written, the counter remains immediately below the threshold so the escalation is retried on the next check rather than being lost.
- A successful check clears the failure state and permits a future failure escalation.

## Status and scheduling

- `working`, `todo`, and other non-terminal statuses are active.
- `holding` or `paused` pauses automatic monitoring.
- `complete`, `wont-do`, canceled, and archived statuses stop automatic monitoring.
- `watchIntervalMinutes` overrides the global default.
- A scheduler tick only discovers watches whose individual interval is due.
- Checks run with configurable bounded concurrency.
- Incomplete watch notes are treated as drafts and skipped by automatic polling until their required source/condition fields are valid.

Automatic execution defaults to the desktop TPS Controller device. This avoids duplicate external requests and notifications across synchronized devices. Manual commands can still check from the current device.

TPS Watchlist does not make Obsidian a background daemon. Monitoring stops while the Controller desktop app is closed or suspended.

## Commands

- `TPS Watchlist: Create watch`
- `TPS Watchlist: Open Watchlist`
- `TPS Watchlist: Open Watchlist Base`
- `TPS Watchlist: Open Watch Events Base`
- `TPS Watchlist: Check all active watches now`
- `TPS Watchlist: Check active watch now`
- `TPS Watchlist: Pause or resume active watch`

The ribbon binoculars button opens the live dashboard.

## Dashboard and Bases

The dashboard renders derived runtime state without copying it into note frontmatter:

- Active/paused state
- Provider and condition
- Per-watch cadence
- Latest observed value
- Last check time
- Consecutive failure state
- Check, pause/resume, and open actions
- Search across title, provider, condition, target, path, and tags

Check-all, per-row check, and pause/resume actions rely on the operation that changed state to refresh every open dashboard exactly once; the view does not immediately repeat that render.

`Watchlist.base` is a native note-oriented Base filtered by `kind == "watch"`.

`Watch Events.base` uses GCM's generic `tps-table` and filters line records by `watchEventId`. Its plus action runs the normal create-watch command.

The plugin creates missing Base files but never overwrites existing user-edited Bases.

## GCM integration

Watch notes receive external GCM actions:

- Check watch now
- Pause or resume watch
- Open Watchlist

Frontmatter mutations, file opening, daily-note creation, file-updated events, and Notebook Navigator rule application use GCM APIs when available. Native Obsidian fallbacks keep the plugin usable without GCM.

## Notification integration

TPS Notifier is optional.

- Watchlist decides whether an event is meaningful and whether it is already delivered.
- Notifier supplies push transport only.
- If Notifier is unavailable or delivery fails, an Obsidian Notice is shown.
- Notifications link back to the durable watch note when the delivery transport supports a file target.

## AI Gateway integration

When TPS AI Gateway is available, Watchlist registers guarded capabilities:

- `watchlist.create-watch`
- `watchlist.check-watch`

Both require confirmation. AI can propose structured watch fields, but Watchlist validates the input and retains mutation authority. Provider fetching, numeric comparisons, fingerprints, transitions, and deduplication are deterministic.

## Public API

The API is available from the enabled plugin and as `app.tpsWatchlist`:

```ts
api.createWatch(input)
api.checkAll(reason?)
api.checkPath(path, reason?)
api.getWatches()
api.ensureBases()
api.openDashboard()
api.getSettings()
```

## Settings

Settings use a sticky three-destination hub and render only the selected page:

- **Checks & reliability** contains automatic execution, default interval, scheduler tick, request timeout, concurrent checks, failure alert threshold, and repeated-failure notification.
- **Files & events** contains the default watch folder, Watchlist and Watch Events Base paths, daily-note or watch-note event ownership, and the **Ensure Bases** repair action.
- **Notifications & logs** contains the default notification preference and debug logging.

The always-visible **Create watch** and **Open Watchlist** shortcuts lead to the per-watch workflow where provider, condition, target, extraction, cadence, and notification overrides are configured. Those fields remain watch-note properties rather than global plugin settings.

Route selection is transient UI state. No settings key was renamed or migrated. Hub buttons expose pressed state to assistive technology, route changes focus the active page heading, and narrow screens use a horizontal route strip with full-width setting controls.

## Diagnostics

Debug logging is disabled by default. Errors remain visible.

Structured logs use `[TPS Watchlist] [Scope] event` and cover:

- Plugin load/unload
- Scheduler start, due checks, and role-based skips
- Batch trigger, count, concurrency, duration, and result counts
- Same-watch requests that join an existing in-flight check
- Watch path, provider, condition, baseline state, transition result, and failure count
- Event target resolution, dedupe, append attempt, and result
- Unhandled per-watch rejections plus failure-escalation, state-persistence, and view-refresh failures
- Notification route, attempt, and result
- Watch identity assignment and legacy RSS baseline migration
- GCM and AI capability registration availability
- Settings and Base creation routes

Logs do not include source response bodies, full note bodies, complete settings dumps, or secrets. Provider errors are sanitized before logging, persistence, event creation, or API return: source URLs are reduced to scheme/host plus `[redacted]`, and standalone credential-like parameters are redacted.

## Security and limitations

- Do not put API keys, bearer tokens, or sensitive query parameters in `source`.
- Provider credentials are not yet accepted through watch notes.
- Many retail sites use bot protection, client-side rendering, personalized content, or unstable class names.
- RSS and structured APIs are more reliable than scraping.
- Whole-page monitoring can produce noisy changes; use selectors and extraction patterns.
- The page adapter does not execute page JavaScript.
- Numeric conditions use the first extracted number, so selectors/patterns should isolate the intended metric.
- Stock percentage watches must define their data source's comparison basis; the plugin does not infer previous close versus intraday change.
- The plugin never purchases products, places trades, or executes actions from a watch event.
- Cross-device manual execution requests are not yet routed through Controller's closed sync-request protocol.

## Validation

- `npm run test:core` exercises JSON paths, regex extraction, silent baselines, value changes, threshold transitions, availability precedence, deterministic fingerprints, atomic event append/dedupe, same-path single-flight checks, stable RSS item identity, the silent legacy-baseline migration, batch refresh coalescing, and direct-check refresh ownership.
- `npm test` runs focused core tests and the production TypeScript/esbuild build.
- After source changes, rebuild and reload Obsidian before UI validation.
- Obsidian 1.12.7 validation confirmed plugin load, ribbon registration, the empty dashboard, responsive create-watch modal, Controller-only defaults, native Watchlist Base rendering, zero-result behavior, and all three routed settings destinations without creating a QA watch or external notification.

## Version notes

- 0.2.5: Removed the duplicate test-only JSON-path resolver, made tests exercise the live provider implementation, and eliminated two token-array intermediates without changing supported path behavior.
- 0.2.4: Removed the redundant full dashboard rebuild after a newly created view already rendered through `onOpen`; existing-view refresh behavior is unchanged.
- 0.2.3: Coalesced failed-batch dashboard work into one final refresh and removed redundant action-level rerenders while preserving one isolated refresh for direct checks and status changes.
- 0.2.2: Coalesced overlapping watch-state persistence to the active plus newest snapshots without crossing settings-write boundaries or losing per-caller failure progression.
- 0.2.1: Replaced vault-wide watch-row intermediates with one ordered loop and changed batch work claiming from repeated front shifts to constant-time indexed access.
- 0.2.0: Reorganized settings into a shallow accessible hub, added direct watch-creation/dashboard shortcuts, removed settings accordions, and added mobile destination navigation without changing settings or watch schemas.
- 0.1.2: Separated settings intent from volatile watch state so state writes preserve preferences and settings writes preserve watch health, synchronized unrelated choices, rapid reverts, and unknown fields.
- 0.1.1: Isolated watch workers and failure bookkeeping, made event append/dedupe atomic, shared same-watch concurrent checks, migrated path-keyed health state when durable IDs appear, based RSS fingerprints on stable identity, and redacted provider error targets.
- 0.1.0: Initial contract-native watch entities, page/JSON/RSS providers, transition engine, persisted baselines, daily-note events, failure escalation, Controller-aware scheduling, dashboard, Bases, GCM actions, Notifier delivery, AI capabilities, public API, settings, diagnostics, and core tests.
