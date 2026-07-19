import type {
  WatchCondition,
  WatchCheckResult,
  WatchDefinition,
  WatchEvaluation,
  WatchObservation,
  WatchState,
} from "./types";

export const WATCH_FINGERPRINT_VERSION = 2;

export interface WatchEffectJournal {
  committed: boolean;
  eventId?: string;
  watchId?: string;
}

export function createWatchEffectJournal(): WatchEffectJournal {
  return { committed: false };
}

export function recordWatchCommittedEffect(effects: WatchEffectJournal, eventId?: string): void {
  effects.committed = true;
  if (eventId) effects.eventId = eventId;
}

export function recordWatchIdentityWrite(effects: WatchEffectJournal, watchId: string): void {
  effects.committed = true;
  effects.watchId = watchId;
}

export function applyWatchEffectJournal(
  result: WatchCheckResult,
  effects: WatchEffectJournal,
): WatchCheckResult {
  if (!effects.committed) return result;
  const applied: WatchCheckResult = {
    ...result,
    watchId: effects.watchId || result.watchId,
    sideEffectsCommitted: true,
  };
  if (effects.eventId) applied.eventId = effects.eventId;
  return applied;
}

export function normalizeText(value: unknown): string {
  return String(value == null ? "" : value).replace(/\s+/g, " ").trim();
}

export function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return value.slice(0, Math.max(0, maxLength - 1)).trimEnd() + "…";
}

export function stableHash(value: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first ^= code;
    first = Math.imul(first, 0x01000193);
    second ^= code + index;
    second = Math.imul(second, 0x85ebca6b);
  }
  return (first >>> 0).toString(36) + (second >>> 0).toString(36);
}

export function observationFingerprint(condition: WatchCondition, value: string, sourceId = ""): string {
  const identity = normalizeText(sourceId);
  const normalized = normalizeText(value);
  const fingerprintSource = identity && condition === "new-item"
    ? identity
    : identity
      ? identity + "|" + normalized
      : normalized;
  return stableHash(fingerprintSource);
}

export function createFeedSourceIdentity(
  providerId: string,
  itemLink: string,
  title: string,
  publishedAt: string,
): string {
  return normalizeText(providerId)
    || normalizeText(itemLink)
    || [normalizeText(title), normalizeText(publishedAt)].filter(Boolean).join("|");
}

export function appendLineOnce(content: string, marker: string, line: string): { content: string; appended: boolean } {
  if (content.includes(marker)) return { content, appended: false };
  const separator = content.length === 0 || content.endsWith("\n") ? "" : "\n";
  return { content: content + separator + line + "\n", appended: true };
}

export function joinSingleFlight<T>(
  inFlight: Map<string, Promise<T>>,
  key: string,
  start: () => Promise<T>,
): { promise: Promise<T>; joined: boolean } {
  const existing = inFlight.get(key);
  if (existing) return { promise: existing, joined: true };
  const promise = start();
  inFlight.set(key, promise);
  const clear = () => {
    if (inFlight.get(key) === promise) inFlight.delete(key);
  };
  void promise.then(clear, clear);
  return { promise, joined: false };
}

export function stableSerialize(value: unknown): string {
  if (value == null || typeof value !== "object") return JSON.stringify(value) ?? String(value);
  if (Array.isArray(value)) return "[" + value.map(stableSerialize).join(",") + "]";
  const record = value as Record<string, unknown>;
  return "{" + Object.keys(record).sort().map((key) => JSON.stringify(key) + ":" + stableSerialize(record[key])).join(",") + "}";
}

export function parseNumericValue(value: unknown): number | null {
  const text = normalizeText(value).replace(/,/g, "");
  const match = text.match(/[-+]?(?:\d+(?:\.\d+)?|\.\d+)/);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

export function resolveJsonPath(input: unknown, path: string): unknown {
  const normalized = path.trim();
  if (!normalized || normalized === "$") return input;
  const tokens = normalized
    .replace(/^\$\.?/, "")
    .replace(/\[(?:'([^']+)'|"([^"]+)"|(\d+))\]/g, (_match, single, double, index) => "." + (single || double || index))
    .split(".")
    .map((token) => token.trim())
    .filter(Boolean);
  let current = input;
  for (const token of tokens) {
    if (current == null || (typeof current !== "object" && !Array.isArray(current))) {
      throw new Error("JSON path stopped before " + token + ".");
    }
    const record = current as Record<string, unknown>;
    if (!(token in record)) throw new Error("JSON path key was not found: " + token);
    current = record[token];
  }
  return current;
}

export function extractPattern(value: string, pattern: string, caseSensitive: boolean): string {
  if (!pattern.trim()) return normalizeText(value);
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, caseSensitive ? "" : "i");
  } catch (error) {
    throw new Error("Invalid watchPattern: " + errorMessage(error));
  }
  const match = value.match(regex);
  if (!match) throw new Error("watchPattern did not match the provider response.");
  return normalizeText(match[1] != null ? match[1] : match[0]);
}

export function isAvailableText(value: string): boolean {
  const text = normalizeText(value).toLocaleLowerCase();
  if (!text) return false;
  if (/(out of stock|sold out|unavailable|not available|coming soon|notify me|backorder)/i.test(text)) return false;
  return /(in stock|available now|add to cart|add to bag|buy now|ready for pickup|ships? (today|now|within))/i.test(text);
}

export function conditionMatches(
  condition: WatchCondition,
  observation: WatchObservation,
  target: string,
  caseSensitive: boolean,
): boolean {
  const value = caseSensitive ? observation.value : observation.value.toLocaleLowerCase();
  const expected = caseSensitive ? target : target.toLocaleLowerCase();
  switch (condition) {
    case "contains":
      return expected.length > 0 && value.includes(expected);
    case "not-contains":
      return expected.length > 0 && !value.includes(expected);
    case "equals":
      return value === expected;
    case "above": {
      const threshold = parseNumericValue(target);
      return threshold != null && observation.numericValue != null && observation.numericValue > threshold;
    }
    case "below": {
      const threshold = parseNumericValue(target);
      return threshold != null && observation.numericValue != null && observation.numericValue < threshold;
    }
    case "available":
      return expected ? value.includes(expected) : isAvailableText(observation.value);
    case "changed":
    case "new-item":
      return true;
  }
}

export function evaluateObservation(
  definition: WatchDefinition,
  observation: WatchObservation,
  state: WatchState | undefined,
  nowMs = Date.now(),
): WatchEvaluation {
  const matched = conditionMatches(definition.condition, observation, definition.target, definition.caseSensitive);
  if (!state?.baselineReady || !state.lastFingerprint) {
    return { matched, shouldEmit: false, eventKind: "baseline", reason: "Initial observation stored as the baseline." };
  }
  if (definition.condition === "new-item" && state.fingerprintVersion < WATCH_FINGERPRINT_VERSION) {
    return { matched, shouldEmit: false, eventKind: "none", reason: "Existing feed baseline upgraded to stable item identity." };
  }

  const changed = observation.fingerprint !== state.lastFingerprint;
  let shouldEmit = false;
  let eventKind: WatchEvaluation["eventKind"] = "none";
  let reason = "No meaningful transition.";

  if (definition.condition === "changed") {
    shouldEmit = changed;
    eventKind = shouldEmit ? "changed" : "none";
    reason = shouldEmit ? "Observed value changed from the stored baseline." : reason;
  } else if (definition.condition === "new-item") {
    shouldEmit = changed;
    eventKind = shouldEmit ? "new-item" : "none";
    reason = shouldEmit ? "Provider returned a new leading item." : reason;
  } else {
    shouldEmit = matched && !state.lastMatched;
    eventKind = shouldEmit ? "condition-met" : "none";
    reason = shouldEmit ? "Watch condition transitioned from false to true." : reason;
  }

  const cooldownMs = Math.max(0, definition.cooldownMinutes) * 60 * 1000;
  if (shouldEmit && cooldownMs > 0 && state.lastEventAt) {
    const elapsed = nowMs - Date.parse(state.lastEventAt);
    if (Number.isFinite(elapsed) && elapsed >= 0 && elapsed < cooldownMs) {
      return { matched, shouldEmit: false, eventKind: "none", reason: "Matching transition suppressed by watch cooldown." };
    }
  }

  return { matched, shouldEmit, eventKind, reason };
}

export function createEmptyState(): WatchState {
  return {
    fingerprintVersion: WATCH_FINGERPRINT_VERSION,
    baselineReady: false,
    lastFingerprint: "",
    lastValue: "",
    lastMatched: false,
    lastCheckedAt: "",
    lastEventAt: "",
    lastEventId: "",
    failureCount: 0,
    lastError: "",
    lastErrorNotifiedAt: "",
  };
}

export function createUntrustedOperationalState(state: WatchState): WatchState {
  return {
    ...createEmptyState(),
    lastCheckedAt: state.lastCheckedAt,
    failureCount: state.failureCount,
    lastError: state.lastError,
    lastErrorNotifiedAt: state.lastErrorNotifiedAt,
  };
}

export function createWatchStateRecord(): Record<string, WatchState> {
  return Object.create(null) as Record<string, WatchState>;
}

export function cloneWatchStateRecord(
  states: Readonly<Record<string, WatchState>>,
): Record<string, WatchState> {
  const clone = createWatchStateRecord();
  for (const [key, state] of Object.entries(states)) clone[key] = { ...state };
  return clone;
}

export function applyWatchDefinitionOverlays(
  definitions: readonly WatchDefinition[],
  overlays: ReadonlyMap<string, WatchDefinition | null>,
): WatchDefinition[] {
  if (overlays.size === 0) return definitions.slice();
  const result = definitions.filter((definition) => !overlays.has(definition.path));
  for (const definition of overlays.values()) {
    if (definition) result.push(definition);
  }
  return result;
}

export interface WatchStateMigrationPlan {
  state?: WatchState;
  transientPath?: string;
  legacyStateKey?: string;
}

export function planWatchStateMigration(
  definition: WatchDefinition,
  durableStates: Readonly<Record<string, WatchState>>,
  transientStates: Readonly<Record<string, WatchState>>,
  durableIds: ReadonlySet<string>,
  quarantinedWatchPaths: ReadonlySet<string> = new Set(),
): WatchStateMigrationPlan {
  if (quarantinedWatchPaths.has(definition.path)) return {};
  const transientState = transientStates[definition.path];
  const legacyStateKey = "path:" + definition.path;
  const legacyState = !durableIds.has(legacyStateKey)
    ? durableStates[legacyStateKey]
    : undefined;
  return {
    state: transientState || legacyState,
    transientPath: transientState ? definition.path : undefined,
    legacyStateKey: legacyState ? legacyStateKey : undefined,
  };
}

export function applyWatchStateCommit(
  durableStates: Record<string, WatchState>,
  transientStates: Record<string, WatchState>,
  quarantinedWatchIds: Set<string>,
  quarantinedWatchPaths: Set<string>,
  definition: WatchDefinition,
  state: WatchState,
  migration: WatchStateMigrationPlan,
  establishTrustedBaseline: boolean,
): void {
  durableStates[definition.id] = state;
  if (migration.transientPath) delete transientStates[migration.transientPath];
  if (migration.legacyStateKey && migration.legacyStateKey !== definition.id) {
    delete durableStates[migration.legacyStateKey];
  }
  if (establishTrustedBaseline) {
    quarantinedWatchIds.delete(definition.id);
    quarantinedWatchPaths.delete(definition.path);
  }
}

export function quarantineWatchIdentities(
  states: Record<string, WatchState>,
  quarantinedWatchIds: Set<string>,
  watchIds: Iterable<string>,
): string[] {
  const added: string[] = [];
  for (const id of watchIds) {
    if (quarantinedWatchIds.has(id)) continue;
    quarantinedWatchIds.add(id);
    states[id] = createEmptyState();
    added.push(id);
  }
  return added;
}

export function quarantineWatchIdentityConflicts(
  states: Record<string, WatchState>,
  quarantinedWatchIds: Set<string>,
  quarantinedWatchPaths: Set<string>,
  conflicts: ReadonlyMap<string, readonly string[]>,
): { addedIds: string[]; addedPaths: string[] } {
  const addedIds = quarantineWatchIdentities(states, quarantinedWatchIds, conflicts.keys());
  const addedPaths: string[] = [];
  for (const paths of conflicts.values()) {
    for (const path of paths) {
      if (quarantinedWatchPaths.has(path)) continue;
      quarantinedWatchPaths.add(path);
      addedPaths.push(path);
    }
  }
  return { addedIds, addedPaths };
}

export class WatchCatalogSettlementTracker {
  private revision = 0;
  private readonly pending = new Map<string, number>();

  markPending(path: string): number {
    this.revision += 1;
    this.pending.set(path, this.revision);
    return this.revision;
  }

  settle(path: string, expectedRevision: number): boolean {
    if (this.pending.get(path) !== expectedRevision) return false;
    this.pending.delete(path);
    return true;
  }

  forget(path: string): void {
    this.pending.delete(path);
  }

  move(oldPath: string, newPath: string): number | undefined {
    const pendingRevision = this.pending.get(oldPath);
    this.pending.delete(oldPath);
    if (pendingRevision == null) return undefined;
    this.revision += 1;
    this.pending.set(newPath, this.revision);
    return this.revision;
  }

  getRevision(path: string): number | undefined {
    return this.pending.get(path);
  }

  entries(): Array<[string, number]> {
    return Array.from(this.pending.entries());
  }

  hasUntrustedPending(trustedRevisions: ReadonlyMap<string, number> = new Map()): boolean {
    for (const [path, revision] of this.pending) {
      if (trustedRevisions.get(path) !== revision) return true;
    }
    return false;
  }
}

export function watchDefinitionSignature(definition: WatchDefinition): string {
  return stableSerialize(definition);
}

export function watchDefinitionContentSignature(definition: WatchDefinition): string {
  const { id: _id, hasDurableId: _hasDurableId, ...content } = definition;
  return stableSerialize(content);
}

export interface WatchIdentityLease {
  id: string;
  activePaths: Set<string>;
  activeOwnerCounts: Map<string, number>;
  ownerPaths: Map<string, string>;
  conflictPaths: Set<string>;
  conflicted: boolean;
}

export class WatchIdentityLeaseRegistry {
  private readonly leases = new Map<string, WatchIdentityLease>();

  acquire(id: string, ownerKey: string, path = ownerKey): WatchIdentityLease {
    let lease = this.leases.get(id);
    if (!lease) {
      lease = {
        id,
        activePaths: new Set([path]),
        activeOwnerCounts: new Map([[ownerKey, 1]]),
        ownerPaths: new Map([[ownerKey, path]]),
        conflictPaths: new Set([path]),
        conflicted: false,
      };
      this.leases.set(id, lease);
      return lease;
    }
    const activeCount = lease.activeOwnerCounts.get(ownerKey) || 0;
    if (activeCount === 0) {
      if (lease.activeOwnerCounts.size > 0) lease.conflicted = true;
      lease.activePaths.add(path);
      lease.conflictPaths.add(path);
      lease.ownerPaths.set(ownerKey, path);
    } else {
      const previousPath = lease.ownerPaths.get(ownerKey);
      if (previousPath !== path) {
        if (previousPath) lease.activePaths.delete(previousPath);
        lease.activePaths.add(path);
        lease.ownerPaths.set(ownerKey, path);
        if (!lease.conflicted && previousPath) lease.conflictPaths.delete(previousPath);
        lease.conflictPaths.add(path);
      }
    }
    lease.activeOwnerCounts.set(ownerKey, activeCount + 1);
    return lease;
  }

  taint(id: string, conflictingPaths: readonly string[]): void {
    const lease = this.leases.get(id);
    if (!lease || conflictingPaths.length < 2) return;
    lease.conflicted = true;
    for (const path of conflictingPaths) lease.conflictPaths.add(path);
  }

  release(lease: WatchIdentityLease, ownerKey: string): void {
    const activeCount = lease.activeOwnerCounts.get(ownerKey) || 0;
    if (activeCount <= 1) {
      lease.activeOwnerCounts.delete(ownerKey);
      const path = lease.ownerPaths.get(ownerKey);
      if (path) lease.activePaths.delete(path);
      lease.ownerPaths.delete(ownerKey);
    } else {
      lease.activeOwnerCounts.set(ownerKey, activeCount - 1);
    }
    if (lease.activeOwnerCounts.size === 0 && this.leases.get(lease.id) === lease) {
      this.leases.delete(lease.id);
    }
  }
}

export function watchEventTransitionKey(state: WatchState): string {
  return stableSerialize({
    lastFingerprint: state.lastFingerprint,
    lastMatched: state.lastMatched,
    lastEventAt: state.lastEventAt,
    lastEventId: state.lastEventId,
    failureCount: state.failureCount,
  });
}

export function createEventId(
  watchId: string,
  observation: WatchObservation,
  eventKind: string,
  transitionKey: string,
): string {
  return "watch-event-" + stableHash(
    watchId + "|" + eventKind + "|" + observation.fingerprint + "|" + transitionKey,
  );
}

export function findDuplicateWatchIdPaths(
  definitions: readonly WatchDefinition[],
): Map<string, string[]> {
  const pathsById = new Map<string, Set<string>>();
  for (const definition of definitions) {
    if (definition.hasDurableId === false) continue;
    const id = normalizeText(definition.id);
    const path = String(definition.path || "");
    if (!id || !path) continue;
    const paths = pathsById.get(id) || new Set<string>();
    paths.add(path);
    pathsById.set(id, paths);
  }

  const conflicts = new Map<string, string[]>();
  for (const [id, paths] of pathsById) {
    if (paths.size > 1) conflicts.set(id, Array.from(paths).sort((left, right) => left.localeCompare(right)));
  }
  return conflicts;
}

export function duplicateWatchIdError(watchId: string, conflictingPaths: readonly string[]): string {
  const paths = Array.from(new Set(conflictingPaths.map((path) => String(path || "")).filter(Boolean)))
    .sort((left, right) => left.localeCompare(right));
  if (paths.length < 2) return "";
  const visiblePaths = paths.slice(0, 3).map((path) => truncate(path, 100));
  const remainder = paths.length > visiblePaths.length ? " and " + (paths.length - visiblePaths.length) + " more" : "";
  return "Duplicate watchId \"" + truncate(normalizeText(watchId), 80) + "\" is used by "
    + paths.length + " watch notes: " + visiblePaths.join(", ") + remainder
    + ". Checks are blocked until every conflicting note has a unique watchId. Any identity observed in conflict must establish a new silent baseline before its prior state is trusted again.";
}

export function isActiveStatus(status: string): boolean {
  const normalized = normalizeText(status).toLocaleLowerCase();
  return !["complete", "completed", "holding", "paused", "wont-do", "cancelled", "canceled", "archived"].includes(normalized);
}

export function validateDefinition(
  definition: WatchDefinition,
  conflictingPaths: readonly string[] = [],
): string[] {
  const errors: string[] = [];
  if (!definition.title) errors.push("title is required");
  if (!/^https?:\/\//i.test(definition.url)) errors.push("source must be an HTTP or HTTPS URL");
  if (definition.provider === "json" && !definition.jsonPath) errors.push("watchJsonPath is required for JSON watches");
  if (["contains", "not-contains", "equals", "above", "below"].includes(definition.condition) && !definition.target) {
    errors.push("watchTarget is required for " + definition.condition);
  }
  const identityError = duplicateWatchIdError(definition.id, conflictingPaths);
  if (identityError) errors.push(identityError);
  return errors;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || "Unknown error");
}

export function sanitizeWatchErrorMessage(error: unknown): string {
  return errorMessage(error)
    .replace(/https?:\/\/[^\s"'<>]+/gi, (candidate) => {
      try {
        const parsed = new URL(candidate);
        return parsed.protocol + "//" + parsed.host + "/[redacted]";
      } catch {
        return "[redacted-url]";
      }
    })
    .replace(/\b(api[_-]?key|access[_-]?token|token|authorization|secret)=([^&\s]+)/gi, "$1=[redacted]");
}
