export type PersistedPluginData = Record<string, unknown>;

export class WatchlistPersistenceCoordinator<TSettings extends object, TStates extends object> {
  private serial: Promise<void> = Promise.resolve();
  private settingsBaseline: PersistedPluginData = {};
  private desiredSettings: PersistedPluginData = {};

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
    return this.enqueue(async () => {
      const latest = requirePluginData(await this.read());
      const merged = { ...latest, states: snapshot };
      await this.write(merged);
      return merged;
    });
  }

  saveSettings(settings: TSettings): Promise<PersistedPluginData> {
    const snapshot = cloneJsonSnapshot(settings) as PersistedPluginData;
    const changedKeys = changedRecordKeys(this.settingsBaseline, snapshot);
    for (const key of changedRecordKeys(this.desiredSettings, snapshot)) changedKeys.add(key);
    this.desiredSettings = cloneJsonSnapshot(snapshot);
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
