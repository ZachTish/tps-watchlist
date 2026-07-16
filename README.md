# TPS Watchlist

## Development and deployment

Canonical source, tests, Git metadata, and dependencies live in `/Users/zachtisherman/TishOS Plugin Development/TPS-Watchlist (Dev)`, outside both vaults. `npm run build` and watch builds deploy byte-changed runtime artifacts by default only to `/Users/zachtisherman/Library/Mobile Documents/iCloud~md~obsidian/Documents/Obsidian Plugin Test Vault/.obsidian/plugins/tps-watchlist`; `npm test` is therefore isolated even though it ends with a production-mode build. Promotion to `/Users/zachtisherman/TishOS v0.1/.obsidian/plugins/tps-watchlist` is an explicit guarded post-validation action. Neither target overwrites `data.json` or other runtime-owned state.

- 2026-07-16 isolation validation: all 15 declared tests and the required final `npm run build` passed with `[runtime-deploy] target=test ... unchanged`. Obsidian 1.12.7 loaded Watchlist in the registered test vault with no watch records or outbound requests and created only its empty QA Bases. No live promotion occurred, and production runtime checksums remained unchanged.

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

- Automatic execution: Controller-only or this device
- Default watch folder
- Default interval
- Scheduler tick
- Request timeout
- Concurrent checks
- Failure alert threshold
- Notify on repeated failures
- Watchlist and Watch Events Base paths
- Daily-note or watch-note event ownership
- Default notification preference
- Debug logging

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

- `npm run test:core` exercises JSON paths, regex extraction, silent baselines, value changes, threshold transitions, availability precedence, deterministic fingerprints, atomic event append/dedupe, same-path single-flight checks, stable RSS item identity, and the silent legacy-baseline migration.
- `npm test` runs focused core tests and the production TypeScript/esbuild build.
- After source changes, rebuild and reload Obsidian before UI validation.
- Obsidian 1.12.7 validation confirmed plugin load, ribbon registration, the empty dashboard, responsive create-watch modal, Controller-only defaults, collapsible settings, native Watchlist Base rendering, and zero-result behavior without creating a QA watch or external notification.

## Version notes

- 0.1.1: Isolated every watch worker and secondary failure-bookkeeping step so one broken identity write, provider, event target, state save, or dashboard render cannot reject the rest of a batch. Failure-event write errors retry at the configured threshold, transient path-keyed health state migrates when a durable watch ID can be assigned, and provider error summaries redact source URLs and credential-like parameters before logs or Markdown persistence. Validation: focused core regression tests and full `npm test`, including production build.
- 0.1.1: Made watch-event append/dedupe atomic against the latest canonical note content, shared concurrent checks for the same watch path, and based RSS `new-item` fingerprints on stable item identity so content corrections do not trigger false new-item events. Existing RSS baselines migrate silently on their first successful post-upgrade check.
- 0.1.0: Initial contract-native watch entities, page/JSON/RSS providers, transition engine, persisted baselines, daily-note events, failure escalation, Controller-aware scheduling, dashboard, Bases, GCM actions, Notifier delivery, AI capabilities, public API, settings, diagnostics, and core tests.
