import test from "node:test";
import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  appendLineOnce,
  createFeedSourceIdentity,
  createEmptyState,
  evaluateObservation,
  extractPattern,
  joinSingleFlight,
  observationFingerprint,
  parseNumericValue,
  resolveJsonPath,
  sanitizeWatchErrorMessage,
  stableHash,
  WATCH_FINGERPRINT_VERSION,
} from "../src/core";
import type { WatchDefinition, WatchObservation } from "../src/types";

const definition = (overrides: Partial<WatchDefinition> = {}): WatchDefinition => ({
  id: "watch-1",
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

test("Watchlist integrates single-flight checks and atomic vault processing", () => {
  const source = readFileSync("src/main.ts", "utf8");
  assert.match(source, /joinSingleFlight\(\s*this\.checksInFlight,\s*path,/);
  assert.match(source, /await this\.app\.vault\.process\(target,/);
  assert.doesNotMatch(source, /cachedRead\(target\)/);
});

test("Watchlist isolates failed checks and secondary failure bookkeeping", () => {
  const source = readFileSync("src/main.ts", "utf8");
  assert.match(source, /try \{\s*results\.push\(await this\.checkOne\(definition, reason\)\);\s*\} catch \(error\)/);
  assert.match(source, /"watch:unhandled-rejection"/);
  assert.match(source, /let definition = inputDefinition;\s*try \{\s*definition = await this\.ensureWatchIdentity/);
  assert.match(source, /"failure-escalation:failed"/);
  assert.match(source, /failureCount: failureEscalationFailed \? previous\.failureCount : failureCount/);
  assert.match(source, /"failure-state:persist-failed"/);
  assert.match(source, /"failure-state:view-refresh-failed"/);
  assert.match(source, /stateMigrated/);
});
