import test from "node:test";
import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { TFile } from "obsidian";
import {
  appendLineOnce,
  createFeedSourceIdentity,
  createEmptyState,
  evaluateObservation,
  extractPattern,
  joinSingleFlight,
  observationFingerprint,
  parseNumericValue,
  sanitizeWatchErrorMessage,
  stableHash,
  WATCH_FINGERPRINT_VERSION,
} from "../src/core";
import TPSWatchlistPlugin from "../src/main";
import { WatchlistPersistenceCoordinator } from "../src/persistence";
import { resolveJsonPath } from "../src/providers";
import { WATCHLIST_VIEW_TYPE, WatchlistView } from "../src/view";
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

const flushAsyncWork = async (): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

test("watch rows preserve file order and parse each Markdown file once", () => {
  const files = [
    { path: "Watches/First.md" },
    { path: "Notes/Not a watch.md" },
    { path: "Watches/Second.md" },
  ];
  const first = definition({ id: "first", path: files[0].path, status: "working" });
  const second = definition({ id: "second", path: files[2].path, status: "holding" });
  const definitionsByPath = new Map<string, WatchDefinition>([
    [first.path, first],
    [second.path, second],
  ]);
  const calls: string[] = [];
  const firstState = { ...createEmptyState(), lastValue: "existing" };
  const plugin = Object.create(TPSWatchlistPlugin.prototype) as any;
  plugin.app = {
    vault: { getMarkdownFiles: () => files },
  };
  plugin.states = { first: firstState };
  plugin.definitionFromFile = (file: { path: string }) => {
    calls.push(file.path);
    return definitionsByPath.get(file.path) || null;
  };

  const rows = plugin.getWatchRows();

  assert.deepEqual(calls, files.map((file) => file.path));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].definition, first);
  assert.equal(rows[0].state, firstState);
  assert.equal(rows[0].active, true);
  assert.equal(rows[1].definition, second);
  assert.deepEqual(rows[1].state, createEmptyState());
  assert.equal(rows[1].active, false);
});

test("scheduled checks preserve active, due, valid watch selection and order", async () => {
  const dueFirst = definition({ id: "due-first", path: "Watches/Due first.md" });
  const invalid = definition({ id: "invalid", path: "Watches/Invalid.md", url: "" });
  const dueSecond = definition({ id: "due-second", path: "Watches/Due second.md" });
  const rows = [
    { definition: definition({ id: "inactive" }), state: createEmptyState(), active: false },
    {
      definition: definition({ id: "not-due" }),
      state: { ...createEmptyState(), lastCheckedAt: "2999-01-01T00:00:00.000Z" },
      active: true,
    },
    { definition: dueFirst, state: createEmptyState(), active: true },
    { definition: invalid, state: createEmptyState(), active: true },
    { definition: dueSecond, state: createEmptyState(), active: true },
  ];
  const plugin = Object.create(TPSWatchlistPlugin.prototype) as any;
  plugin.settings = { executionMode: "this-device" };
  plugin.getWatchRows = () => rows;
  let selected: WatchDefinition[] | undefined;
  let selectedReason = "";
  let selectedDueOnly = false;
  plugin.checkDefinitions = async (
    definitions: WatchDefinition[],
    reason: string,
    dueOnly: boolean,
  ) => {
    selected = definitions;
    selectedReason = reason;
    selectedDueOnly = dueOnly;
    return [];
  };

  await plugin.runScheduledChecks("regression");

  assert.deepEqual(selected, [dueFirst, dueSecond]);
  assert.equal(selectedReason, "scheduler:regression");
  assert.equal(selectedDueOnly, true);
});

test("dashboard opens render once through the correct new or existing view lifecycle", async () => {
  const files = Array.from({ length: 1_000 }, (_, index) => ({
    path: `Notes/Dashboard ${index}.md`,
  }));

  const createHarness = (existing: boolean) => {
    const plugin = Object.create(TPSWatchlistPlugin.prototype) as any;
    let parsedFiles = 0;
    let renders = 0;
    let reveals = 0;
    let viewStateCalls = 0;
    plugin.states = {};
    plugin.app = {
      vault: { getMarkdownFiles: () => files },
      workspace: {},
    };
    plugin.definitionFromFile = () => {
      parsedFiles += 1;
      return null;
    };
    const view = Object.create(WatchlistView.prototype) as any;
    view.plugin = plugin;
    view.render = async () => {
      renders += 1;
      plugin.getWatchRows();
    };
    const leaf: any = {
      view: existing ? view : {},
      async setViewState(state: { type: string; active: boolean }) {
        viewStateCalls += 1;
        assert.deepEqual(state, { type: WATCHLIST_VIEW_TYPE, active: true });
        leaf.view = view;
        await view.onOpen();
      },
    };
    plugin.app.workspace.getLeavesOfType = (type: string) => {
      assert.equal(type, WATCHLIST_VIEW_TYPE);
      return existing ? [leaf] : [];
    };
    plugin.app.workspace.getLeaf = (kind: string) => {
      assert.equal(kind, "tab");
      return leaf;
    };
    plugin.app.workspace.revealLeaf = (revealedLeaf: unknown) => {
      assert.equal(revealedLeaf, leaf);
      reveals += 1;
    };
    return {
      plugin,
      counts: () => ({ parsedFiles, renders, reveals, viewStateCalls }),
    };
  };

  const firstOpen = createHarness(false);
  await firstOpen.plugin.openDashboard();
  assert.deepEqual(firstOpen.counts(), {
    parsedFiles: 1_000,
    renders: 1,
    reveals: 1,
    viewStateCalls: 1,
  });

  const existingOpen = createHarness(true);
  await existingOpen.plugin.openDashboard();
  assert.deepEqual(existingOpen.counts(), {
    parsedFiles: 1_000,
    renders: 1,
    reveals: 1,
    viewStateCalls: 0,
  });
});

test("dashboard opens preserve view lifecycle and existing-render failures", async () => {
  const newLeafPlugin = Object.create(TPSWatchlistPlugin.prototype) as any;
  let newLeafReveals = 0;
  newLeafPlugin.app = {
    workspace: {
      getLeavesOfType: () => [],
      getLeaf: () => ({
        view: {},
        setViewState: async () => {
          throw new Error("synthetic setViewState failure");
        },
      }),
      revealLeaf: () => {
        newLeafReveals += 1;
      },
    },
  };
  await assert.rejects(() => newLeafPlugin.openDashboard(), /synthetic setViewState failure/);
  assert.equal(newLeafReveals, 0);

  const existingLeafPlugin = Object.create(TPSWatchlistPlugin.prototype) as any;
  let existingLeafReveals = 0;
  const view = Object.create(WatchlistView.prototype) as any;
  view.render = async () => {
    throw new Error("synthetic render failure");
  };
  const leaf = { view };
  existingLeafPlugin.app = {
    workspace: {
      getLeavesOfType: () => [leaf],
      getLeaf: () => {
        throw new Error("existing dashboard must not allocate a leaf");
      },
      revealLeaf: () => {
        existingLeafReveals += 1;
      },
    },
  };
  await assert.rejects(() => existingLeafPlugin.openDashboard(), /synthetic render failure/);
  assert.equal(existingLeafReveals, 1);
});

test("concurrent watch checks consume one structural snapshot by index", async () => {
  const definitions = ["a", "b", "c", "d", "e"].map((id) => definition({
    id,
    path: "Watches/" + id + ".md",
  }));
  const snapshot = definitions.slice();
  const numericReads: number[] = [];
  const guardedSnapshot = new Proxy(snapshot, {
    get(target, property, receiver) {
      if (property === "shift") {
        throw new Error("workers must not shift the definition snapshot");
      }
      if (typeof property === "string" && /^\d+$/.test(property)) {
        numericReads.push(Number(property));
      }
      return Reflect.get(target, property, receiver);
    },
  });
  const guardedInput = new Proxy(definitions, {
    get(target, property, receiver) {
      if (property === "slice") return () => guardedSnapshot;
      return Reflect.get(target, property, receiver);
    },
  });
  const starts: string[] = [];
  const releases = new Map<string, () => void>();
  let persisted = 0;
  let refreshed = 0;
  const plugin = Object.create(TPSWatchlistPlugin.prototype) as any;
  plugin.batchInFlight = false;
  plugin.settings = { maxConcurrentChecks: 2 };
  plugin.checkOne = (item: WatchDefinition) => {
    starts.push(item.id);
    return new Promise((resolve) => {
      releases.set(item.id, () => resolve({
        watchId: item.id,
        path: item.path,
        outcome: "unchanged",
      }));
    });
  };
  plugin.persistStates = async () => { persisted += 1; };
  plugin.refreshViews = async () => { refreshed += 1; };

  const batch = plugin.checkDefinitions(guardedInput, "test", false);
  assert.deepEqual(starts, ["a", "b"]);

  definitions.splice(2);
  releases.get("b")?.();
  await flushAsyncWork();
  assert.deepEqual(starts, ["a", "b", "c"]);
  releases.get("a")?.();
  await flushAsyncWork();
  assert.deepEqual(starts, ["a", "b", "c", "d"]);
  releases.get("d")?.();
  await flushAsyncWork();
  assert.deepEqual(starts, ["a", "b", "c", "d", "e"]);
  releases.get("c")?.();
  releases.get("e")?.();

  const results = await batch;
  assert.deepEqual(results.map((result: { watchId: string }) => result.watchId), ["b", "a", "d", "c", "e"]);
  assert.deepEqual(numericReads, [0, 1, 2, 3, 4]);
  assert.equal(persisted, 1);
  assert.equal(refreshed, 1);
  assert.equal(plugin.batchInFlight, false);
});

test("failed watch batches rebuild open dashboards only once", async () => {
  const definitions = Array.from({ length: 100 }, (_, index) => definition({
    id: "failed-" + index,
    path: "Watches/Failed " + index + ".md",
  }));
  const markdownFiles = Array.from({ length: 1000 }, (_, index) => ({
    path: "Notes/Fixture " + index + ".md",
  }));
  const plugin = Object.create(TPSWatchlistPlugin.prototype) as any;
  let persisted = 0;
  let refreshed = 0;
  let parsedFiles = 0;
  const originalConsoleError = console.error;
  const failureLogs: unknown[][] = [];
  plugin.batchInFlight = false;
  plugin.settings = {
    maxConcurrentChecks: 8,
    failureAlertThreshold: 3,
    notifyOnFailure: false,
  };
  plugin.states = {};
  plugin.persistStates = async () => { persisted += 1; };
  plugin.checkOne = async (item: WatchDefinition) =>
    await plugin.handleFailure(item, new Error("synthetic provider failure"), "test");
  plugin.app = {
    vault: { getMarkdownFiles: () => markdownFiles },
  };
  plugin.definitionFromFile = () => {
    parsedFiles += 1;
    return null;
  };
  plugin.refreshViews = async () => {
    refreshed += 1;
    plugin.getWatchRows();
  };
  console.error = (...args) => failureLogs.push(args);

  let results;
  try {
    results = await plugin.checkDefinitions(definitions, "test", false);
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(results.length, 100);
  assert.ok(results.every((result: { outcome: string }) => result.outcome === "failed"));
  assert.ok(definitions.every((item) => plugin.states[item.id]?.failureCount === 1));
  assert.equal(persisted, 101);
  assert.equal(failureLogs.length, 100);
  assert.equal(refreshed, 1);
  assert.equal(parsedFiles, 1000);
});

test("direct watch checks own one failure-isolated dashboard refresh", async () => {
  const file = Object.assign(new TFile(), {
    path: "Watches/Direct.md",
    extension: "md",
  });
  const watch = definition({ path: file.path });
  const plugin = Object.create(TPSWatchlistPlugin.prototype) as any;
  let refreshed = 0;
  plugin.app = {
    vault: { getAbstractFileByPath: () => file },
  };
  plugin.definitionFromFile = () => watch;
  plugin.refreshViews = async () => { refreshed += 1; };

  plugin.checkOne = async () => ({
    watchId: watch.id,
    path: watch.path,
    outcome: "unchanged",
  });
  assert.equal((await plugin.checkPath(file.path, "test-success")).outcome, "unchanged");

  plugin.checkOne = async () => ({
    watchId: watch.id,
    path: watch.path,
    outcome: "failed",
    error: "synthetic failure",
  });
  assert.equal((await plugin.checkPath(file.path, "test-failure")).outcome, "failed");
  assert.equal(refreshed, 2);

  const originalConsoleError = console.error;
  const failureLogs: unknown[][] = [];
  console.error = (...args) => failureLogs.push(args);
  plugin.refreshViews = async () => { throw new Error("synthetic refresh failure"); };
  try {
    assert.equal((await plugin.checkPath(file.path, "test-refresh-failure")).outcome, "failed");
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(failureLogs.length, 1);
  assert.match(String(failureLogs[0]?.[0]), /path:view-refresh-failed/);
});

test("live JSON provider resolver preserves supported paths and exact failures", () => {
  const input = {
    quote: {
      data: [
        { price: 42.5, details: { "display name": "Primary" } },
      ],
    },
  };

  assert.equal(resolveJsonPath(input, ""), input);
  assert.equal(resolveJsonPath(input, "$"), input);
  assert.equal(resolveJsonPath(input, "$.quote.data[0].price"), 42.5);
  assert.equal(resolveJsonPath(input, "quote..data[0]['details'][\"display name\"]"), "Primary");
  assert.equal(resolveJsonPath({ zero: 0, no: false, empty: "", nil: null }, "zero"), 0);
  assert.equal(resolveJsonPath({ zero: 0, no: false, empty: "", nil: null }, "no"), false);
  assert.equal(resolveJsonPath({ zero: 0, no: false, empty: "", nil: null }, "empty"), "");
  assert.equal(resolveJsonPath({ zero: 0, no: false, empty: "", nil: null }, "nil"), null);
  assert.throws(
    () => resolveJsonPath(input, "$.quote.missing"),
    { message: "JSON path key was not found: missing" },
  );
  assert.throws(
    () => resolveJsonPath(input, "quote[data]"),
    { message: "JSON path key was not found: quote[data]" },
  );
  assert.throws(
    () => resolveJsonPath(input, "$.quote.data[0].price.value"),
    { message: "JSON path stopped before value." },
  );
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

test("state-only persistence reloads and preserves synchronized settings and unknown data", async () => {
  let disk: Record<string, unknown> = {
    settings: { settingA: "loaded", settingB: "loaded", futureSetting: { enabled: true } },
    states: { diskWatch: { lastValue: "old" } },
    futureTopLevel: { version: 2 },
  };
  let writes = 0;
  const persistence = new WatchlistPersistenceCoordinator(
    async () => structuredClone(disk),
    async (data) => {
      writes += 1;
      disk = structuredClone(data);
    },
  );
  persistence.setSettingsBaseline({ settingA: "loaded", settingB: "loaded" });

  // Simulate another synchronized device changing setting A after plugin load.
  disk = {
    ...disk,
    settings: { settingA: "synchronized", settingB: "synchronized", futureSetting: { enabled: true } },
  };
  await persistence.saveStates({ localWatch: { lastValue: "new" } });
  assert.deepEqual(disk, {
    settings: { settingA: "synchronized", settingB: "synchronized", futureSetting: { enabled: true } },
    states: { localWatch: { lastValue: "new" } },
    futureTopLevel: { version: 2 },
  });

  // A settings write owns settings, but not newer state or unknown top-level data.
  disk = {
    ...disk,
    states: { synchronizedWatch: { lastValue: "newest" } },
    anotherFutureField: ["keep"],
  };
  await persistence.saveSettings({ settingA: "local-save", settingB: "loaded" });
  assert.deepEqual(disk, {
    settings: { settingA: "local-save", settingB: "synchronized", futureSetting: { enabled: true } },
    states: { synchronizedWatch: { lastValue: "newest" } },
    futureTopLevel: { version: 2 },
    anotherFutureField: ["keep"],
  });
  assert.equal(writes, 2);
});

test("overlapping Watchlist state saves persist the active and newest snapshots only", async () => {
  let disk: Record<string, unknown> = {
    settings: { executionMode: "controller", futureSetting: { enabled: true } },
    states: {},
    futureTopLevel: { version: 2 },
  };
  let reads = 0;
  let writes = 0;
  let activeWrites = 0;
  let maxActiveWrites = 0;
  let markFirstStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
  let releaseFirstWrite!: () => void;
  const firstWriteGate = new Promise<void>((resolve) => { releaseFirstWrite = resolve; });
  const persistence = new WatchlistPersistenceCoordinator(
    async () => {
      reads += 1;
      return structuredClone(disk);
    },
    async (data) => {
      writes += 1;
      activeWrites += 1;
      maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
      try {
        if (writes === 1) {
          markFirstStarted();
          await firstWriteGate;
        }
        disk = structuredClone(data);
      } finally {
        activeWrites -= 1;
      }
    },
  );
  persistence.setSettingsBaseline({ executionMode: "controller" });

  const newestStates: Record<string, { lastValue: string }> = {
    "watch-0": { lastValue: "value-0" },
  };
  const saves = [persistence.saveStates(newestStates)];
  await firstStarted;
  for (let index = 1; index < 100; index += 1) {
    newestStates[`watch-${index}`] = { lastValue: `value-${index}` };
    saves.push(persistence.saveStates(newestStates));
  }
  releaseFirstWrite();
  const results = await Promise.all(saves);

  assert.equal(reads, 2);
  assert.equal(writes, 2);
  assert.equal(maxActiveWrites, 1);
  assert.equal(results.length, 100);
  assert.deepEqual(disk, {
    settings: { executionMode: "controller", futureSetting: { enabled: true } },
    states: newestStates,
    futureTopLevel: { version: 2 },
  });
  assert.deepEqual(results[0]?.states, { "watch-0": { lastValue: "value-0" } });
  for (const result of results.slice(1)) assert.deepEqual(result.states, newestStates);
});

test("a failed active Watchlist state write does not strand the newest queued snapshot", async () => {
  let disk: Record<string, unknown> = {
    settings: { executionMode: "controller" },
    states: {},
    futureTopLevel: ["keep"],
  };
  let reads = 0;
  let attempts = 0;
  let markFirstStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
  let releaseFailure!: () => void;
  const failureGate = new Promise<void>((resolve) => { releaseFailure = resolve; });
  const persistence = new WatchlistPersistenceCoordinator(
    async () => {
      reads += 1;
      return structuredClone(disk);
    },
    async (data) => {
      attempts += 1;
      if (attempts === 1) {
        markFirstStarted();
        await failureGate;
        throw new Error("first state write failed");
      }
      disk = structuredClone(data);
    },
  );
  persistence.setSettingsBaseline({ executionMode: "controller" });

  const failed = persistence.saveStates({ "watch-0": { lastValue: "first" } });
  const failureObserved = assert.rejects(failed, /first state write failed/);
  await firstStarted;
  const newestStates: Record<string, { lastValue: string }> = {};
  const queued: Array<Promise<Record<string, unknown>>> = [];
  for (let index = 1; index <= 20; index += 1) {
    newestStates[`watch-${index}`] = { lastValue: `value-${index}` };
    queued.push(persistence.saveStates(newestStates));
  }
  releaseFailure();
  await failureObserved;
  await Promise.all(queued);

  assert.equal(reads, 2);
  assert.equal(attempts, 2);
  assert.deepEqual(disk, {
    settings: { executionMode: "controller" },
    states: newestStates,
    futureTopLevel: ["keep"],
  });
});

test("a failed coalesced Watchlist state attempt preserves every later caller", async () => {
  let disk: Record<string, unknown> = {
    settings: { executionMode: "controller" },
    states: {},
    futureTopLevel: { keep: true },
  };
  let reads = 0;
  let attempts = 0;
  let markFirstStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
  let releaseFirstWrite!: () => void;
  const firstWriteGate = new Promise<void>((resolve) => { releaseFirstWrite = resolve; });
  const persistence = new WatchlistPersistenceCoordinator(
    async () => {
      reads += 1;
      return structuredClone(disk);
    },
    async (data) => {
      attempts += 1;
      if (attempts === 1) {
        markFirstStarted();
        await firstWriteGate;
      } else if (attempts === 2) {
        throw new Error("coalesced state write failed");
      }
      disk = structuredClone(data);
    },
  );
  persistence.setSettingsBaseline({ executionMode: "controller" });

  const active = persistence.saveStates({ active: { lastValue: "first" } });
  await firstStarted;
  const newestStates: Record<string, { lastValue: string }> = {};
  const queued: Array<Promise<Record<string, unknown>>> = [];
  for (let index = 0; index < 20; index += 1) {
    newestStates[`watch-${index}`] = { lastValue: `value-${index}` };
    queued.push(persistence.saveStates(newestStates));
  }
  releaseFirstWrite();
  await active;
  const settled = await Promise.allSettled(queued);

  assert.equal(reads, 3);
  assert.equal(attempts, 3);
  assert.equal(settled[0]?.status, "rejected");
  assert.match(String((settled[0] as PromiseRejectedResult).reason), /coalesced state write failed/);
  assert.ok(settled.slice(1).every((result) => result.status === "fulfilled"));
  assert.deepEqual(disk, {
    settings: { executionMode: "controller" },
    states: newestStates,
    futureTopLevel: { keep: true },
  });
});

test("Watchlist state coalescing preserves an interleaved settings-write boundary", async () => {
  let disk: Record<string, unknown> = {
    settings: { settingA: "old", settingB: "synchronized", futureSetting: true },
    states: {},
    futureTopLevel: { keep: true },
  };
  let reads = 0;
  let writes = 0;
  const writeHistory: Array<Record<string, unknown>> = [];
  let markFirstStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
  let releaseFirstWrite!: () => void;
  const firstWriteGate = new Promise<void>((resolve) => { releaseFirstWrite = resolve; });
  const persistence = new WatchlistPersistenceCoordinator(
    async () => {
      reads += 1;
      return structuredClone(disk);
    },
    async (data) => {
      writes += 1;
      if (writes === 1) {
        markFirstStarted();
        await firstWriteGate;
      }
      disk = structuredClone(data);
      writeHistory.push(structuredClone(data));
    },
  );
  persistence.setSettingsBaseline({ settingA: "old", settingB: "old" });

  const first = persistence.saveStates({ active: { lastValue: "first" } });
  await firstStarted;
  const beforeSettingsStates: Record<string, { lastValue: string }> = {};
  const beforeSettings: Array<Promise<Record<string, unknown>>> = [];
  for (let index = 0; index < 10; index += 1) {
    beforeSettingsStates[`before-${index}`] = { lastValue: `value-${index}` };
    beforeSettings.push(persistence.saveStates(beforeSettingsStates));
  }
  const settings = persistence.saveSettings({ settingA: "local", settingB: "old" });
  const newestStates: Record<string, { lastValue: string }> = {};
  const afterSettings: Array<Promise<Record<string, unknown>>> = [];
  for (let index = 0; index < 10; index += 1) {
    newestStates[`after-${index}`] = { lastValue: `value-${index}` };
    afterSettings.push(persistence.saveStates(newestStates));
  }
  releaseFirstWrite();
  await Promise.all([first, ...beforeSettings, settings, ...afterSettings]);

  assert.equal(reads, 4);
  assert.equal(writes, 4);
  assert.deepEqual(disk, {
    settings: { settingA: "local", settingB: "synchronized", futureSetting: true },
    states: newestStates,
    futureTopLevel: { keep: true },
  });
  assert.deepEqual(writeHistory, [
    {
      settings: { settingA: "old", settingB: "synchronized", futureSetting: true },
      states: { active: { lastValue: "first" } },
      futureTopLevel: { keep: true },
    },
    {
      settings: { settingA: "old", settingB: "synchronized", futureSetting: true },
      states: beforeSettingsStates,
      futureTopLevel: { keep: true },
    },
    {
      settings: { settingA: "local", settingB: "synchronized", futureSetting: true },
      states: beforeSettingsStates,
      futureTopLevel: { keep: true },
    },
    {
      settings: { settingA: "local", settingB: "synchronized", futureSetting: true },
      states: newestStates,
      futureTopLevel: { keep: true },
    },
  ]);
});

test("overlapping Watchlist settings writes retain an in-flight revert", async () => {
  let disk: Record<string, unknown> = { settings: { settingA: "old", futureSetting: true }, states: {} };
  let releaseFirstWrite!: () => void;
  const firstWriteGate = new Promise<void>((resolve) => { releaseFirstWrite = resolve; });
  let markFirstStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
  let writeCount = 0;
  const persistence = new WatchlistPersistenceCoordinator(
    async () => structuredClone(disk),
    async (data) => {
      writeCount += 1;
      if (writeCount === 1) {
        markFirstStarted();
        await firstWriteGate;
      }
      disk = structuredClone(data);
    },
  );
  persistence.setSettingsBaseline({ settingA: "old" });

  const first = persistence.saveSettings({ settingA: "new" });
  await firstStarted;
  const reverted = persistence.saveSettings({ settingA: "old" });
  releaseFirstWrite();
  await Promise.all([first, reverted]);

  assert.equal(writeCount, 2);
  assert.deepEqual(disk, { settings: { settingA: "old", futureSetting: true }, states: {} });
});

test("a failed Watchlist write does not strand a queued newer setting", async () => {
  let disk: Record<string, unknown> = { settings: { settingA: "old" }, states: {} };
  let releaseFailure!: () => void;
  const failureGate = new Promise<void>((resolve) => { releaseFailure = resolve; });
  let markFirstStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
  let attempts = 0;
  const persistence = new WatchlistPersistenceCoordinator(
    async () => structuredClone(disk),
    async (data) => {
      attempts += 1;
      if (attempts === 1) {
        markFirstStarted();
        await failureGate;
        throw new Error("first write failed");
      }
      disk = structuredClone(data);
    },
  );
  persistence.setSettingsBaseline({ settingA: "old" });

  const failed = persistence.saveSettings({ settingA: "first" });
  await firstStarted;
  const newest = persistence.saveSettings({ settingA: "newest" });
  releaseFailure();
  await assert.rejects(failed, /first write failed/);
  await newest;

  assert.equal(attempts, 2);
  assert.deepEqual(disk, { settings: { settingA: "newest" }, states: {} });
});

test("persistence fails closed when current plugin data cannot be loaded", async () => {
  let writes = 0;
  const persistence = new WatchlistPersistenceCoordinator(
    async () => { throw new Error("load failed"); },
    async () => { writes += 1; },
  );
  await assert.rejects(() => persistence.saveStates({ localWatch: {} }), /load failed/);
  await assert.rejects(() => persistence.saveSettings({ settingA: "local" }), /load failed/);
  assert.equal(writes, 0);
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
  const viewSource = readFileSync("src/view.ts", "utf8");
  assert.match(source, /try \{\s*results\.push\(await this\.checkOne\(definition, reason\)\);\s*\} catch \(error\)/);
  assert.match(source, /"watch:unhandled-rejection"/);
  assert.match(source, /let definition = inputDefinition;\s*try \{\s*definition = await this\.ensureWatchIdentity/);
  assert.match(source, /"failure-escalation:failed"/);
  assert.match(source, /failureCount: failureEscalationFailed \? previous\.failureCount : failureCount/);
  assert.match(source, /"failure-state:persist-failed"/);
  assert.doesNotMatch(source, /"failure-state:view-refresh-failed"/);
  assert.match(source, /"path:view-refresh-failed"/);
  assert.equal(viewSource.match(/await this\.render\(\);/g)?.length, 1);
  assert.match(source, /stateMigrated/);
});

test("Watchlist routes settings and runtime-state persistence through separate merge paths", () => {
  const source = readFileSync("src/main.ts", "utf8");
  assert.match(source, /persistence\.saveSettings\(this\.settings\)/);
  assert.match(source, /persistence\.saveStates\(this\.states\)/);
  assert.doesNotMatch(source, /saveData\(\{ settings: this\.settings, states: this\.states \}\)/);
});
