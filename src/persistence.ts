export type PersistedPluginData = Record<string, unknown>;

interface QueuedStateSave<TStates> {
  snapshot: TStates;
  requests: StateSaveRequest[];
}

interface StateSaveRequest {
  resolve: (data: PersistedPluginData) => void;
  reject: (reason: unknown) => void;
}

export class WatchlistPersistenceCoordinator<TSettings extends object, TStates extends object> {
  private serial: Promise<void> = Promise.resolve();
  private settingsBaseline: PersistedPluginData = {};
  private desiredSettings: PersistedPluginData = {};
  private queuedStateSave: QueuedStateSave<TStates> | null = null;

  constructor(
    private readonly read: () => Promise<unknown>,
    private readonly write: (data: PersistedPluginData) => Promise<void>,
  ) {}

  setSettingsBaseline(settings: TSettings): void {
    this.settingsBaseline = cloneJsonSnapshot(settings) as PersistedPluginData;
    this.desiredSettings = cloneJsonSnapshot(settings) as PersistedPluginData;
  }

  saveStates(states: TStates): Promise<PersistedPluginData> {
    const snapshot = cloneJsonSnapshot(states);
    let resolveRequest!: (data: PersistedPluginData) => void;
    let rejectRequest!: (reason: unknown) => void;
    const promise = new Promise<PersistedPluginData>((resolve, reject) => {
      resolveRequest = resolve;
      rejectRequest = reject;
    });
    const request = { resolve: resolveRequest, reject: rejectRequest };
    if (this.queuedStateSave) {
      this.queuedStateSave.snapshot = snapshot;
      this.queuedStateSave.requests.push(request);
      return promise;
    }
    const batch: QueuedStateSave<TStates> = { snapshot, requests: [request] };
    this.queuedStateSave = batch;
    void this.enqueue(() => this.flushStateSave(batch));
    return promise;
  }

  saveSettings(settings: TSettings): Promise<PersistedPluginData> {
    const snapshot = cloneJsonSnapshot(settings) as PersistedPluginData;
    const changedKeys = changedRecordKeys(this.settingsBaseline, snapshot);
    for (const key of changedRecordKeys(this.desiredSettings, snapshot)) changedKeys.add(key);
    this.desiredSettings = cloneJsonSnapshot(snapshot);
    this.queuedStateSave = null;
    return this.enqueue(async () => {
      const latest = requirePluginData(await this.read());
      const latestSettings = optionalRecord(latest.settings);
      const merged = {
        ...latest,
        settings: mergeRecordChanges(latestSettings, snapshot, changedKeys),
      };
      await this.write(merged);
      this.settingsBaseline = cloneJsonSnapshot(snapshot);
      return merged;
    });
  }

  private async flushStateSave(batch: QueuedStateSave<TStates>): Promise<void> {
    if (this.queuedStateSave === batch) this.queuedStateSave = null;
    while (batch.requests.length > 0) {
      try {
        const latest = requirePluginData(await this.read());
        const merged = { ...latest, states: batch.snapshot };
        await this.write(merged);
        for (const request of batch.requests) request.resolve(merged);
        batch.requests.length = 0;
      } catch (error) {
        // Preserve the old queue contract: one failed attempt rejects one caller,
        // while each later save request still receives an attempt.
        batch.requests.shift()?.reject(error);
      }
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.serial.then(operation);
    this.serial = result.then(() => undefined, () => undefined);
    return result;
  }
}

function requirePluginData(value: unknown): PersistedPluginData {
  if (value == null) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value as PersistedPluginData;
  throw new Error("TPS Watchlist plugin data must be an object.");
}

function optionalRecord(value: unknown): PersistedPluginData {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as PersistedPluginData
    : {};
}

function cloneJsonSnapshot<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function changedRecordKeys(
  baseline: PersistedPluginData,
  snapshot: PersistedPluginData,
): Set<string> {
  const keys = new Set([...Object.keys(baseline), ...Object.keys(snapshot)]);
  return new Set([...keys].filter((key) => JSON.stringify(baseline[key]) !== JSON.stringify(snapshot[key])));
}

export function mergeRecordChanges(
  latest: PersistedPluginData,
  snapshot: PersistedPluginData,
  changedKeys: ReadonlySet<string>,
): PersistedPluginData {
  const merged = cloneJsonSnapshot(latest);
  for (const key of changedKeys) {
    if (Object.prototype.hasOwnProperty.call(snapshot, key)) merged[key] = cloneJsonSnapshot(snapshot[key]);
    else delete merged[key];
  }
  return merged;
}
