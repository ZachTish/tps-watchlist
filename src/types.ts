export type WatchProvider = "page" | "json" | "rss";

export type WatchCondition =
  | "changed"
  | "new-item"
  | "contains"
  | "not-contains"
  | "equals"
  | "above"
  | "below"
  | "available";

export type WatchExecutionMode = "controller-only" | "this-device";
export type WatchEventLogTarget = "daily-note" | "watch-note";

export interface WatchDefinition {
  id: string;
  path: string;
  title: string;
  provider: WatchProvider;
  url: string;
  selector: string;
  jsonPath: string;
  pattern: string;
  query: string;
  condition: WatchCondition;
  target: string;
  intervalMinutes: number;
  notify: boolean;
  cooldownMinutes: number;
  caseSensitive: boolean;
  status: string;
  tags: string[];
}

export interface WatchObservation {
  observedAt: string;
  value: string;
  displayValue: string;
  numericValue: number | null;
  fingerprint: string;
  summary: string;
  sourceId?: string;
  sourceUrl?: string;
}

export interface WatchState {
  fingerprintVersion: number;
  baselineReady: boolean;
  lastFingerprint: string;
  lastValue: string;
  lastMatched: boolean;
  lastCheckedAt: string;
  lastEventAt: string;
  lastEventId: string;
  failureCount: number;
  lastError: string;
  lastErrorNotifiedAt: string;
}

export interface WatchEvaluation {
  matched: boolean;
  shouldEmit: boolean;
  eventKind: "baseline" | "changed" | "new-item" | "condition-met" | "none";
  reason: string;
}

export interface WatchCheckResult {
  watchId: string;
  path: string;
  outcome: "baseline" | "event" | "unchanged" | "failed" | "skipped";
  eventId?: string;
  error?: string;
}

export interface WatchlistSettings {
  settingsVersion: number;
  defaultFolder: string;
  watchlistBasePath: string;
  watchEventsBasePath: string;
  defaultIntervalMinutes: number;
  schedulerTickSeconds: number;
  executionMode: WatchExecutionMode;
  eventLogTarget: WatchEventLogTarget;
  defaultNotify: boolean;
  requestTimeoutSeconds: number;
  maxConcurrentChecks: number;
  failureAlertThreshold: number;
  notifyOnFailure: boolean;
  enableLogging: boolean;
}

export interface PersistedWatchlistData {
  settings: WatchlistSettings;
  states: Record<string, WatchState>;
}

export interface CreateWatchInput {
  title: string;
  url: string;
  provider?: WatchProvider;
  selector?: string;
  jsonPath?: string;
  pattern?: string;
  query?: string;
  condition?: WatchCondition;
  target?: string;
  intervalMinutes?: number;
  notify?: boolean;
  cooldownMinutes?: number;
  caseSensitive?: boolean;
  tags?: string[];
}

export interface WatchRow {
  definition: WatchDefinition;
  state: WatchState;
  active: boolean;
}

export interface WatchlistApi {
  createWatch(input: CreateWatchInput): Promise<string>;
  checkAll(reason?: string): Promise<WatchCheckResult[]>;
  checkPath(path: string, reason?: string): Promise<WatchCheckResult>;
  getWatches(): WatchRow[];
  ensureBases(): Promise<{ watchlist: string; events: string }>;
  openDashboard(): Promise<void>;
  getSettings(): WatchlistSettings;
}
