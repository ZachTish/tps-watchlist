import type {
  WatchCondition,
  WatchDefinition,
  WatchEvaluation,
  WatchObservation,
  WatchState,
} from "./types";

export const WATCH_FINGERPRINT_VERSION = 2;

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

export function createEventId(watchId: string, observation: WatchObservation, eventKind: string): string {
  return "watch-event-" + stableHash(watchId + "|" + eventKind + "|" + observation.fingerprint);
}

export function isActiveStatus(status: string): boolean {
  const normalized = normalizeText(status).toLocaleLowerCase();
  return !["complete", "completed", "holding", "paused", "wont-do", "cancelled", "canceled", "archived"].includes(normalized);
}

export function validateDefinition(definition: WatchDefinition): string[] {
  const errors: string[] = [];
  if (!definition.title) errors.push("title is required");
  if (!/^https?:\/\//i.test(definition.url)) errors.push("source must be an HTTP or HTTPS URL");
  if (definition.provider === "json" && !definition.jsonPath) errors.push("watchJsonPath is required for JSON watches");
  if (["contains", "not-contains", "equals", "above", "below"].includes(definition.condition) && !definition.target) {
    errors.push("watchTarget is required for " + definition.condition);
  }
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
