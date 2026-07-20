# TPS Watchlist

## Development and deployment

Canonical source, tests, Git metadata, and dependencies live under this test vault's `Plugin Development` workspace. Stable feature work uses `TPS-Watchlist (Dev)` on `main`; optimization work uses the separate `TPS-Watchlist (Optimize)` worktree on `optimization`. Stable builds may deploy byte-changed runtime artifacts only to this test vault. Automatic optimization builds are build-only and must report `[runtime-deploy] target=none lane=optimization`; an explicit test deployment remains a separate guarded action, while live deployment is prohibited until the optimization is accepted and merged. Promotion to `/Users/zachtisherman/TishOS v0.1/.obsidian/plugins/tps-watchlist` remains an explicit guarded post-validation action. Deployment preserves `data.json` and all other runtime-owned state.

- 2026-07-19 AI Gateway lifecycle optimization: replaced Watchlist's `app.tpsAiGateway` monkeypatch and private plugin-registry fallback with the canonical versioned workspace-event client. Watchlist now discovers an already-running provider by request and reacts to late availability, withdrawal, and provider reload without polling. It registers exactly the same two guarded capabilities, but only after integration initialization has completed and the identity catalog has been verified and reconciled; a Base repair failure remains reported without permanently disabling otherwise-independent AI capabilities. Repeated availability from the same provider is idempotent; a replacement provider is registered only after every prior unregister succeeds; any failed cleanup permanently blocks replacement for that plugin instance; and a partially registered set is rolled back. Per-registration execution leases make provider-retained callbacks harmless before readiness, after replacement, across unresolved catalog changes, and after unload. Reentrant lifecycle changes cannot retain a stale executable set. The layout-ready and async Base-initialization path carries one lifecycle epoch, so a completion from an unloaded or reloaded instance cannot publish GCM or AI actions. GCM registration is transactional and exception-contained; its own execution lease activates only after all three actions commit, so even a partial action retained after rollback failure remains inert. Retry is fenced to the same lifecycle, and cleanup uncertainty blocks same-instance re-registration. Unload invalidates and disposes AI first, then invalidates GCM before isolating every disposer so one failure cannot skip later cleanup. The existing one-shot retry is now GCM-only. Focused executable tests cover late discovery, idempotence, replacement ordering, withdrawal, partial rollback, reentrant replacement, cleanup-blocked replacement, stale retained create/check handlers, readiness/unload execution fences, transactional GCM registration, leaked partial-action rejection, isolated cleanup, and stale post-disposal events; source guards reject renewed AI monkeypatch/private-registry discovery and AI retry polling. All 77 declared tests and TypeScript pass. The full declared suite's build and the required separate final build both report `[runtime-deploy] target=none lane=optimization`. No runtime deployment, reload, UI/provider call, version, tag, release, production access, or watch data/settings change occurred.

- 2026-07-19 optimization validation: added vault-wide duplicate-`watchId` detection and fail-closed identity ownership. Every member of a conflict group is blocked, including an active watch whose peer is paused, retired, or an otherwise-invalid draft. Known conflicts return `outcome: "skipped"`, `code: "duplicate-watch-id"`, exact conflicting paths, and `attempted: false`; no provider/evaluation/event/notification work runs, and only the safety quarantine is persisted. Exact definition signatures, stable-file identity leases, content-correlated MetadataCache settlement, and cache-readiness gating prevent stale, replaced, or renamed notes from borrowing ownership. File-extension and folder renames conservatively invalidate and settle every affected Markdown path. Destructive reconciliation refuses every unsettled catalog, and one coalesced lifecycle-owned recovery loop retries only pending paths with capped backoff until they settle. Startup always requires a verified raw-file/cache coverage probe; vault mutation listeners start only after layout readiness, and retry timers cannot rearm after unload. Settings changes revision the effective-definition catalog. An originating check may temporarily use exact-revision live-definition overlays, including a proven non-watch daily target; global reconciliation never trusts those overlays. Exact plugin writes whose live and cached definitions already agree are semantically settled and invalidate any snapshot built during the pending window. Ownership is revalidated after identity assignment, quarantine persistence, provider success and rejection, and awaited event, state, notification, and failure-escalation boundaries. Duplicate IDs and every participating exact path are persisted in quarantine, ambiguous baseline state is cleared, operational failure health still accumulates, and each repaired path must complete a new silent baseline even if it receives a different ID. Failed quarantine/path-move intent remains pending in memory and cannot be replaced by a later no-op safety pass; it is cleared only after a successful durable transaction. The dashboard distinguishes blocked, active, failed, and rebaseline-pending rows; public watch rows and settings are detached copies; scheduling excludes configuration errors; manual, dashboard, and GCM checks surface skipped-result errors; rejected command and dashboard actions are contained and reported. Missing-ID state has a separate path-keyed namespace, legacy `path:` state migrates only when no durable identity owns that exact key, and null-prototype state dictionaries safely support IDs such as `__proto__`. A revisioned identity catalog avoids a vault-wide rescan per worker, signature-keyed single-flight prevents an edited definition from joining a stale request, blocked-only batches no longer perform a redundant final save, and an effect journal records confirmed `watchId`, state-data, and event commits at their durable boundary so exact identities/event IDs survive later failures. Transition-instance event IDs remain stable for an idempotent retry but differ when the same valid value transition recurs later. State changes are applied to a detached draft, saved through a recoverable serial queue, and installed in memory only after `saveData` succeeds. Focused tests pass 46/46 and TypeScript passes. The full declared suite and separate final build pass with `[runtime-deploy] target=none lane=optimization`; independent release-gate review was completed before handoff. No provider request, runtime deployment, Obsidian reload, version, tag, release, or production access occurred.

- 2026-07-19 notification durability validation: replaced Watchlist's direct Notifier lookup with the canonical event-discovered v2 client and its single isolated mixed-version v1 bridge. A versioned, null-prototype ledger stores at most 1,000 event-keyed delivery records. Watch state and a new `attempting` record are saved atomically before transport I/O; terminal certainty is compare-and-set by the exact attempt ID before the final ownership check. Exact v1 success remains `legacy-accepted` with `legacy-promise-resolved` evidence instead of being projected to a v2 `accepted` receipt. Both accepted states count as delivered in the dashboard and legacy failure-alert compatibility state without conflating their transport evidence. Startup converts every interrupted `attempting` record to `unknown`, prunes any valid over-limit ledger, and durably saves those repairs before scheduling. Async load and queued settings persistence are lifecycle-epoch fenced, settings writes cannot rearm the scheduler after unload, and stale loads cannot republish the API or Notifier client. A Markdown event marker that already exists without a ledger record is recorded `unknown` and is never replayed, including after pruning. Future, partial, malformed, or semantically contradictory ledger data is preserved verbatim while notification writes and sends fail closed. Normal watch events remain successful when delivery is rejected, unavailable, or unknown; provider failures remain provider failures regardless of alert delivery. Dashboard rows and check results expose the latest delivery state. Focused TypeScript validation and all 68 tests pass. The complete declared suite, its embedded build, and the required separate final build pass with `[runtime-deploy] target=none lane=optimization`. No provider request, runtime deployment, reload, version, tag, release, or production access occurred.

- 2026-07-16 isolation validation: all 15 declared tests and the required final `npm run build` passed with `[runtime-deploy] target=test ... unchanged`. Obsidian 1.12.7 loaded Watchlist in the registered test vault with no watch records or outbound requests and created only its empty QA Bases. No live promotion occurred, and production runtime checksums remained unchanged.

## Install with BRAT

Add the private repository `ZachTish/tps-watchlist` to BRAT and select **Latest** tracking so BRAT follows the newest GitHub release. For private-repository access, give BRAT a fine-grained GitHub token scoped to this repository with **Contents: Read-only** permission. Never commit the token to this repository, an Obsidian vault, or any synced note.

TPS Watchlist is the contract-native monitoring domain for products, prices, availability, releases, feeds, market data endpoints, industry news, and other external changes.

The plugin treats a watch as a durable entity note, an observation as derived state, and a meaningful transition as a typed instance line. Watches remain inspectable and editable without the plugin.

## Storage contract

- Watch definitions are Markdown notes with `kind: watch`.
- Every durable `watchId` must be unique across all watch notes. Copying a watch note also copies its ID and therefore creates a blocked configuration until every conflicting note receives a new unique value.
- Watch discovery is vault-wide and does not depend on the configured creation folder.
- New watches default to `Watches/`, but that folder is only a creation target.
- Initial successful observations establish a silent baseline.
- Unchanged polls do not write Markdown.
- Meaningful transitions create `watchEvent` bullets.
- Daily notes own events by default.
- Event lines remain human-readable and keep machine fields in a compact HTML comment.
- Baselines, fingerprints, current values, check health, cooldown state, and the versioned notification ledger live in plugin `data.json`.
- Duplicate IDs and every participating exact note path are stored in persistent quarantine. Their ambiguous cached baseline state is cleared, and quarantine is removed per repaired path only by a later successful silent baseline after ownership becomes unique. Post-quarantine failure counters and diagnostics remain operational and persist across restarts.
- Missing-ID compatibility state is stored separately by exact note path so it cannot alias a legitimate durable ID beginning with `path:`.
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
- `watchEventId` is deterministic from watch identity, event kind, observation fingerprint, and the prior persisted transition state. An idempotent retry reuses the same ID, while a later return to the same value receives a new ID and is not suppressed as an old event.
- The target Markdown file is atomically processed to check the event ID and append against its latest content, so concurrent user or plugin edits are preserved.
- Manual, dashboard, GCM, API, and scheduled requests for the same unchanged watch definition share one in-flight provider check and delivery result. The in-flight key includes the full definition signature, so an edited definition cannot join an older request.
- Duplicate durable IDs discovered before a request fail closed before provider/evaluation/event/notification work; the only mutation is the awaited safety-quarantine write. The plugin never chooses an owner or silently rewrites a copied ID; every conflicting note is blocked.
- Vault creates/modifications remain pending until a MetadataCache callback's indexed text exactly matches a stable authoritative vault read. A callback for an older write cannot settle a newer pending revision. File renames across extensions and folder renames mark every resulting Markdown path pending, move path-scoped safety state, and invalidate the catalog. Checks and duplicate reconciliation fail closed during an unresolved peer revision. Recovery is single-flight, continues at a capped cadence after transient read failures, and reads only pending paths. A creation/identity/event overlay is accepted only by its originating check after a stable live-definition or exact atomic-output check; global reconciliation waits for real semantic settlement.
- Identity ownership is checked again after automatic ID assignment, after both provider success and provider rejection, and after each awaited event, state-save, notification, or failure-escalation boundary. Work detected before a commit boundary is discarded. A later conflict quarantines the identity; any idempotent work already committed is returned with `sideEffectsCommitted: true` and an `eventId` when applicable.
- Every ID and path observed in conflict stays quarantined after notes are repaired or renamed. Each path's first later successful observation is a new silent baseline even if it receives a new ID; provider failures retain quarantine while continuing to accumulate operational failure health.
- A missing/rebuilt plugin cache safely establishes a new baseline instead of replaying unknown history.
- Consecutive failures are counted without writing one log per poll.
- Reaching the configured failure threshold writes one error event and optionally sends one notification.
- Notification delivery certainty is independent of provider/watch success. `accepted`, `legacy-accepted`, `rejected`, `not-attempted`, and `unknown` are terminal for that event; Watchlist does not automatically retry any of them.
- A new event can be sent only after its `attempting` record is durably committed with the watch state. An existing/deduplicated Markdown event with no ledger record becomes `unknown` and is never treated as unsent.
- Interrupted attempts become `unknown` at startup before the scheduler starts. A bounded consumer timeout is also recorded `unknown` with `consumer-timeout` evidence and unknown attempt certainty because either v1 or v2 transport may have crossed its I/O boundary. This intentionally prefers a possible missed notification over a duplicate push when completion cannot be proven.
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
- Identity-conflicted watches are skipped by automatic polling even when the conflicting peer is paused, retired, or incomplete.

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
- Latest notification state, transport/evidence tooltip, and delivery-attention count
- A global fail-closed warning when persisted notification-ledger data is unsupported or malformed
- Persistent configuration errors, including every path participating in a duplicate identity
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

Watchlist-owned frontmatter mutations always use Obsidian's supported `fileManager.processFrontMatter` API. File opening uses native workspace APIs. File-updated events and Notebook Navigator rule application use GCM when available, with scoped native behavior where the result is unambiguous. Daily-note event logging deliberately has no manual or private-API fallback: it requires GCM's `dailyNotes.ensureForIsoDate` capability and fails clearly before an unsupported daily-note action. The settings UI displays this dependency; selecting watch-note logging works without GCM.

## Notification integration

TPS Notifier is optional.

- Watchlist decides whether an event is meaningful and owns durable delivery accounting; Notifier supplies push transport only.
- The supported v2 route is discovered through workspace request/available/unavailable events and returns structured delivery certainty. One canonical, isolated private-registry bridge remains temporarily for mixed-version v1 Notifier installs.
- Watch state plus `attempting` is saved before the call. A structured v2 receipt becomes `accepted`; resolved v1 promise delivery remains `legacy-accepted`; structured refusal becomes `rejected` or `not-attempted`; unconfirmed, timed-out, malformed, legacy-rejected, interrupted, or otherwise unclassifiable delivery becomes `unknown`.
- Ledger loading correlates state, transport, evidence, attempted certainty, attempt count, and detail fields. Impossible combinations such as accepted delivery over an unknown transport, a v2 receipt without its receipt details, or legacy evidence labeled as structured acceptance invalidate the ledger and fail closed rather than manufacturing certainty.
- Watchlist never sends a second transport attempt for the same event. It shows an Obsidian Notice only when the client proves that no push attempt occurred; it never falls back after `rejected` or `unknown`.
- Delivery outcomes do not turn an otherwise successful baseline/event check into a provider failure and do not roll back failure-threshold health state.
- Both `accepted` and `legacy-accepted` failure alerts retain the legacy `lastErrorNotifiedAt` compatibility projection through a narrowly matched state write followed by another ownership check; the event-keyed ledger remains authoritative and preserves their distinct evidence.
- Unload marks the plugin unavailable before disposing the notifier client, and every queued state mutation checks that fence before `saveData`; a transport completion arriving after unload cannot begin a late ledger settlement write.
- Ledger records are pruned oldest-terminal-first at 1,000 entries. Active attempts are never removed; if they occupy the full bound, new notification I/O fails closed. A later encounter with any pruned event marker becomes `unknown`, never a replay.
- There is intentionally no manual resend action. A safe resend feature would require an explicit new event/attempt contract and user-visible duplicate-risk acknowledgement.
- Notifications link back to the durable watch note when the delivery transport supports a file target.

## AI Gateway integration

When TPS AI Gateway is available, Watchlist registers guarded capabilities:

- `watchlist.create-watch`
- `watchlist.check-watch`

Both require confirmation. AI can propose structured watch fields, but Watchlist validates the input and retains mutation authority. Provider fetching, numeric comparisons, fingerprints, transitions, and deduplication are deterministic.

Gateway discovery uses the canonical versioned workspace request/available/unavailable event contract. It does not read Obsidian's private plugin registry, patch or consume `app.tpsAiGateway`, or depend on a timeout retry. Availability can be discovered early, but publication waits for completed integration initialization plus a verified, reconciled identity catalog. Base repair is attempted and reported independently because neither AI capability depends on a Base file. Repeated availability for the same provider does not duplicate registrations. Withdrawal and reload invalidate the old execution lease before attempting cleanup. A new provider is installed only when every old unregister succeeds; any cleanup uncertainty blocks replacement for the rest of that plugin instance. Registration is transactional across both capabilities, and even a provider-retained callback rejects before reaching `createWatch` or `checkPath` when its generation is stale, Watchlist is unloading, or catalog readiness is lost. Unload invalidates/disposes AI before other integrations and contains every GCM disposer independently. Provider registration and cleanup errors are logged rather than routed through an unsupported fallback.

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

`checkAll()` and `checkPath()` return a structured skipped result for duplicate identities with `code: "duplicate-watch-id"`, `conflictingPaths`, and an `attempted` flag. A definition or unsettled watch catalog changed during a check returns `code: "watch-definition-changed"`. Failure-health persistence failures return `code: "state-persistence-failed"`. When a late ownership change or internal completion failure follows confirmed durable work, `sideEffectsCommitted` is true; `watchId` reflects a newly assigned durable identity, and `eventId` identifies an appended event when one exists. Failure-threshold events use the same accounting. Ownership/configuration skips do not increment the watch's provider-failure counter. When notification accounting applies, `notification` reports the event ID, kind, state, transport, evidence, attempted certainty, and update time. `getWatches()` exposes the detached `latestNotification` summary for each watch.

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
- Duplicate identity detection, blocked path/count, and batch identity-blocked totals
- GCM action availability and AI Gateway availability, registration, replacement, rollback, and cleanup
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
- Duplicate IDs are never auto-repaired because existing shared state cannot prove which copied note owns it. Replace the ID on every conflicting note with a new unique value; each repaired watch's first successful check is a silent baseline. The old ambiguous cached state is cleared when the conflict is quarantined rather than assigned to an arbitrary owner.
- Same-process discovery of Controller and GCM still reads Obsidian's private plugin registry because those peer plugins expose APIs on plugin instances. Watchlist also publishes the legacy `app.tpsWatchlist` App-object API. AI Gateway discovery no longer uses either pattern. Notifier v2 is event-discovered, but its canonical client retains one explicitly isolated v1 private-registry bridge until mixed-version devices are retired.
- Lifecycle epochs and the serialized save queue fence same-instance unload/reload, including active saves before in-memory installation. Obsidian plugin data exposes no cancellation or compare-and-set primitive across separately constructed plugin instances, so an already-issued old-instance `saveData` write cannot be given a mathematical cross-instance exclusion guarantee.
- Startup verification reads Markdown files sequentially, and an unresolved Markdown mutation conservatively blocks the global watch identity catalog. Recovery itself is path-scoped, coalesced, and capped, but very large or high-churn vaults can still delay checks. A supported path-index/capability service is a future performance enhancement.
- GCM's daily-note capability returns only a file, not a `{ file, created }` receipt. Watchlist therefore does not guess whether that call created a note and does not include daily-note creation in `sideEffectsCommitted`; the subsequent event append is still recorded exactly. A receipt-bearing GCM contract would make that preparation effect observable.

## Validation

- `npm run test:core` runs 77 tests: 47 core/identity/integration regressions, 21 executable notification tests, and 9 AI Gateway/GCM lifecycle/static regressions. Integration coverage includes late availability, same-provider idempotence, ordered provider replacement, withdrawal, partial-registration rollback, reentrant replacement, cleanup-blocked replacement, provider-retained stale create/check handlers, pre-readiness and post-unload execution rejection, transactional GCM registration failure/supersession, rollback-failed leaked-action rejection, isolated multi-callback cleanup, async Base lifecycle fencing, Base-repair independence, absence of AI private discovery/monkeypatching, and preservation of the lifecycle-fenced GCM-only retry.
- `npm test` runs focused core tests and the production TypeScript/esbuild build.
- Core state/lease/settlement/effect, notification client/ledger/orchestration, and AI Gateway client/registration lifecycle behavior have direct executable coverage. Several full plugin/Obsidian orchestration checks remain source-structure assertions rather than a complete fake-Obsidian integration harness.
- This optimization lane was typechecked and built without deployment. It was not loaded in Obsidian and did not issue a live provider request or notification because no safe synthetic external-provider fixture was authorized for this cycle.
- After acceptance and explicit test deployment, rebuild and reload the test-vault plugin before UI or provider-flow validation.
- Obsidian 1.12.7 validation confirmed plugin load, ribbon registration, the empty dashboard, responsive create-watch modal, Controller-only defaults, collapsible settings, native Watchlist Base rendering, and zero-result behavior without creating a QA watch or external notification.

## Version notes

- 0.1.1: Isolated every watch worker and secondary failure-bookkeeping step so one broken identity write, provider, event target, state save, or dashboard render cannot reject the rest of a batch. Failure-event write errors retry at the configured threshold, transient path-keyed health state migrates when a durable watch ID can be assigned, and provider error summaries redact source URLs and credential-like parameters before logs or Markdown persistence. Validation: focused core regression tests and full `npm test`, including production build.
- 0.1.1: Made watch-event append/dedupe atomic against the latest canonical note content, shared concurrent checks for the same watch path, and based RSS `new-item` fingerprints on stable item identity so content corrections do not trigger false new-item events. Existing RSS baselines migrate silently on their first successful post-upgrade check.
- 0.1.0: Initial contract-native watch entities, page/JSON/RSS providers, transition engine, persisted baselines, daily-note events, failure escalation, Controller-aware scheduling, dashboard, Bases, GCM actions, Notifier delivery, AI capabilities, public API, settings, diagnostics, and core tests.
