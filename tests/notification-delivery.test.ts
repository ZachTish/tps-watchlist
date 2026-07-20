import test from "node:test";
import * as assert from "node:assert/strict";
import {
  blockedNotificationPlan,
  createNotificationRecordMap,
  executeNotificationDelivery,
  isDeliveredNotificationState,
  latestNotificationForWatch,
  loadNotificationLedger,
  notificationLedgerPersistenceFields,
  notificationSettlementFromResult,
  notificationSummary,
  prepareNotificationDelivery,
  pruneNotificationRecords,
  settleNotificationAttempt,
  WATCH_NOTIFICATION_LEDGER_VERSION,
  type NotificationDeliveryPlan,
  type NotificationSettlement,
} from "../src/notification-ledger";
import { TPSNotifierClient } from "../src/tps-notifier-client";
import {
  TPS_NOTIFIER_SERVICE_EVENTS,
  type TPSNotifierApi,
  type TPSNotifierConsumerDeliveryResult,
  type TPSNotifierServiceDescriptor,
  type TPSNotifierServiceRequest,
} from "../src/tps-notifier-contract";
import type { WatchNotificationRecord, WatchNotificationSummary } from "../src/types";

const NOW = "2026-07-19T12:00:00.000Z";
const LATER = "2026-07-19T12:01:00.000Z";

test("notification records use a null-prototype map and safely accept reserved event IDs", () => {
  const records = createNotificationRecordMap();
  const plan = prepareNotificationDelivery(records, {
    eventId: "__proto__",
    watchId: "constructor",
    kind: "watch-event",
    eventAppended: true,
    attemptId: "attempt-1",
    now: NOW,
  });
  assert.equal(Object.getPrototypeOf(records), null);
  assert.equal(plan.shouldSend, true);
  assert.equal(records.__proto__.eventId, "__proto__");
  assert.deepEqual(Object.keys(records), ["__proto__"]);
});

test("legacy data creates an empty ledger without inferring or replaying historical events", () => {
  const loaded = loadNotificationLedger({
    states: { "watch-1": { lastEventId: "historical-event" } },
  }, NOW);
  assert.equal(loaded.blocked, false);
  assert.equal(loaded.recoveredAttemptCount, 0);
  assert.equal(loaded.prunedRecordCount, 0);
  assert.deepEqual(Object.keys(loaded.records), []);
});

test("future and malformed ledgers fail closed while retaining the exact raw values", () => {
  const futureRecords = { event: { arbitrary: true } };
  const future = loadNotificationLedger({
    notificationLedgerVersion: WATCH_NOTIFICATION_LEDGER_VERSION + 1,
    notificationDeliveries: futureRecords,
  }, NOW);
  assert.equal(future.blocked, true);
  assert.equal(future.rawVersion, WATCH_NOTIFICATION_LEDGER_VERSION + 1);
  assert.equal(future.rawDeliveries, futureRecords);

  const malformedRecords = { event: { eventId: "different" } };
  const malformed = loadNotificationLedger({
    notificationLedgerVersion: WATCH_NOTIFICATION_LEDGER_VERSION,
    notificationDeliveries: malformedRecords,
  }, NOW);
  assert.equal(malformed.blocked, true);
  assert.equal(malformed.rawDeliveries, malformedRecords);
  assert.deepEqual(Object.keys(malformed.records), []);
  const roundTrip = notificationLedgerPersistenceFields(
    true,
    malformed.records,
    malformed.rawVersion,
    malformed.rawDeliveries,
  );
  assert.equal(roundTrip.notificationLedgerVersion, WATCH_NOTIFICATION_LEDGER_VERSION);
  assert.equal(roundTrip.notificationDeliveries, malformedRecords);
});

test("startup converts durable attempting records to indeterminate unknown before scheduling", () => {
  const records = createNotificationRecordMap();
  prepareNotificationDelivery(records, {
    eventId: "event-1",
    watchId: "watch-1",
    kind: "watch-event",
    eventAppended: true,
    attemptId: "attempt-1",
    now: NOW,
  });
  const loaded = loadNotificationLedger({
    notificationLedgerVersion: WATCH_NOTIFICATION_LEDGER_VERSION,
    notificationDeliveries: records,
  }, LATER);
  assert.equal(loaded.blocked, false);
  assert.equal(loaded.recoveredAttemptCount, 1);
  assert.deepEqual(notificationSummary(loaded.records["event-1"]), {
    eventId: "event-1",
    kind: "watch-event",
    state: "unknown",
    transport: "unknown",
    evidence: "interrupted",
    attempted: "unknown",
    updatedAt: LATER,
  });
});

test("an existing event marker with no ledger entry is recorded unknown and never sent", () => {
  const records = createNotificationRecordMap();
  const plan = prepareNotificationDelivery(records, {
    eventId: "already-in-markdown",
    watchId: "watch-1",
    kind: "failure-alert",
    eventAppended: false,
    attemptId: "reconcile-1",
    now: NOW,
  });
  assert.equal(plan.shouldSend, false);
  assert.equal(plan.record.state, "unknown");
  assert.equal(plan.record.transport, "unknown");
  assert.equal(plan.record.evidence, "deduped-without-ledger");
  assert.equal(plan.record.attempted, "unknown");
});

test("terminal settlement preserves exact legacy acceptance and compare-and-sets by attempt ID", () => {
  const records = createNotificationRecordMap();
  prepareNotificationDelivery(records, {
    eventId: "event-1",
    watchId: "watch-1",
    kind: "watch-event",
    eventAppended: true,
    attemptId: "attempt-current",
    now: NOW,
  });
  const legacy = notificationSettlementFromResult({
    state: "legacy-accepted",
    transport: "notifier-v1",
    evidence: "legacy-promise-resolved",
    attempted: true,
  });
  const stale = settleNotificationAttempt(records, "event-1", "attempt-stale", legacy, LATER);
  assert.equal(stale.changed, false);
  assert.equal(records["event-1"].state, "attempting");
  const current = settleNotificationAttempt(records, "event-1", "attempt-current", legacy, LATER);
  assert.equal(current.changed, true);
  assert.equal(records["event-1"].state, "legacy-accepted");
  assert.equal(records["event-1"].transport, "notifier-v1");
  assert.equal(isDeliveredNotificationState(records["event-1"].state), true);
  assert.equal(latestNotificationForWatch(records, "watch-1")?.state, "legacy-accepted");
  const lateReject = settleNotificationAttempt(records, "event-1", "attempt-current", {
    state: "rejected",
    transport: "notifier-v2",
    evidence: "structured-rejection",
    attempted: true,
  }, "2026-07-19T12:02:00.000Z");
  assert.equal(lateReject.changed, false);
  assert.equal(records["event-1"].state, "legacy-accepted");
  const reloaded = loadNotificationLedger({
    notificationLedgerVersion: WATCH_NOTIFICATION_LEDGER_VERSION,
    notificationDeliveries: records,
  }, "2026-07-19T12:03:00.000Z");
  assert.equal(reloaded.blocked, false);
  assert.equal(reloaded.records["event-1"].state, "legacy-accepted");
  assert.equal(isDeliveredNotificationState(reloaded.records["event-1"].state), true);
});

test("ledger validation rejects contradictory provenance and accepts bounded consumer timeouts", () => {
  const contradictory = [
    record({ eventId: "bad-transport", transport: "unknown" }),
    record({
      eventId: "bad-evidence",
      evidence: "legacy-promise-resolved",
      httpStatus: undefined,
      providerMessageId: undefined,
    }),
    record({
      eventId: "bad-legacy-state",
      state: "legacy-accepted",
      transport: "notifier-v1",
      evidence: "structured-receipt",
    }),
    record({ eventId: "bad-attempted", attempted: "unknown" }),
    record({ eventId: "bad-details", providerMessageId: undefined }),
    record({
      eventId: "bad-timeout-route",
      state: "unknown",
      transport: "unavailable",
      evidence: "consumer-timeout",
      attempted: "unknown",
      httpStatus: undefined,
      providerMessageId: undefined,
    }),
  ];
  for (const invalid of contradictory) {
    const loaded = loadNotificationLedger({
      notificationLedgerVersion: WATCH_NOTIFICATION_LEDGER_VERSION,
      notificationDeliveries: { [invalid.eventId]: invalid },
    }, LATER);
    assert.equal(loaded.blocked, true, invalid.eventId);
  }

  for (const transport of ["notifier-v1", "notifier-v2"] as const) {
    const eventId = "timeout-" + transport;
    const timeout = record({
      eventId,
      state: "unknown",
      transport,
      evidence: "consumer-timeout",
      attempted: "unknown",
      httpStatus: undefined,
      providerMessageId: undefined,
    });
    const loaded = loadNotificationLedger({
      notificationLedgerVersion: WATCH_NOTIFICATION_LEDGER_VERSION,
      notificationDeliveries: { [eventId]: timeout },
    }, LATER);
    assert.equal(loaded.blocked, false, transport);
    assert.equal(loaded.records[eventId].state, "unknown");
    assert.equal(loaded.records[eventId].attempted, "unknown");
  }
});

test("bounded pruning removes oldest terminal records deterministically and never active attempts", () => {
  const records = createNotificationRecordMap();
  records.active = record({
    eventId: "active",
    state: "attempting",
    evidence: "attempt-started",
    attempted: "unknown",
    createdAt: "2026-07-19T10:00:00.000Z",
    updatedAt: "2026-07-19T10:00:00.000Z",
  });
  records.b = record({
    eventId: "b",
    createdAt: "2026-07-19T10:01:00.000Z",
    updatedAt: "2026-07-19T10:01:00.000Z",
  });
  records.a = record({
    eventId: "a",
    createdAt: "2026-07-19T10:01:00.000Z",
    updatedAt: "2026-07-19T10:01:00.000Z",
  });
  records.newest = record({
    eventId: "newest",
    createdAt: "2026-07-19T10:02:00.000Z",
    updatedAt: "2026-07-19T10:02:00.000Z",
  });
  assert.deepEqual(pruneNotificationRecords(records, 2), ["a", "b"]);
  assert.deepEqual(Object.keys(records).sort(), ["active", "newest"]);

  const oversized = createNotificationRecordMap();
  for (let index = 0; index <= 1000; index += 1) {
    const eventId = "event-" + String(index).padStart(4, "0");
    oversized[eventId] = record({ eventId, attemptId: "attempt-" + index });
  }
  const loaded = loadNotificationLedger({
    notificationLedgerVersion: WATCH_NOTIFICATION_LEDGER_VERSION,
    notificationDeliveries: oversized,
  }, LATER);
  assert.equal(loaded.prunedRecordCount, 1);
  assert.equal(Object.keys(loaded.records).length, 1000);
  assert.equal(loaded.records["event-0000"], undefined);
});

test("a ledger full of active attempts refuses new I/O instead of exceeding its bound", () => {
  const records = createNotificationRecordMap();
  records.one = record({
    eventId: "one",
    state: "attempting",
    transport: "unknown",
    evidence: "attempt-started",
    attempted: "unknown",
  });
  const plan = prepareNotificationDelivery(records, {
    eventId: "two",
    watchId: "watch-2",
    kind: "watch-event",
    eventAppended: true,
    attemptId: "attempt-2",
    now: NOW,
  }, 1);
  assert.equal(plan.shouldSend, false);
  assert.equal(plan.record.state, "unknown");
  assert.equal(plan.record.evidence, "ledger-capacity");
  assert.deepEqual(Object.keys(records), ["one"]);
});

test("orchestration persists preparation before I/O and settles before late ownership checks", async () => {
  const order: string[] = [];
  const plan = attemptingPlan();
  const result = await executeNotificationDelivery({
    prepare: async () => {
      order.push("persist-attempting");
      return plan;
    },
    revalidateBeforeSend: async () => {
      order.push("ownership-before");
      return null;
    },
    send: async () => {
      order.push("send");
      return acceptedResult();
    },
    settle: async (_attemptId, settlement) => {
      order.push("persist-terminal:" + settlement.state);
      return settledSummary(settlement);
    },
    revalidateAfterSend: async () => {
      order.push("ownership-after");
      return "late-conflict";
    },
  });
  assert.deepEqual(order, [
    "persist-attempting",
    "ownership-before",
    "send",
    "persist-terminal:accepted",
    "ownership-after",
  ]);
  assert.equal(result.conflict, "late-conflict");
  assert.equal(result.conflictBoundary, "after-send");
  assert.equal(result.notification.state, "accepted");
});

test("orchestration does not send after a failed preparation save", async () => {
  let sent = false;
  await assert.rejects(executeNotificationDelivery({
    prepare: async () => {
      throw new Error("save failed");
    },
    revalidateBeforeSend: async () => null,
    send: async () => {
      sent = true;
      return acceptedResult();
    },
    settle: async () => settledSummary(notificationSettlementFromResult(acceptedResult())),
    revalidateAfterSend: async () => null,
  }), /save failed/);
  assert.equal(sent, false);
});

test("orchestration terminalizes a pre-send conflict without transport I/O", async () => {
  let sent = false;
  let settlement: NotificationSettlement | undefined;
  const result = await executeNotificationDelivery({
    prepare: async () => attemptingPlan(),
    revalidateBeforeSend: async () => "conflict",
    send: async () => {
      sent = true;
      return acceptedResult();
    },
    settle: async (_attemptId, value) => {
      settlement = value;
      return settledSummary(value);
    },
    revalidateAfterSend: async () => null,
  });
  assert.equal(sent, false);
  assert.deepEqual(settlement, {
    state: "not-attempted",
    transport: "unknown",
    evidence: "ownership-changed",
    attempted: false,
  });
  assert.equal(result.conflictBoundary, "before-send");
});

test("orchestration contains terminal-save failure and leaves the durable attempt unresolved", async () => {
  const result = await executeNotificationDelivery({
    prepare: async () => attemptingPlan(),
    revalidateBeforeSend: async () => null,
    send: async () => acceptedResult(),
    settle: async () => {
      throw new Error("terminal save failed");
    },
    revalidateAfterSend: async () => null,
  });
  assert.match(String(result.settlementError), /terminal save failed/);
  assert.equal(result.notification.state, "attempting");
  assert.equal(result.notification.attempted, "unknown");
});

test("a classified delivery rejection remains a terminal delivery result instead of throwing", async () => {
  const result = await executeNotificationDelivery({
    prepare: async () => attemptingPlan(),
    revalidateBeforeSend: async () => null,
    send: async () => ({
      state: "rejected",
      transport: "notifier-v2",
      evidence: "structured-rejection",
      attempted: true,
      code: "delivery-rejected",
      httpStatus: 503,
    }),
    settle: async (_attemptId, settlement) => settledSummary(settlement),
    revalidateAfterSend: async () => null,
  });
  assert.equal(result.conflict, null);
  assert.equal(result.settlementError, undefined);
  assert.equal(result.notification.state, "rejected");
});

test("a blocked ledger plan executes no transport call", async () => {
  let sent = false;
  const input = {
    eventId: "event-blocked",
    watchId: "watch-1",
    kind: "watch-event" as const,
    eventAppended: true,
    attemptId: "attempt-blocked",
    now: NOW,
  };
  const result = await executeNotificationDelivery({
    prepare: async () => blockedNotificationPlan(input),
    revalidateBeforeSend: async () => null,
    send: async () => {
      sent = true;
      return acceptedResult();
    },
    settle: async (_attemptId, settlement) => settledSummary(settlement),
    revalidateAfterSend: async () => null,
  });
  assert.equal(sent, false);
  assert.equal(result.notification.state, "unknown");
  assert.equal(result.notification.evidence, "invalid-record");
});

test("canonical notifier client prefers v2 and does not fall back within an ambiguous occurrence", async () => {
  const workspace = new FakeWorkspace();
  let legacyCalls = 0;
  const descriptor = serviceDescriptor(async () => {
    throw new Error("ambiguous provider failure");
  });
  workspace.on(TPS_NOTIFIER_SERVICE_EVENTS.REQUEST, (request: TPSNotifierServiceRequest) => {
    request.accept(descriptor);
  });
  const client = new TPSNotifierClient(fakeApp(workspace, {
    sendNotification: async () => { legacyCalls += 1; },
  }), "tps-watchlist");
  client.start(() => undefined);
  const result = await client.send({ body: "test" });
  assert.deepEqual(result, {
    state: "unknown",
    transport: "notifier-v2",
    evidence: "unclassified-v2-failure",
    attempted: "unknown",
  });
  assert.equal(legacyCalls, 0);
});

test("canonical notifier client clears only the exact unavailable descriptor", async () => {
  const workspace = new FakeWorkspace();
  let serve = true;
  let primaryCalls = 0;
  const primary = serviceDescriptor(async () => {
    primaryCalls += 1;
    return { outcome: "accepted", httpStatus: 202, providerMessageId: "message-1" };
  });
  const other = serviceDescriptor(async () => ({
    outcome: "accepted", httpStatus: 202, providerMessageId: "message-other",
  }));
  workspace.on(TPS_NOTIFIER_SERVICE_EVENTS.REQUEST, (request: TPSNotifierServiceRequest) => {
    if (serve) request.accept(primary);
  });
  const client = new TPSNotifierClient(fakeApp(workspace), "tps-watchlist");
  client.start(() => undefined);
  serve = false;
  workspace.trigger(TPS_NOTIFIER_SERVICE_EVENTS.UNAVAILABLE, other);
  assert.equal((await client.send({ body: "first" })).state, "accepted");
  workspace.trigger(TPS_NOTIFIER_SERVICE_EVENTS.UNAVAILABLE, primary);
  assert.deepEqual(await client.send({ body: "second" }), {
    state: "not-attempted",
    transport: "unavailable",
    evidence: "service-unavailable",
    attempted: false,
  });
  assert.equal(primaryCalls, 1);
});

test("canonical notifier client maps structured v2 and legacy v1 outcomes without same-call retry", async () => {
  const workspace = new FakeWorkspace();
  let serve = true;
  const notReady = Object.assign(new Error("not ready"), {
    code: "not-ready",
    attempted: false,
    deliveryState: "not-attempted",
    duplicateSafeToRetry: true,
  });
  const descriptor = serviceDescriptor(async () => { throw notReady; });
  workspace.on(TPS_NOTIFIER_SERVICE_EVENTS.REQUEST, (request: TPSNotifierServiceRequest) => {
    if (serve) request.accept(descriptor);
  });
  let legacyCalls = 0;
  const client = new TPSNotifierClient(fakeApp(workspace, {
    sendNotification: async () => { legacyCalls += 1; },
  }), "tps-watchlist");
  client.start(() => undefined);
  serve = false;
  assert.deepEqual(await client.send({ body: "v2" }), {
    state: "not-attempted",
    transport: "notifier-v2",
    evidence: "structured-not-attempted",
    attempted: false,
    code: "not-ready",
  });
  assert.equal(legacyCalls, 0);
  assert.deepEqual(await client.send({ body: "next occurrence" }), {
    state: "legacy-accepted",
    transport: "notifier-v1",
    evidence: "legacy-promise-resolved",
    attempted: true,
  });
  assert.equal(legacyCalls, 1);
});

test("canonical notifier client preserves structured rejection versus unconfirmed certainty", async () => {
  for (const scenario of [
    {
      error: Object.assign(new Error("rejected"), {
        code: "delivery-rejected",
        attempted: true,
        deliveryState: "rejected",
        duplicateSafeToRetry: true,
        httpStatus: 503,
      }),
      expected: {
        state: "rejected",
        transport: "notifier-v2",
        evidence: "structured-rejection",
        attempted: true,
        code: "delivery-rejected",
        httpStatus: 503,
      },
    },
    {
      error: Object.assign(new Error("unconfirmed"), {
        code: "delivery-unconfirmed",
        attempted: true,
        deliveryState: "unconfirmed",
        duplicateSafeToRetry: false,
      }),
      expected: {
        state: "unknown",
        transport: "notifier-v2",
        evidence: "unconfirmed",
        attempted: true,
        code: "delivery-unconfirmed",
      },
    },
  ]) {
    const workspace = new FakeWorkspace();
    const descriptor = serviceDescriptor(async () => { throw scenario.error; });
    workspace.on(TPS_NOTIFIER_SERVICE_EVENTS.REQUEST, (request: TPSNotifierServiceRequest) => {
      request.accept(descriptor);
    });
    const client = new TPSNotifierClient(fakeApp(workspace), "tps-watchlist");
    client.start(() => undefined);
    assert.deepEqual(await client.send({ body: "test" }), scenario.expected);
  }
});

test("canonical notifier client treats malformed receipts and legacy rejection as indeterminate", async () => {
  const workspace = new FakeWorkspace();
  let serve = true;
  const descriptor = serviceDescriptor(async () => ({
    outcome: "accepted",
    httpStatus: 202,
    providerMessageId: "",
  }));
  workspace.on(TPS_NOTIFIER_SERVICE_EVENTS.REQUEST, (request: TPSNotifierServiceRequest) => {
    if (serve) request.accept(descriptor);
  });
  const client = new TPSNotifierClient(fakeApp(workspace, {
    sendNotification: async () => { throw new Error("legacy unknown"); },
  }), "tps-watchlist");
  client.start(() => undefined);
  assert.deepEqual(await client.send({ body: "malformed" }), {
    state: "unknown",
    transport: "notifier-v2",
    evidence: "malformed-v2-result",
    attempted: "unknown",
  });
  serve = false;
  workspace.trigger(TPS_NOTIFIER_SERVICE_EVENTS.UNAVAILABLE, descriptor);
  assert.deepEqual(await client.send({ body: "legacy" }), {
    state: "unknown",
    transport: "notifier-v1",
    evidence: "legacy-rejection",
    attempted: "unknown",
  });
});

test("canonical notifier guards fail closed on throwing descriptor accessors", async () => {
  const workspace = new FakeWorkspace();
  const malicious = new Proxy({}, {
    get: () => { throw new Error("getter trap"); },
  });
  workspace.on(TPS_NOTIFIER_SERVICE_EVENTS.REQUEST, (request: TPSNotifierServiceRequest) => {
    request.accept(malicious);
  });
  const client = new TPSNotifierClient(fakeApp(workspace), "tps-watchlist");
  assert.doesNotThrow(() => client.start(() => undefined));
  assert.deepEqual(await client.send({ body: "test" }), {
    state: "not-attempted",
    transport: "unavailable",
    evidence: "service-unavailable",
    attempted: false,
  });
});

function record(overrides: Partial<WatchNotificationRecord>): WatchNotificationRecord {
  return {
    eventId: "event",
    watchId: "watch-1",
    kind: "watch-event",
    state: "accepted",
    transport: "notifier-v2",
    evidence: "structured-receipt",
    attemptId: "attempt",
    attemptCount: 1,
    createdAt: NOW,
    updatedAt: NOW,
    attempted: true,
    httpStatus: 202,
    providerMessageId: "message-1",
    ...overrides,
  };
}

function attemptingPlan(): NotificationDeliveryPlan {
  const records = createNotificationRecordMap();
  return prepareNotificationDelivery(records, {
    eventId: "event-1",
    watchId: "watch-1",
    kind: "watch-event",
    eventAppended: true,
    attemptId: "attempt-1",
    now: NOW,
  });
}

function acceptedResult(): TPSNotifierConsumerDeliveryResult {
  return {
    state: "accepted",
    transport: "notifier-v2",
    evidence: "structured-receipt",
    attempted: true,
    httpStatus: 202,
    providerMessageId: "message-1",
  };
}

function settledSummary(settlement: NotificationSettlement): WatchNotificationSummary {
  return {
    eventId: "event-1",
    kind: "watch-event",
    state: settlement.state,
    transport: settlement.transport,
    evidence: settlement.evidence,
    attempted: settlement.attempted,
    updatedAt: LATER,
  };
}

function serviceDescriptor(
  send: TPSNotifierApi["send"],
): TPSNotifierServiceDescriptor {
  const api = {
    apiVersion: 2 as const,
    capabilities: Object.freeze({
      structuredReceipts: true as const,
      redactedDiagnostics: true as const,
      stableSequenceIds: false as const,
    }),
    send,
    validate: () => ({
      valid: true as const,
      serverHost: "example.test",
      secure: true,
      priority: 3,
      hasClick: false,
      bodyBytes: 4,
    }),
    sendNotification: async () => undefined,
    sendMessage: async () => undefined,
    dryRunMessage: () => undefined,
  };
  return Object.freeze({
    protocolVersion: 1 as const,
    providerPluginId: "tps-messager" as const,
    api: Object.freeze(api),
  });
}

class FakeWorkspace {
  private handlers = new Map<string, Array<(...args: any[]) => void>>();

  on(name: string, callback: (...args: any[]) => void): unknown {
    const handlers = this.handlers.get(name) || [];
    handlers.push(callback);
    this.handlers.set(name, handlers);
    return { name, callback };
  }

  trigger(name: string, ...args: unknown[]): void {
    for (const callback of this.handlers.get(name) || []) callback(...args);
  }
}

function fakeApp(workspace: FakeWorkspace, legacyApi?: unknown): any {
  return {
    workspace,
    plugins: {
      getPlugin: (pluginId: string) => pluginId === "tps-messager" && legacyApi
        ? { api: legacyApi }
        : null,
    },
  };
}
