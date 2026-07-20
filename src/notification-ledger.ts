import type { TPSNotifierConsumerDeliveryResult } from "./tps-notifier-contract";
import type {
  WatchNotificationEvidence,
  WatchNotificationKind,
  WatchNotificationRecord,
  WatchNotificationSummary,
  WatchNotificationTransport,
} from "./types";

export const WATCH_NOTIFICATION_LEDGER_VERSION = 1;
export const MAX_WATCH_NOTIFICATION_RECORDS = 1000;

const NOTIFICATION_STATES = new Set([
  "attempting",
  "accepted",
  "legacy-accepted",
  "rejected",
  "not-attempted",
  "unknown",
]);
const NOTIFICATION_KINDS = new Set(["watch-event", "failure-alert"]);
const NOTIFICATION_TRANSPORTS = new Set(["notifier-v2", "notifier-v1", "unavailable", "unknown"]);
const NOTIFICATION_EVIDENCE = new Set<WatchNotificationEvidence>([
  "structured-receipt",
  "structured-rejection",
  "structured-not-attempted",
  "unconfirmed",
  "legacy-promise-resolved",
  "legacy-rejection",
  "service-unavailable",
  "malformed-v2-result",
  "unclassified-v2-failure",
  "interrupted",
  "legacy-untracked",
  "invalid-record",
  "consumer-timeout",
  "ledger-capacity",
  "attempt-started",
  "deduped-without-ledger",
  "ownership-changed",
]);
const RECORD_KEYS = new Set([
  "eventId",
  "watchId",
  "kind",
  "state",
  "transport",
  "evidence",
  "attemptId",
  "attemptCount",
  "createdAt",
  "updatedAt",
  "attempted",
  "code",
  "httpStatus",
  "providerMessageId",
]);
const NOTIFIER_ERROR_CODES = new Set([
  "not-ready",
  "settings-read-only",
  "delivery-disabled",
  "delivery-invalidated",
  "transport-dirty",
  "invalid-configuration",
  "invalid-payload",
  "internal-error",
  "delivery-busy",
  "delivery-rejected",
  "delivery-unconfirmed",
]);

export interface NotificationLedgerLoadResult {
  blocked: boolean;
  blockedReason?: string;
  records: Record<string, WatchNotificationRecord>;
  recoveredAttemptCount: number;
  prunedRecordCount: number;
  rawVersion: unknown;
  rawDeliveries: unknown;
}

export interface NotificationLedgerPersistenceFields {
  notificationLedgerVersion: unknown;
  notificationDeliveries: unknown;
}

export interface PrepareNotificationInput {
  eventId: string;
  watchId: string;
  kind: WatchNotificationKind;
  eventAppended: boolean;
  attemptId: string;
  now: string;
}

export interface NotificationDeliveryPlan {
  shouldSend: boolean;
  changed: boolean;
  record: WatchNotificationRecord;
  prunedEventIds: string[];
}

export interface NotificationSettlement {
  state: Exclude<WatchNotificationRecord["state"], "attempting">;
  transport: WatchNotificationTransport;
  evidence: WatchNotificationEvidence;
  attempted: boolean | "unknown";
  code?: string;
  httpStatus?: number;
  providerMessageId?: string;
}

export interface NotificationSettlementResult {
  changed: boolean;
  record?: WatchNotificationRecord;
  prunedEventIds: string[];
}

export interface NotificationExecutionResult<TConflict> {
  plan: NotificationDeliveryPlan;
  notification: WatchNotificationSummary;
  conflict: TConflict | null;
  conflictBoundary?: "before-send" | "after-send";
  settlementError?: unknown;
}

export interface NotificationExecutionCallbacks<TConflict> {
  prepare: () => Promise<NotificationDeliveryPlan>;
  revalidateBeforeSend: () => Promise<TConflict | null>;
  send: () => Promise<TPSNotifierConsumerDeliveryResult>;
  settle: (attemptId: string, settlement: NotificationSettlement) => Promise<WatchNotificationSummary>;
  revalidateAfterSend: () => Promise<TConflict | null>;
}

export function createNotificationRecordMap(): Record<string, WatchNotificationRecord> {
  return Object.create(null) as Record<string, WatchNotificationRecord>;
}

export function cloneNotificationRecordMap(
  source: Readonly<Record<string, WatchNotificationRecord>>,
): Record<string, WatchNotificationRecord> {
  const clone = createNotificationRecordMap();
  for (const [eventId, record] of Object.entries(source)) clone[eventId] = { ...record };
  return clone;
}

export function notificationLedgerPersistenceFields(
  blocked: boolean,
  records: Readonly<Record<string, WatchNotificationRecord>>,
  rawVersion: unknown,
  rawDeliveries: unknown,
): NotificationLedgerPersistenceFields {
  return blocked
    ? {
      notificationLedgerVersion: rawVersion,
      notificationDeliveries: rawDeliveries,
    }
    : {
      notificationLedgerVersion: WATCH_NOTIFICATION_LEDGER_VERSION,
      notificationDeliveries: cloneNotificationRecordMap(records),
    };
}

export function loadNotificationLedger(raw: unknown, now: string): NotificationLedgerLoadResult {
  let rawVersion: unknown;
  let rawDeliveries: unknown;
  try {
    if (!isRecord(raw)) return legacyEmptyLedger();
    const hasVersion = Object.prototype.hasOwnProperty.call(raw, "notificationLedgerVersion");
    const hasDeliveries = Object.prototype.hasOwnProperty.call(raw, "notificationDeliveries");
    if (!hasVersion && !hasDeliveries) return legacyEmptyLedger();
    rawVersion = raw.notificationLedgerVersion;
    rawDeliveries = raw.notificationDeliveries;
    if (!hasVersion || !hasDeliveries) {
      return blockedLedger("Notification ledger version and records must be stored together.", rawVersion, rawDeliveries);
    }
    if (rawVersion !== WATCH_NOTIFICATION_LEDGER_VERSION) {
      return blockedLedger("Unsupported notification ledger version.", rawVersion, rawDeliveries);
    }
    if (!isRecord(rawDeliveries)) {
      return blockedLedger("Notification ledger records are malformed.", rawVersion, rawDeliveries);
    }
    const records = createNotificationRecordMap();
    for (const [eventId, value] of Object.entries(rawDeliveries)) {
      const record = parseNotificationRecord(eventId, value);
      if (!record) {
        return blockedLedger("Notification ledger record is malformed: " + eventId, rawVersion, rawDeliveries);
      }
      records[eventId] = record;
    }
    const recoveredAttemptCount = recoverInterruptedNotificationAttempts(records, now);
    const prunedRecordCount = pruneNotificationRecords(records, MAX_WATCH_NOTIFICATION_RECORDS).length;
    return {
      blocked: false,
      records,
      recoveredAttemptCount,
      prunedRecordCount,
      rawVersion,
      rawDeliveries,
    };
  } catch {
    return blockedLedger("Notification ledger could not be read safely.", rawVersion, rawDeliveries);
  }
}

export function recoverInterruptedNotificationAttempts(
  records: Record<string, WatchNotificationRecord>,
  now: string,
): number {
  let recovered = 0;
  for (const record of Object.values(records)) {
    if (record.state !== "attempting") continue;
    record.state = "unknown";
    record.transport = "unknown";
    record.evidence = "interrupted";
    record.attempted = "unknown";
    record.updatedAt = now > record.updatedAt ? now : record.updatedAt;
    delete record.code;
    delete record.httpStatus;
    delete record.providerMessageId;
    recovered += 1;
  }
  return recovered;
}

export function prepareNotificationDelivery(
  records: Record<string, WatchNotificationRecord>,
  input: PrepareNotificationInput,
  maxRecords = MAX_WATCH_NOTIFICATION_RECORDS,
): NotificationDeliveryPlan {
  const existing = records[input.eventId];
  if (existing) {
    return {
      shouldSend: false,
      changed: false,
      record: { ...existing },
      prunedEventIds: [],
    };
  }
  const effectiveMax = Math.max(0, maxRecords);
  const prePrunedEventIds = pruneNotificationRecords(records, Math.max(0, effectiveMax - 1));
  if (Object.keys(records).length >= effectiveMax) {
    return {
      shouldSend: false,
      changed: prePrunedEventIds.length > 0,
      prunedEventIds: prePrunedEventIds,
      record: {
        eventId: input.eventId,
        watchId: input.watchId,
        kind: input.kind,
        state: "unknown",
        transport: "unknown",
        evidence: "ledger-capacity",
        attemptId: input.attemptId,
        attemptCount: 0,
        createdAt: input.now,
        updatedAt: input.now,
        attempted: "unknown",
      },
    };
  }
  const record: WatchNotificationRecord = input.eventAppended
    ? {
      eventId: input.eventId,
      watchId: input.watchId,
      kind: input.kind,
      state: "attempting",
      transport: "unknown",
      evidence: "attempt-started",
      attemptId: input.attemptId,
      attemptCount: 1,
      createdAt: input.now,
      updatedAt: input.now,
      attempted: "unknown",
    }
    : {
      eventId: input.eventId,
      watchId: input.watchId,
      kind: input.kind,
      state: "unknown",
      transport: "unknown",
      evidence: "deduped-without-ledger",
      attemptId: input.attemptId,
      attemptCount: 0,
      createdAt: input.now,
      updatedAt: input.now,
      attempted: "unknown",
    };
  records[input.eventId] = record;
  const prunedEventIds = prePrunedEventIds.concat(
    pruneNotificationRecords(records, effectiveMax, new Set([input.eventId])),
  );
  return {
    shouldSend: input.eventAppended,
    changed: true,
    record: { ...record },
    prunedEventIds,
  };
}

export function settleNotificationAttempt(
  records: Record<string, WatchNotificationRecord>,
  eventId: string,
  attemptId: string,
  settlement: NotificationSettlement,
  now: string,
  maxRecords = MAX_WATCH_NOTIFICATION_RECORDS,
): NotificationSettlementResult {
  const current = records[eventId];
  if (!current || current.state !== "attempting" || current.attemptId !== attemptId) {
    return { changed: false, record: current ? { ...current } : undefined, prunedEventIds: [] };
  }
  const settled: WatchNotificationRecord = {
    eventId: current.eventId,
    watchId: current.watchId,
    kind: current.kind,
    state: settlement.state,
    transport: settlement.transport,
    evidence: settlement.evidence,
    attemptId: current.attemptId,
    attemptCount: current.attemptCount,
    createdAt: current.createdAt,
    updatedAt: now > current.updatedAt ? now : current.updatedAt,
    attempted: settlement.attempted,
    ...(settlement.code === undefined ? {} : { code: settlement.code }),
    ...(settlement.httpStatus === undefined ? {} : { httpStatus: settlement.httpStatus }),
    ...(settlement.providerMessageId === undefined ? {} : { providerMessageId: settlement.providerMessageId }),
  };
  records[eventId] = settled;
  const prunedEventIds = pruneNotificationRecords(records, maxRecords, new Set([eventId]));
  return { changed: true, record: { ...settled }, prunedEventIds };
}

export function pruneNotificationRecords(
  records: Record<string, WatchNotificationRecord>,
  maxRecords = MAX_WATCH_NOTIFICATION_RECORDS,
  protectedEventIds: ReadonlySet<string> = new Set(),
): string[] {
  const excess = Math.max(0, Object.keys(records).length - Math.max(0, maxRecords));
  if (!excess) return [];
  const candidates = Object.values(records)
    .filter((record) => record.state !== "attempting" && !protectedEventIds.has(record.eventId))
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt)
      || left.createdAt.localeCompare(right.createdAt)
      || left.eventId.localeCompare(right.eventId));
  const removed: string[] = [];
  for (const record of candidates) {
    if (removed.length >= excess) break;
    delete records[record.eventId];
    removed.push(record.eventId);
  }
  return removed;
}

export function notificationSettlementFromResult(
  result: TPSNotifierConsumerDeliveryResult,
): NotificationSettlement {
  return {
    state: result.state,
    transport: result.transport,
    evidence: result.evidence,
    attempted: result.attempted,
    ...(result.code === undefined ? {} : { code: result.code }),
    ...(result.httpStatus === undefined ? {} : { httpStatus: result.httpStatus }),
    ...(result.providerMessageId === undefined ? {} : { providerMessageId: result.providerMessageId }),
  };
}

export function isDeliveredNotificationState(
  state: WatchNotificationRecord["state"],
): state is "accepted" | "legacy-accepted" {
  return state === "accepted" || state === "legacy-accepted";
}

export function notificationSummary(record: WatchNotificationRecord): WatchNotificationSummary {
  return {
    eventId: record.eventId,
    kind: record.kind,
    state: record.state,
    transport: record.transport,
    evidence: record.evidence,
    attempted: record.attempted,
    updatedAt: record.updatedAt,
  };
}

export function latestNotificationForWatch(
  records: Readonly<Record<string, WatchNotificationRecord>>,
  watchId: string,
): WatchNotificationSummary | undefined {
  let latest: WatchNotificationRecord | undefined;
  for (const record of Object.values(records)) {
    if (record.watchId !== watchId) continue;
    if (!latest
      || record.updatedAt > latest.updatedAt
      || (record.updatedAt === latest.updatedAt && record.eventId > latest.eventId)) {
      latest = record;
    }
  }
  return latest ? notificationSummary(latest) : undefined;
}

export function blockedNotificationPlan(
  input: PrepareNotificationInput,
): NotificationDeliveryPlan {
  return {
    shouldSend: false,
    changed: false,
    prunedEventIds: [],
    record: {
      eventId: input.eventId,
      watchId: input.watchId,
      kind: input.kind,
      state: "unknown",
      transport: "unknown",
      evidence: "invalid-record",
      attemptId: input.attemptId,
      attemptCount: 0,
      createdAt: input.now,
      updatedAt: input.now,
      attempted: "unknown",
    },
  };
}

export async function executeNotificationDelivery<TConflict>(
  callbacks: NotificationExecutionCallbacks<TConflict>,
): Promise<NotificationExecutionResult<TConflict>> {
  const plan = await callbacks.prepare();
  const conflictBefore = await callbacks.revalidateBeforeSend();
  if (!plan.shouldSend) {
    return {
      plan,
      notification: notificationSummary(plan.record),
      conflict: conflictBefore,
      ...(conflictBefore === null ? {} : { conflictBoundary: "before-send" as const }),
    };
  }
  if (conflictBefore !== null) {
    const settlement: NotificationSettlement = {
      state: "not-attempted",
      transport: "unknown",
      evidence: "ownership-changed",
      attempted: false,
    };
    try {
      const notification = await callbacks.settle(plan.record.attemptId, settlement);
      return {
        plan,
        notification,
        conflict: conflictBefore,
        conflictBoundary: "before-send",
      };
    } catch (settlementError) {
      return {
        plan,
        notification: notificationSummary(plan.record),
        conflict: conflictBefore,
        conflictBoundary: "before-send",
        settlementError,
      };
    }
  }

  let settlement: NotificationSettlement;
  try {
    settlement = notificationSettlementFromResult(await callbacks.send());
  } catch {
    settlement = {
      state: "unknown",
      transport: "unknown",
      evidence: "interrupted",
      attempted: "unknown",
    };
  }
  let notification = notificationSummary(plan.record);
  let settlementError: unknown;
  try {
    notification = await callbacks.settle(plan.record.attemptId, settlement);
  } catch (error) {
    settlementError = error;
  }
  const conflictAfter = await callbacks.revalidateAfterSend();
  return {
    plan,
    notification,
    conflict: conflictAfter,
    ...(conflictAfter === null ? {} : { conflictBoundary: "after-send" as const }),
    ...(settlementError === undefined ? {} : { settlementError }),
  };
}

function legacyEmptyLedger(): NotificationLedgerLoadResult {
  return {
    blocked: false,
    records: createNotificationRecordMap(),
    recoveredAttemptCount: 0,
    prunedRecordCount: 0,
    rawVersion: undefined,
    rawDeliveries: undefined,
  };
}

function blockedLedger(
  blockedReason: string,
  rawVersion: unknown,
  rawDeliveries: unknown,
): NotificationLedgerLoadResult {
  return {
    blocked: true,
    blockedReason,
    records: createNotificationRecordMap(),
    recoveredAttemptCount: 0,
    prunedRecordCount: 0,
    rawVersion,
    rawDeliveries,
  };
}

function parseNotificationRecord(eventId: string, value: unknown): WatchNotificationRecord | null {
  if (!isRecord(value) || !isBoundedString(eventId, 1, 512) || value.eventId !== eventId) return null;
  if (Object.keys(value).some((key) => !RECORD_KEYS.has(key))) return null;
  if (!isBoundedString(value.watchId, 1, 512)
    || !NOTIFICATION_KINDS.has(String(value.kind))
    || !NOTIFICATION_STATES.has(String(value.state))
    || !NOTIFICATION_TRANSPORTS.has(String(value.transport))
    || !NOTIFICATION_EVIDENCE.has(value.evidence as WatchNotificationEvidence)
    || !isBoundedString(value.attemptId, 1, 512)
    || !Number.isInteger(value.attemptCount)
    || Number(value.attemptCount) < 0
    || Number(value.attemptCount) > 1000000
    || !isIsoTimestamp(value.createdAt)
    || !isIsoTimestamp(value.updatedAt)
    || (value.attempted !== "unknown" && typeof value.attempted !== "boolean")) return null;
  if (String(value.createdAt) > String(value.updatedAt)) return null;
  if (value.code !== undefined && !isBoundedString(value.code, 1, 128)) return null;
  if (value.httpStatus !== undefined
    && (!Number.isInteger(value.httpStatus) || Number(value.httpStatus) < 100 || Number(value.httpStatus) > 599)) {
    return null;
  }
  if (value.providerMessageId !== undefined && !isBoundedString(value.providerMessageId, 1, 256)) return null;
  if (!hasCorrelatedNotificationSemantics(value)) return null;
  return {
    eventId,
    watchId: value.watchId as string,
    kind: value.kind as WatchNotificationKind,
    state: value.state as WatchNotificationRecord["state"],
    transport: value.transport as WatchNotificationTransport,
    evidence: value.evidence as WatchNotificationEvidence,
    attemptId: value.attemptId as string,
    attemptCount: Number(value.attemptCount),
    createdAt: value.createdAt as string,
    updatedAt: value.updatedAt as string,
    attempted: value.attempted as boolean | "unknown",
    ...(value.code === undefined ? {} : { code: value.code as string }),
    ...(value.httpStatus === undefined ? {} : { httpStatus: Number(value.httpStatus) }),
    ...(value.providerMessageId === undefined ? {} : { providerMessageId: value.providerMessageId as string }),
  };
}

function hasCorrelatedNotificationSemantics(value: Record<string, unknown>): boolean {
  const attemptCount = Number(value.attemptCount);
  switch (value.evidence) {
    case "attempt-started":
      return value.state === "attempting"
        && value.transport === "unknown"
        && value.attempted === "unknown"
        && attemptCount >= 1
        && hasNoDeliveryDetails(value);
    case "deduped-without-ledger":
    case "ledger-capacity":
    case "invalid-record":
    case "legacy-untracked":
      return value.state === "unknown"
        && value.transport === "unknown"
        && value.attempted === "unknown"
        && attemptCount === 0
        && hasNoDeliveryDetails(value);
    case "ownership-changed":
      return value.state === "not-attempted"
        && value.transport === "unknown"
        && value.attempted === false
        && attemptCount >= 1
        && hasNoDeliveryDetails(value);
    case "structured-receipt":
      return value.state === "accepted"
        && value.transport === "notifier-v2"
        && value.attempted === true
        && attemptCount >= 1
        && value.code === undefined
        && typeof value.httpStatus === "number"
        && value.httpStatus >= 200
        && value.httpStatus < 300
        && typeof value.providerMessageId === "string";
    case "legacy-promise-resolved":
      return value.state === "legacy-accepted"
        && value.transport === "notifier-v1"
        && value.attempted === true
        && attemptCount >= 1
        && hasNoDeliveryDetails(value);
    case "structured-rejection":
      return value.state === "rejected"
        && value.transport === "notifier-v2"
        && value.attempted === true
        && attemptCount >= 1
        && hasStructuredErrorDetails(value);
    case "structured-not-attempted":
      return value.state === "not-attempted"
        && value.transport === "notifier-v2"
        && value.attempted === false
        && attemptCount >= 1
        && hasStructuredErrorDetails(value);
    case "unconfirmed":
      return value.state === "unknown"
        && value.transport === "notifier-v2"
        && value.attempted === true
        && attemptCount >= 1
        && hasStructuredErrorDetails(value);
    case "malformed-v2-result":
    case "unclassified-v2-failure":
      return value.state === "unknown"
        && value.transport === "notifier-v2"
        && value.attempted === "unknown"
        && attemptCount >= 1
        && hasNoDeliveryDetails(value);
    case "legacy-rejection":
      return value.state === "unknown"
        && value.transport === "notifier-v1"
        && value.attempted === "unknown"
        && attemptCount >= 1
        && hasNoDeliveryDetails(value);
    case "service-unavailable":
      return value.state === "not-attempted"
        && value.transport === "unavailable"
        && value.attempted === false
        && attemptCount >= 1
        && hasNoDeliveryDetails(value);
    case "interrupted":
      return attemptCount >= 1
        && hasNoDeliveryDetails(value)
        && ((value.state === "unknown"
          && value.transport === "unknown"
          && value.attempted === "unknown")
        || (value.state === "not-attempted"
          && value.transport === "unavailable"
          && value.attempted === false));
    case "consumer-timeout":
      return value.state === "unknown"
        && (value.transport === "notifier-v1" || value.transport === "notifier-v2")
        && value.attempted === "unknown"
        && attemptCount >= 1
        && hasNoDeliveryDetails(value);
    default:
      return false;
  }
}

function hasNoDeliveryDetails(value: Record<string, unknown>): boolean {
  return value.code === undefined
    && value.httpStatus === undefined
    && value.providerMessageId === undefined;
}

function hasStructuredErrorDetails(value: Record<string, unknown>): boolean {
  return typeof value.code === "string"
    && NOTIFIER_ERROR_CODES.has(value.code)
    && value.providerMessageId === undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}

function isBoundedString(value: unknown, min: number, max: number): value is string {
  return typeof value === "string" && value.length >= min && value.length <= max;
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}
