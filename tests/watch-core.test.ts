import test from "node:test";
import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  appendLineOnce,
  applyWatchEffectJournal,
  applyWatchDefinitionOverlays,
  applyWatchStateCommit,
  cloneWatchStateRecord,
  createFeedSourceIdentity,
  createEmptyState,
  createEventId,
  createUntrustedOperationalState,
  createWatchEffectJournal,
  createWatchStateRecord,
  duplicateWatchIdError,
  evaluateObservation,
  extractPattern,
  findDuplicateWatchIdPaths,
  joinSingleFlight,
  observationFingerprint,
  parseNumericValue,
  planWatchStateMigration,
  quarantineWatchIdentityConflicts,
  quarantineWatchIdentities,
  recordWatchCommittedEffect,
  recordWatchIdentityWrite,
  resolveJsonPath,
  sanitizeWatchErrorMessage,
  stableHash,
  validateDefinition,
  watchDefinitionContentSignature,
  watchDefinitionSignature,
  watchEventTransitionKey,
  WatchCatalogSettlementTracker,
  WatchIdentityLeaseRegistry,
  WATCH_FINGERPRINT_VERSION,
} from "../src/core";
import type { WatchDefinition, WatchObservation } from "../src/types";

const definition = (overrides: Partial<WatchDefinition> = {}): WatchDefinition => ({
  id: "watch-1",
  hasDurableId: true,
  path: "Watches/Test.md",
  title: "Test",
  provider: "page",
  url: "https://example.com",
  selector: "",
  jsonPath: "",
  pattern: "",
  query: "",
  condition: "changed",
  target: "",
  intervalMinutes: 15,
  notify: true,
  cooldownMinutes: 0,
  caseSensitive: false,
  status: "working",
  tags: [],
  ...overrides,
});

const observation = (value: string, fingerprint = stableHash(value)): WatchObservation => ({
  observedAt: "2026-07-11T12:00:00.000Z",
  value,
  displayValue: value,
  numericValue: parseNumericValue(value),
  fingerprint,
  summary: value,
});

test("resolves nested JSON paths and bracket indexes", () => {
  assert.equal(resolveJsonPath({ quote: { data: [{ price: 42.5 }] } }, "$.quote.data[0].price"), 42.5);
});

test("extracts regex capture groups", () => {
  assert.equal(extractPattern("Price: $1,249.99", "Price:\\s+\\$([\\d,.]+)", false), "1,249.99");
});

test("stores the first observation as a silent baseline", () => {
  const result = evaluateObservation(definition(), observation("first"), undefined);
  assert.equal(result.eventKind, "baseline");
  assert.equal(result.shouldEmit, false);
});

test("changed emits only when the fingerprint changes", () => {
  const state = { ...createEmptyState(), baselineReady: true, lastFingerprint: stableHash("first") };
  assert.equal(evaluateObservation(definition(), observation("first"), state).shouldEmit, false);
  assert.equal(evaluateObservation(definition(), observation("second"), state).shouldEmit, true);
});

test("numeric thresholds emit only on a false-to-true transition", () => {
  const watch = definition({ condition: "below", target: "100" });
  const state = {
    ...createEmptyState(),
    baselineReady: true,
    lastFingerprint: stableHash("120"),
    lastMatched: false,
  };
  const result = evaluateObservation(watch, observation("$89.99"), state);
  assert.equal(result.matched, true);
  assert.equal(result.shouldEmit, true);
  const stillMatched = evaluateObservation(watch, observation("$85"), { ...state, lastMatched: true });
  assert.equal(stillMatched.shouldEmit, false);
});

test("availability rejects sold-out language before positive words", () => {
  const watch = definition({ condition: "available" });
  const state = {
    ...createEmptyState(),
    baselineReady: true,
    lastFingerprint: stableHash("Sold out"),
    lastMatched: false,
  };
  assert.equal(evaluateObservation(watch, observation("Sold out - notify me when available"), state).matched, false);
  assert.equal(evaluateObservation(watch, observation("In stock - add to cart"), state).shouldEmit, true);
});

test("stable hashes are deterministic and input-sensitive", () => {
  assert.equal(stableHash("same"), stableHash("same"));
  assert.notEqual(stableHash("same"), stableHash("different"));
});

test("duplicate durable watch IDs block every owner in deterministic path order", () => {
  const definitions = [
    definition({ id: "shared-id", path: "Watches/Zeta.md", status: "holding" }),
    definition({ id: "unique-id", path: "Watches/Unique.md" }),
    definition({ id: "shared-id", path: "Watches/Alpha.md", url: "", status: "working" }),
    definition({ id: "shared-id", path: "Watches/Middle.md", status: "archived" }),
  ];
  const conflicts = findDuplicateWatchIdPaths(definitions);
  assert.deepEqual(Array.from(conflicts.entries()), [[
    "shared-id",
    ["Watches/Alpha.md", "Watches/Middle.md", "Watches/Zeta.md"],
  ]]);
  const error = duplicateWatchIdError("shared-id", conflicts.get("shared-id") || []);
  assert.match(error, /Duplicate watchId "shared-id" is used by 3 watch notes/);
  assert.match(error, /new silent baseline before its prior state is trusted again/);
  assert.match(validateDefinition(definitions[0], conflicts.get("shared-id")).join("; "), /Duplicate watchId/);
});

test("duplicate identity paths preserve exact vault path whitespace", () => {
  const conflicts = findDuplicateWatchIdPaths([
    definition({ id: "shared-id", path: "Watches/A B.md" }),
    definition({ id: "shared-id", path: "Watches/A  B.md" }),
  ]);
  assert.deepEqual(conflicts.get("shared-id"), ["Watches/A  B.md", "Watches/A B.md"]);
});

test("transient missing-ID definitions do not collide or masquerade as durable IDs", () => {
  const conflicts = findDuplicateWatchIdPaths([
    definition({ id: "path:Watches/One.md", hasDurableId: false, path: "Watches/One.md" }),
    definition({ id: "path:Watches/One.md", hasDurableId: false, path: "Watches/Two.md" }),
    definition({ id: "path:custom", hasDurableId: true, path: "Watches/Explicit.md" }),
  ]);
  assert.equal(conflicts.size, 0);
  assert.equal(duplicateWatchIdError("watch-1", ["Watches/Only.md"]), "");
});

test("watch state records safely own reserved JavaScript property names", () => {
  const states = createWatchStateRecord();
  const state = createEmptyState();
  states["__proto__"] = state;
  states["constructor"] = state;
  assert.equal(Object.getPrototypeOf(states), null);
  assert.equal(states["__proto__"], state);
  assert.equal(states["constructor"], state);
  assert.deepEqual(Object.keys(states).sort(), ["__proto__", "constructor"]);
});

test("transient migration cannot steal state from a legitimate durable path-prefixed ID", () => {
  const states = createWatchStateRecord();
  const transientStates = createWatchStateRecord();
  const path = "Watches/Missing.md";
  const legacyKey = "path:" + path;
  const legacyState = { ...createEmptyState(), baselineReady: true, lastValue: "legacy" };
  states[legacyKey] = legacyState;
  const missingId = definition({ id: legacyKey, hasDurableId: false, path });
  const blocked = planWatchStateMigration(missingId, states, transientStates, new Set([legacyKey]));
  assert.equal(blocked.state, undefined);
  assert.equal(blocked.legacyStateKey, undefined);
  const eligible = planWatchStateMigration(missingId, states, transientStates, new Set());
  assert.equal(eligible.state, legacyState);
  assert.equal(eligible.legacyStateKey, legacyKey);
});

test("state commit migrates exact-path transient state and releases quarantine only after success", () => {
  const states = createWatchStateRecord();
  const transientStates = createWatchStateRecord();
  const quarantined = new Set(["watch-new"]);
  const quarantinedPaths = new Set(["Watches/Missing.md"]);
  const path = "Watches/Missing.md";
  const transientState = { ...createEmptyState(), baselineReady: true, lastValue: "path state" };
  transientStates[path] = transientState;
  const resolved = definition({ id: "watch-new", path });
  const migration = planWatchStateMigration(resolved, states, transientStates, new Set([resolved.id]));
  const failedState = { ...createEmptyState(), failureCount: 1, lastError: "failed" };
  applyWatchStateCommit(states, transientStates, quarantined, quarantinedPaths, resolved, failedState, migration, false);
  assert.equal(states[resolved.id], failedState);
  assert.equal(transientStates[path], undefined);
  assert.equal(quarantined.has(resolved.id), true);
  assert.equal(quarantinedPaths.has(path), true);
  const baseline = { ...createEmptyState(), baselineReady: true, lastValue: "fresh" };
  applyWatchStateCommit(states, transientStates, quarantined, quarantinedPaths, resolved, baseline, {}, true);
  assert.equal(states[resolved.id], baseline);
  assert.equal(quarantined.has(resolved.id), false);
  assert.equal(quarantinedPaths.has(path), false);
});

test("quarantine clears ambiguous state once without repeatedly erasing later diagnostics", () => {
  const states = createWatchStateRecord();
  const quarantined = new Set<string>();
  states["shared-id"] = { ...createEmptyState(), baselineReady: true, lastValue: "ambiguous" };
  assert.deepEqual(quarantineWatchIdentities(states, quarantined, ["shared-id"]), ["shared-id"]);
  assert.equal(states["shared-id"].baselineReady, false);
  states["shared-id"] = { ...createEmptyState(), failureCount: 1, lastError: "provider failed" };
  assert.deepEqual(quarantineWatchIdentities(states, quarantined, ["shared-id"]), []);
  assert.equal(states["shared-id"].lastError, "provider failed");
  const operational = createUntrustedOperationalState(states["shared-id"]);
  assert.equal(operational.baselineReady, false);
  assert.equal(operational.failureCount, 1);
  assert.equal(operational.lastError, "provider failed");
});

test("conflict quarantine records every exact path and suppresses repaired-path migration", () => {
  const states = createWatchStateRecord();
  const transientStates = createWatchStateRecord();
  const quarantinedIds = new Set<string>();
  const quarantinedPaths = new Set<string>();
  const path = "Watches/A  B.md";
  transientStates[path] = { ...createEmptyState(), baselineReady: true, lastValue: "unsafe" };
  const changes = quarantineWatchIdentityConflicts(
    states,
    quarantinedIds,
    quarantinedPaths,
    new Map([["shared-id", [path, "Watches/Peer.md"]]]),
  );
  assert.deepEqual(changes.addedIds, ["shared-id"]);
  assert.deepEqual(changes.addedPaths, [path, "Watches/Peer.md"]);
  const repaired = definition({ id: "new-id", path });
  const migration = planWatchStateMigration(
    repaired,
    states,
    transientStates,
    new Set(["new-id"]),
    quarantinedPaths,
  );
  assert.equal(migration.state, undefined);
});

test("definition signatures detect behavior edits while content signatures ignore identity assignment", () => {
  const original = definition();
  const clone = definition({ tags: [] });
  const changedSource = definition({ url: "https://example.com/changed" });
  const assignedIdentity = definition({ id: "watch-2", hasDurableId: true });
  assert.equal(watchDefinitionSignature(original), watchDefinitionSignature(clone));
  assert.notEqual(watchDefinitionSignature(original), watchDefinitionSignature(changedSource));
  assert.notEqual(watchDefinitionSignature(original), watchDefinitionSignature(assignedIdentity));
  assert.equal(watchDefinitionContentSignature(original), watchDefinitionContentSignature(assignedIdentity));
});

test("identity leases symmetrically taint every overlapping path and retain conflict history", () => {
  const leases = new WatchIdentityLeaseRegistry();
  const first = leases.acquire("shared-id", "Watches/First.md");
  const second = leases.acquire("shared-id", "Watches/Second.md");
  assert.equal(first, second);
  assert.equal(first.conflicted, true);
  assert.deepEqual(Array.from(first.conflictPaths).sort(), ["Watches/First.md", "Watches/Second.md"]);
  leases.release(second, "Watches/Second.md");
  assert.equal(first.conflicted, true);
  assert.deepEqual(Array.from(first.activePaths), ["Watches/First.md"]);
  leases.release(first, "Watches/First.md");
  const fresh = leases.acquire("shared-id", "Watches/Third.md");
  assert.notEqual(fresh, first);
  assert.equal(fresh.conflicted, false);
});

test("identity leases count concurrent checks for one path without false conflicts", () => {
  const leases = new WatchIdentityLeaseRegistry();
  const first = leases.acquire("shared-id", "Watches/Same.md");
  const joined = leases.acquire("shared-id", "Watches/Same.md");
  assert.equal(first, joined);
  assert.equal(first.conflicted, false);
  leases.release(joined, "Watches/Same.md");
  assert.deepEqual(Array.from(first.activePaths), ["Watches/Same.md"]);
  leases.release(first, "Watches/Same.md");
  const fresh = leases.acquire("shared-id", "Watches/Other.md");
  assert.notEqual(fresh, first);
});

test("identity leases treat a rename of the same file owner as one owner", () => {
  const leases = new WatchIdentityLeaseRegistry();
  const first = leases.acquire("shared-id", "file-1", "Watches/A.md");
  const renamed = leases.acquire("shared-id", "file-1", "Watches/B.md");
  assert.equal(first, renamed);
  assert.equal(first.conflicted, false);
  assert.deepEqual(Array.from(first.activePaths), ["Watches/B.md"]);
  assert.deepEqual(Array.from(first.conflictPaths), ["Watches/B.md"]);
  const peer = leases.acquire("shared-id", "file-2", "Watches/C.md");
  assert.equal(peer.conflicted, true);
  assert.deepEqual(Array.from(peer.conflictPaths).sort(), ["Watches/B.md", "Watches/C.md"]);
  leases.release(peer, "file-2");
  leases.release(first, "file-1");
  leases.release(renamed, "file-1");
});

test("catalog duplicate detection can taint an active owner without starting a peer check", () => {
  const leases = new WatchIdentityLeaseRegistry();
  const lease = leases.acquire("shared-id", "file-1", "Watches/A.md");
  leases.taint("shared-id", ["Watches/A.md", "Watches/B.md"]);
  assert.equal(lease.conflicted, true);
  assert.deepEqual(Array.from(lease.conflictPaths).sort(), ["Watches/A.md", "Watches/B.md"]);
});

test("catalog settlement rejects a stale callback after a newer write", () => {
  const settlements = new WatchCatalogSettlementTracker();
  const firstRevision = settlements.markPending("Watches/A.md");
  assert.equal(settlements.hasUntrustedPending(), true);
  assert.equal(settlements.hasUntrustedPending(new Map([["Watches/A.md", firstRevision]])), false);
  const secondRevision = settlements.markPending("Watches/A.md");
  assert.equal(settlements.hasUntrustedPending(new Map([["Watches/A.md", firstRevision]])), true);
  assert.equal(settlements.settle("Watches/A.md", firstRevision), false);
  assert.equal(settlements.hasUntrustedPending(), true);
  assert.equal(settlements.getRevision("Watches/A.md"), secondRevision);
  assert.equal(settlements.settle("Watches/A.md", secondRevision), true);
  assert.equal(settlements.hasUntrustedPending(), false);
});

test("catalog settlement transfers an unresolved modification across rename", () => {
  const settlements = new WatchCatalogSettlementTracker();
  const oldRevision = settlements.markPending("Watches/Before.md");
  const revision = settlements.move("Watches/Before.md", "Watches/After.md");
  assert.notEqual(revision, oldRevision);
  assert.equal(settlements.getRevision("Watches/Before.md"), undefined);
  assert.equal(settlements.getRevision("Watches/After.md"), revision);
  assert.deepEqual(settlements.entries(), [["Watches/After.md", revision]]);
  assert.equal(settlements.settle("Watches/After.md", revision!), true);
});

test("effect journals preserve exact event identity through a later failure", () => {
  const effects = createWatchEffectJournal();
  const failure = {
    watchId: "watch-1",
    path: "Watches/Test.md",
    outcome: "failed" as const,
    error: "persistence failed",
  };
  assert.equal(applyWatchEffectJournal(failure, effects), failure);
  recordWatchCommittedEffect(effects, "watch-event-123");
  assert.deepEqual(applyWatchEffectJournal(failure, effects), {
    ...failure,
    eventId: "watch-event-123",
    sideEffectsCommitted: true,
  });
});

test("effect journals preserve a committed identity write across later validation failure", () => {
  const effects = createWatchEffectJournal();
  recordWatchIdentityWrite(effects, "watch-assigned");
  assert.deepEqual(applyWatchEffectJournal({
    watchId: "path:Watches/Test.md",
    path: "Watches/Test.md",
    outcome: "skipped",
  }, effects), {
    watchId: "watch-assigned",
    path: "Watches/Test.md",
    outcome: "skipped",
    sideEffectsCommitted: true,
  });
});

test("event IDs ignore retry-only check times but distinguish recurring transitions", () => {
  const nextObservation = observation("B", "fingerprint-b");
  const firstPrior = {
    ...createEmptyState(),
    baselineReady: true,
    lastFingerprint: "fingerprint-a",
    lastValue: "A",
    lastCheckedAt: "2026-07-19T10:00:00.000Z",
    failureCount: 2,
  };
  const retryAfterFailedEscalation = {
    ...firstPrior,
    lastCheckedAt: "2026-07-19T11:00:00.000Z",
    lastError: "The same provider failure was recorded after the event append.",
  };
  const laterRecurringPrior = {
    ...retryAfterFailedEscalation,
    lastEventAt: "2026-07-19T11:30:00.000Z",
    lastEventId: "watch-event-returned-to-a",
  };
  const first = createEventId("watch-1", nextObservation, "changed", watchEventTransitionKey(firstPrior));
  const retry = createEventId(
    "watch-1",
    nextObservation,
    "changed",
    watchEventTransitionKey(retryAfterFailedEscalation),
  );
  const recurring = createEventId(
    "watch-1",
    nextObservation,
    "changed",
    watchEventTransitionKey(laterRecurringPrior),
  );
  assert.equal(retry, first);
  assert.notEqual(recurring, first);
});

test("verified catalog overlays replace stale watches and remove proven non-watch paths", () => {
  const staleChanged = definition({ id: "watch-2", path: "Watches/Changed.md" });
  const actualOwner = definition({ id: "watch-2", path: "Watches/Owner.md" });
  const liveChanged = definition({ id: "watch-1", path: "Watches/Changed.md" });
  const changedOverlay = applyWatchDefinitionOverlays(
    [staleChanged, actualOwner],
    new Map([[liveChanged.path, liveChanged]]),
  );
  assert.deepEqual(findDuplicateWatchIdPaths(changedOverlay), new Map());

  const staleDaily = definition({ id: "watch-2", path: "Daily/2026-07-19.md" });
  const nonWatchOverlay = applyWatchDefinitionOverlays(
    [staleDaily, actualOwner],
    new Map([[staleDaily.path, null]]),
  );
  assert.deepEqual(nonWatchOverlay.map((entry) => entry.path), [actualOwner.path]);
  assert.deepEqual(findDuplicateWatchIdPaths(nonWatchOverlay), new Map());
});

test("persistent state drafts are detached, including reserved JavaScript keys", () => {
  const states = createWatchStateRecord();
  states.__proto__ = { ...createEmptyState(), lastValue: "original" };
  const draft = cloneWatchStateRecord(states);
  draft.__proto__.lastValue = "draft";
  assert.equal(states.__proto__.lastValue, "original");
  assert.equal(draft.__proto__.lastValue, "draft");
  assert.equal(Object.getPrototypeOf(draft), null);
});

test("failure summaries redact source URLs and standalone credential parameters", () => {
  const sanitized = sanitizeWatchErrorMessage(new Error(
    "GET https://user:pass@api.example.com/private/account?api_key=super-secret failed; token=another-secret",
  ));
  assert.match(sanitized, /https:\/\/api\.example\.com\/\[redacted\]/);
  assert.match(sanitized, /token=\[redacted\]/);
  assert.doesNotMatch(sanitized, /user|pass|private\/account|super-secret|another-secret/);
});

test("atomic event append preserves current content and deduplicates by event marker", () => {
  const line = "- Watch changed <!-- [watchEventId:: event-1] -->";
  const first = appendLineOnce("User edit", "[watchEventId:: event-1]", line);
  assert.equal(first.appended, true);
  assert.equal(first.content, "User edit\n" + line + "\n");
  const duplicate = appendLineOnce(first.content, "[watchEventId:: event-1]", line);
  assert.equal(duplicate.appended, false);
  assert.equal(duplicate.content, first.content);
});

test("single-flight joins concurrent checks by key and clears after completion", async () => {
  const inFlight = new Map<string, Promise<string>>();
  let starts = 0;
  let release!: (value: string) => void;
  const start = () => {
    starts += 1;
    return new Promise<string>((resolve) => { release = resolve; });
  };
  const first = joinSingleFlight(inFlight, "Watches/Test.md", start);
  const second = joinSingleFlight(inFlight, "Watches/Test.md", start);
  assert.equal(first.joined, false);
  assert.equal(second.joined, true);
  assert.equal(first.promise, second.promise);
  assert.equal(starts, 1);
  release("done");
  assert.deepEqual(await Promise.all([first.promise, second.promise]), ["done", "done"]);
  assert.equal(inFlight.size, 0);
  const third = joinSingleFlight(inFlight, "Watches/Test.md", async () => "again");
  assert.equal(third.joined, false);
  assert.equal(await third.promise, "again");
  const failed = joinSingleFlight(inFlight, "Watches/Test.md", async () => { throw new Error("failed"); });
  await assert.rejects(failed.promise, /failed/);
  assert.equal(inFlight.size, 0);
});

test("RSS new-item fingerprints stable source identity rather than mutable item text", () => {
  const first = observationFingerprint("new-item", "Original title and summary", "guid-1");
  const edited = observationFingerprint("new-item", "Corrected title and summary", "guid-1");
  assert.equal(first, edited);
  assert.notEqual(first, observationFingerprint("new-item", "Original title and summary", "guid-2"));
  assert.notEqual(
    observationFingerprint("changed", "Original title and summary", "guid-1"),
    observationFingerprint("changed", "Corrected title and summary", "guid-1"),
  );
});

test("legacy RSS new-item baselines migrate silently before stable-identity alerts", () => {
  const watch = definition({ provider: "rss", condition: "new-item" });
  const state = {
    ...createEmptyState(),
    fingerprintVersion: 1,
    baselineReady: true,
    lastFingerprint: stableHash("legacy-id|legacy content"),
  };
  const result = evaluateObservation(watch, observation("new content", stableHash("stable-id")), state);
  assert.equal(result.shouldEmit, false);
  assert.match(result.reason, /baseline upgraded/i);
  const migrated = evaluateObservation(watch, observation("another item", stableHash("next-id")), {
    ...state,
    fingerprintVersion: WATCH_FINGERPRINT_VERSION,
    lastFingerprint: stableHash("stable-id"),
  });
  assert.equal(migrated.shouldEmit, true);
});

test("RSS source identity falls back from provider ID to item link then title and date", () => {
  assert.equal(createFeedSourceIdentity("guid-1", "https://example.com/item", "Title", "2026-07-11"), "guid-1");
  assert.equal(createFeedSourceIdentity("", "https://example.com/item", "Title", "2026-07-11"), "https://example.com/item");
  assert.equal(createFeedSourceIdentity("", "", "Title", "2026-07-11"), "Title|2026-07-11");
});

test("Watchlist keys single-flight by path and immutable definition signature", () => {
  const source = readFileSync("src/main.ts", "utf8");
  assert.match(source, /const flightKey = path \+ "\|" \+ signature/);
  assert.match(source, /joinSingleFlight\(\s*this\.checksInFlight,\s*flightKey,/);
  assert.match(source, /await this\.app\.vault\.process\(target,/);
  assert.doesNotMatch(source, /cachedRead\(target\)/);
});

test("Watchlist isolates failed workers and revalidates ownership on provider rejection", () => {
  const source = readFileSync("src/main.ts", "utf8");
  assert.match(source, /try \{\s*results\.push\(await this\.checkOne\(definition, reason\)\);\s*\} catch \(error\)/);
  assert.match(source, /"watch:unhandled-rejection"/);
  const providerSection = source.slice(
    source.indexOf("let observation: WatchObservation;"),
    source.indexOf("const evaluation = evaluateObservation("),
  );
  assert.match(providerSection, /catch \(error\) \{\s*const providerFailureOwnership = await this\.identityOwnershipFailure/);
  assert.ok(
    providerSection.indexOf("providerFailureOwnership")
      < providerSection.indexOf("return await this.handleFailure("),
    "provider errors must be ownership-checked before failure state or escalation",
  );
  assert.match(source, /"failure-escalation:failed"/);
  assert.match(source, /failureCount: failureEscalationFailed \? previous\.failureCount : failureCount/);
  assert.match(source, /"failure-state:persist-failed"/);
  assert.match(source, /"failure-state:view-refresh-failed"/);
});

test("Watchlist blocks duplicate identities before provider work and at the commit boundary", () => {
  const source = readFileSync("src/main.ts", "utf8");
  const checkOneSource = source.slice(
    source.indexOf("private async checkOne("),
    source.indexOf("private async performCheckOne("),
  );
  assert.ok(
    checkOneSource.indexOf("if (conflictingPaths.length > 1)")
      < checkOneSource.indexOf("joinSingleFlight("),
    "catalog conflicts must be rejected before allocating a path check",
  );

  const performSource = source.slice(
    source.indexOf("private async performCheckOne("),
    source.indexOf("private getDuplicateWatchIdPathsWithOverlays("),
  );
  assert.ok(
    performSource.indexOf("this.identityLeases.acquire")
      < performSource.indexOf("fetchWatchObservation("),
    "identity ownership must be leased before the provider request",
  );
  assert.ok(
    performSource.indexOf("const commitOwnershipFailure =")
      > performSource.indexOf("fetchWatchObservation("),
    "identity ownership must be revalidated after the provider request",
  );
  assert.ok(
    performSource.indexOf("const commitOwnershipFailure =")
      < performSource.indexOf("const evaluation = evaluateObservation("),
    "a late conflict must stop before event evaluation or state mutation",
  );

  const blockedResultSource = source.slice(
    source.indexOf("private async duplicateWatchIdResult("),
    source.indexOf("private watchDefinitionChangedResult("),
  );
  assert.doesNotMatch(blockedResultSource, /this\.states|appendWatchEvent|deliverNotification|fetchWatchObservation/);
  assert.match(blockedResultSource, /code: "duplicate-watch-id"/);
  assert.match(blockedResultSource, /outcome: "skipped"/);
  assert.doesNotMatch(source, /identityChecksInFlight/);
  assert.match(source, /private identityLeases = new WatchIdentityLeaseRegistry\(\)/);
  assert.match(source, /private states: Record<string, WatchState> = createWatchStateRecord\(\)/);
  assert.match(source, /hasDurableId: Boolean\(durableId\)/);
  assert.doesNotMatch(source, /definition\.id\.startsWith\("path:"\)/);
});

test("Watchlist separates transient state, persists quarantine, and rebaselines repaired identities", () => {
  const source = readFileSync("src/main.ts", "utf8");
  const coreSource = readFileSync("src/core.ts", "utf8");
  assert.match(source, /private transientStates: Record<string, WatchState> = createWatchStateRecord\(\)/);
  assert.match(source, /private quarantinedWatchIds = new Set<string>\(\)/);
  assert.match(coreSource, /const legacyState = !durableIds\.has\(legacyStateKey\)/);
  assert.match(source, /await this\.ensureQuarantinePersisted\(\)/);
  assert.match(coreSource, /if \(establishTrustedBaseline\) \{\s*quarantinedWatchIds\.delete\(definition\.id\);\s*quarantinedWatchPaths\.delete\(definition\.path\)/);
  assert.match(source, /private pendingQuarantineIds = new Set<string>\(\)/);
  assert.match(source, /private pendingQuarantinePaths = new Set<string>\(\)/);
  assert.match(source, /persistPendingIdentitySafetyState/);
  assert.match(source, /transientStates: cloneWatchStateRecord\(model\.transientStates\)/);
  assert.match(source, /quarantinedWatchIds: Array\.from\(model\.quarantinedWatchIds\)/);
  assert.match(source, /const stateTrusted = !blocked && this\.isStateTrusted\(definition\)/);
  assert.match(source, /configurationErrors: validateDefinition\(definition, conflictingPaths\)/);
});

test("Watchlist caches one revisioned identity catalog and avoids a redundant batch save", () => {
  const source = readFileSync("src/main.ts", "utf8");
  assert.match(source, /if \(this\.identitySnapshotCache\?\.revision === this\.watchCatalogRevision\)/);
  assert.match(source, /duplicatePathsById: findDuplicateWatchIdPaths\(definitions\)/);
  const batchSource = source.slice(
    source.indexOf("private async checkDefinitions("),
    source.indexOf("private async checkOne("),
  );
  assert.doesNotMatch(batchSource, /await this\.persistData\(\)/);
});

test("Watchlist keeps row reads pure and blocks checks across unresolved metadata revisions", () => {
  const source = readFileSync("src/main.ts", "utf8");
  const rowsSource = source.slice(
    source.indexOf("getWatchRows(): WatchRow[]"),
    source.indexOf("private scanWatchDefinitions("),
  );
  assert.doesNotMatch(rowsSource, /quarantineDuplicateIdentities|persistData|saveData/);
  assert.match(rowsSource, /definition: cloneWatchDefinition\(definition\)/);
  assert.match(source, /getSettings: \(\) => \(\{ \.\.\.this\.settings \}\)/);
  assert.match(source, /this\.app\.vault\.on\("modify"/);
  assert.match(source, /this\.catalogSettlements\.markPending\(file\.path\)/);
  assert.match(source, /metadataCache\.on\("changed", \(file, data, cache\)/);
  assert.match(source, /liveData !== indexedData/);
  assert.match(source, /this\.catalogSettlements\.settle\(path, pendingRevision\)/);
  assert.match(source, /metadataCache\.on\("resolved"/);
  assert.match(source, /probeWatchCatalogReadiness/);
  assert.match(source, /this\.hasUntrustedCatalogPending\(prepared\.trustedCatalogOverlays\)/);
  assert.match(source, /this\.requestCatalogRecovery\("vault-rename", true\)/);
  assert.match(source, /file instanceof TFolder/);
  assert.match(source, /handleCatalogFolderRename/);
  assert.match(source, /if \(newIsMarkdown\) this\.catalogSettlements\.markPending\(file\.path\)/);
  assert.match(source, /recoverPendingCatalogSettlements/);
  assert.match(source, /private stopCatalogRecovery\(\)/);
  assert.match(source, /if \(this\.unloading\) break/);
  assert.doesNotMatch(source, /semanticallySettledCatalogRevisions/);
  const reconcileSource = source.slice(
    source.indexOf("private async reconcileDuplicateIdentities("),
    source.indexOf("private hasUntrustedCatalogPending("),
  );
  assert.match(reconcileSource, /this\.hasUntrustedCatalogPending\(\)/);
  const exactSettlement = source.slice(
    source.indexOf("private async trustExactCatalogMutation("),
    source.indexOf("private withEffectJournal("),
  );
  assert.match(exactSettlement, /this\.catalogSettlements\.settle\(path, revision\)/);
  const settleIndex = exactSettlement.indexOf("this.catalogSettlements.settle(path, revision)");
  const invalidationAfterSettlement = exactSettlement.indexOf("this.invalidateWatchCatalog()", settleIndex);
  assert.ok(
    settleIndex >= 0
      && invalidationAfterSettlement > settleIndex
      && invalidationAfterSettlement < exactSettlement.indexOf("prepared.trustedCatalogOverlays.delete(path)"),
    "semantic settlement must invalidate any snapshot built while the revision was pending",
  );
});

test("Watchlist revalidates ownership after success and failure side-effect boundaries", () => {
  const source = readFileSync("src/main.ts", "utf8");
  const coreSource = readFileSync("src/core.ts", "utf8");
  const performSource = source.slice(
    source.indexOf("private async performCheckOne("),
    source.indexOf("private getDuplicateWatchIdPathsWithOverlays("),
  );
  assert.match(performSource, /postEventOwnershipFailure/);
  assert.match(performSource, /postPersistOwnershipFailure/);
  assert.match(performSource, /postNotificationOwnershipFailure/);
  const failureSource = source.slice(
    source.indexOf("private async handleFailure("),
    source.indexOf("private async appendWatchEvent("),
  );
  assert.match(failureSource, /postEventOwnershipFailure/);
  assert.match(failureSource, /postNotificationOwnershipFailure/);
  assert.match(failureSource, /preFailureStateOwnership/);
  assert.match(failureSource, /postFailureStateOwnership/);
  assert.match(coreSource, /sideEffectsCommitted: true/);
  assert.match(source, /this\.getFileOwnerKey\(file\) !== prepared\.ownerKey/);
  assert.match(source, /liveData !== write\.contentAfterWrite/);
});

test("Watchlist carries exact committed effects through late failures", () => {
  const source = readFileSync("src/main.ts", "utf8");
  assert.match(source, /const effects = createWatchEffectJournal\(\)/);
  assert.match(source, /recordWatchIdentityWrite\(effects, generatedId\)/);
  assert.match(source, /recordWatchCommittedEffect\(effects, eventId\)/);
  assert.match(source, /eventId: appended \? eventId : undefined/);
  assert.match(source, /previous\.lastValue,\s*effects,/);
  assert.match(source, /"",\s*effects,/);
  assert.match(source, /return this\.withEffectJournal\(\{/);
  assert.doesNotMatch(source, /ownershipCommitted/);
  const eventWriter = source.slice(
    source.indexOf("private async appendWatchEvent("),
    source.indexOf("private reportWatchEventWrite("),
  );
  assert.ok(
    eventWriter.indexOf("recordWatchCommittedEffect(effects, eventId)")
      < eventWriter.indexOf("this.reportWatchEventWrite("),
    "the durable append must be journaled before optional cross-plugin signaling",
  );
  const catchSection = source.slice(
    source.indexOf("} catch (error) {", source.indexOf("private async performCheckOne(")),
    source.indexOf("} finally {", source.indexOf("private async performCheckOne(")),
  );
  assert.match(catchSection, /providerResultAccepted/);
  assert.match(catchSection, /eventId: effects\.eventId/);
});

test("Watchlist revisions effective defaults and avoids ambiguous unsupported fallbacks", () => {
  const source = readFileSync("src/main.ts", "utf8");
  const settingsSource = source.slice(
    source.indexOf("async saveSettings()"),
    source.indexOf("openCreateModal()"),
  );
  assert.match(settingsSource, /this\.invalidateWatchCatalog\(\)/);
  assert.doesNotMatch(source, /internalPlugins|window as any\)\.moment/);
  assert.match(source, /Daily-note event logging requires the TPS Global Context Menu daily-notes capability/);
  assert.match(source, /new TPSNotifierClient<TFile>\(this\.app, this\.manifest\.id\)/);
  assert.doesNotMatch(source, /getNotifierApi/);
  const deliverySource = source.slice(
    source.indexOf("private async deliverNotification("),
    source.indexOf("private definitionFromFile("),
  );
  assert.match(deliverySource, /result\.state === "not-attempted" && result\.attempted === false/);
  assert.doesNotMatch(deliverySource, /catch[\s\S]*new Notice/);
  assert.doesNotMatch(source, /gcm\?\.frontmatter\?\.process/);
  assert.doesNotMatch(source, /new Set\(this\.app\.vault\.getMarkdownFiles\(\)\)/);
});

test("Watchlist persists path quarantine and records real transient preparation failures", () => {
  const source = readFileSync("src/main.ts", "utf8");
  assert.match(source, /private quarantinedWatchPaths = new Set<string>\(\)/);
  assert.match(source, /quarantinedWatchPaths: Array\.from\(model\.quarantinedWatchPaths\)/);
  assert.match(source, /identityStateVersion: WATCH_IDENTITY_STATE_VERSION/);
  assert.match(source, /await this\.recordTransientPreparationFailure\(definition\.path, summary\)/);
  assert.match(source, /resultCode = "state-persistence-failed"/);
  assert.match(source, /recordWatchCommittedEffect\(effects\)/);
  assert.match(source, /draft\.transientStates\[path\] = \{/);
  assert.match(source, /this\.movePathScopedIdentityState\(oldPath, file\.path\)/);
});

test("Watchlist installs state only after durable save and keeps the save queue usable", () => {
  const source = readFileSync("src/main.ts", "utf8");
  const transaction = source.slice(
    source.indexOf("private async mutatePersistentWatchState"),
    source.indexOf("private async persistData("),
  );
  assert.ok(
    transaction.indexOf("await this.saveData(this.persistentDataPayload(draft))")
      < transaction.indexOf("this.installPersistentWatchState(draft)"),
    "draft state must not become live before saveData succeeds",
  );
  assert.match(source, /this\.saveSerial = run\.then\(\(\) => undefined, \(\) => undefined\)/);
  assert.match(source, /const plan = await this\.commitWatchStateAndPrepareNotification\([\s\S]*?recordWatchCommittedEffect\(effects\);\s*return plan/);
  assert.match(source, /await this\.commitWatchStateDurably\([\s\S]*?recordWatchCommittedEffect\(effects\);/);
});

test("Watchlist retains identity-safety intent until its transaction succeeds", () => {
  const source = readFileSync("src/main.ts", "utf8");
  const persistence = source.slice(
    source.indexOf("private async persistPendingIdentitySafetyState("),
    source.indexOf("private getStateMigration("),
  );
  const transaction = persistence.indexOf("const result = await this.mutatePersistentWatchState");
  const clearId = persistence.indexOf("this.pendingQuarantineIds.delete(id)");
  const clearPath = persistence.indexOf("this.pendingQuarantinePaths.delete(path)");
  assert.ok(transaction >= 0 && clearId > transaction && clearPath > transaction);
  assert.match(persistence, /const pathMoves = this\.pendingPathStateMoves\.slice\(\)/);
  assert.match(persistence, /this\.pendingPathStateMoves = this\.pendingPathStateMoves\.filter/);
  assert.match(source, /persistPendingIdentitySafetyState\("safety-barrier-retry"\)/);
});

test("Watchlist contains async UI failures and discloses the daily-note dependency", () => {
  const source = readFileSync("src/main.ts", "utf8");
  const viewSource = readFileSync("src/view.ts", "utf8");
  const settingsSource = readFileSync("src/settings-tab.ts", "utf8");
  assert.match(source, /async runUserAction\(/);
  assert.match(source, /logger\.failure\("UI", "action:failed"/);
  assert.match(source, /command-check-active/);
  assert.match(source, /command-toggle-active/);
  assert.match(viewSource, /plugin\.runUserAction\(/);
  assert.match(viewSource, /\.finally\(\(\) => \{\s*button\.disabled = false/);
  assert.match(settingsSource, /require TPS Global Context Menu's daily-notes capability/);
});

test("Watchlist wires notification recovery and attempt accounting into both event paths", () => {
  const source = readFileSync("src/main.ts", "utf8");
  const viewSource = readFileSync("src/view.ts", "utf8");
  const onload = source.slice(source.indexOf("async onload()"), source.indexOf("onunload(): void"));
  assert.ok(onload.indexOf("await this.loadPluginData(lifecycleEpoch)") < onload.indexOf("this.startScheduler()"));
  assert.match(onload, /const lifecycleEpoch = \+\+this\.lifecycleEpoch/);
  assert.ok(onload.indexOf("await this.saveSerial") < onload.indexOf("await this.loadPluginData(lifecycleEpoch)"));
  assert.match(onload, /!this\.isCurrentLifecycle\(lifecycleEpoch\)\) return/);
  assert.ok(onload.indexOf("new TPSNotifierClient") < onload.indexOf("this.startScheduler()"));

  const atomicCommit = source.slice(
    source.indexOf("private async commitWatchStateAndPrepareNotification("),
    source.indexOf("private async settleNotificationAttemptDurably("),
  );
  assert.ok(
    atomicCommit.indexOf("this.applyWatchStateCommitToModel(")
      < atomicCommit.indexOf("prepareNotificationDelivery(draft.notificationDeliveries, input)"),
  );
  assert.match(atomicCommit, /draft\.notificationLedgerBlockedReason\s*\? blockedNotificationPlan\(input\)/);

  const normalFlow = source.slice(
    source.indexOf("const nextState: WatchState ="),
    source.indexOf("logger.flow(\"Check\", \"watch:done\""),
  );
  assert.match(normalFlow, /executeNotificationDelivery<WatchCheckResult>/);
  assert.match(normalFlow, /kind: "watch-event", eventAppended: appended/);

  const failureFlow = source.slice(
    source.indexOf("private async handleFailure("),
    source.indexOf("private async appendWatchEvent("),
  );
  assert.match(failureFlow, /executeNotificationDelivery<WatchCheckResult>/);
  assert.match(failureFlow, /kind: "failure-alert", eventAppended: failureEventAppended/);
  assert.match(failureFlow, /isDeliveredNotificationState\(notification\.state\)[\s\S]*markFailureNotificationAccepted/);
  assert.match(failureFlow, /postNotificationStateOwnershipFailure/);
  const escalationWrite = failureFlow.slice(
    failureFlow.indexOf("try {"),
    failureFlow.indexOf("const preFailureStateOwnership"),
  );
  assert.doesNotMatch(escalationWrite, /deliverNotification/);

  const persistence = source.slice(
    source.indexOf("private persistentDataPayload("),
    source.indexOf("private enqueueDataOperation"),
  );
  assert.match(persistence, /notificationLedgerPersistenceFields\(/);

  const unload = source.slice(source.indexOf("onunload(): void"), source.indexOf("async saveSettings()"));
  assert.ok(unload.indexOf("this.unloading = true") < unload.indexOf("this.notifierClient?.dispose()"));
  assert.match(unload, /this\.lifecycleEpoch \+= 1/);
  const settingsSave = source.slice(source.indexOf("async saveSettings()"), source.indexOf("openCreateModal(): void"));
  assert.ok(
    settingsSave.indexOf("await this.persistData(lifecycleEpoch)")
      < settingsSave.indexOf("this.startScheduler()"),
  );
  assert.match(settingsSave, /if \(!this\.isCurrentLifecycle\(lifecycleEpoch\)\) throw new WatchDefinitionChangedError\(\)/);
  const settlement = source.slice(
    source.indexOf("private async settleNotificationAttemptDurably("),
    source.indexOf("private async markFailureNotificationAccepted("),
  );
  assert.match(settlement, /this\.mutatePersistentWatchState/);
  const queuedMutation = source.slice(
    source.indexOf("private async mutatePersistentWatchState"),
    source.indexOf("private async persistData("),
  );
  assert.ok(
    queuedMutation.indexOf("if (!this.isCurrentLifecycle(lifecycleEpoch)) throw new WatchDefinitionChangedError()")
      < queuedMutation.indexOf("await this.saveData(this.persistentDataPayload(draft))"),
    "late settlements must hit the unload fence before saveData",
  );
  assert.ok(
    queuedMutation.lastIndexOf("if (!this.isCurrentLifecycle(lifecycleEpoch)) throw new WatchDefinitionChangedError()")
      > queuedMutation.indexOf("await this.saveData(this.persistentDataPayload(draft))"),
    "an active old settlement must not install its draft after saveData",
  );
  const settingsPersistence = source.slice(
    source.indexOf("private async persistData("),
    source.indexOf("}\n\nfunction inferProvider"),
  );
  assert.ok(
    settingsPersistence.indexOf("if (!this.isCurrentLifecycle(lifecycleEpoch))")
      < settingsPersistence.indexOf("await this.saveData(this.persistentDataPayload(snapshot))"),
    "queued settings persistence must hit the lifecycle fence before saveData",
  );
  assert.match(source, /private startScheduler\(\): void \{\s*this\.stopScheduler\(\);\s*if \(this\.unloading\) return/);
  assert.match(viewSource, /"legacy-accepted": "Accepted \(legacy\)"/);
  assert.match(viewSource, /deliveryAttention[\s\S]*!isDeliveredNotificationState\(row\.latestNotification\.state\)/);
  assert.match(viewSource, /cls: isDeliveredNotificationState\(row\.latestNotification\.state\) \? "" : "tps-watch-error"/);
});
