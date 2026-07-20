import {
  getFrontMatterInfo,
  Notice,
  normalizePath,
  parseYaml,
  Platform,
  Plugin,
  TFile,
  TFolder,
  WorkspaceLeaf,
} from "obsidian";
import {
  appendLineOnce,
  applyWatchEffectJournal,
  applyWatchDefinitionOverlays,
  applyWatchStateCommit,
  cloneWatchStateRecord,
  createEmptyState,
  createEventId,
  createUntrustedOperationalState,
  createWatchEffectJournal,
  createWatchStateRecord,
  duplicateWatchIdError,
  evaluateObservation,
  findDuplicateWatchIdPaths,
  isActiveStatus,
  joinSingleFlight,
  normalizeText,
  planWatchStateMigration,
  quarantineWatchIdentities,
  recordWatchCommittedEffect,
  recordWatchIdentityWrite,
  sanitizeWatchErrorMessage,
  WATCH_FINGERPRINT_VERSION,
  stableHash,
  truncate,
  validateDefinition,
  watchDefinitionContentSignature,
  watchDefinitionSignature,
  watchEventTransitionKey,
  WatchIdentityLeaseRegistry,
  WatchCatalogSettlementTracker,
} from "./core";
import { fetchWatchObservation } from "./providers";
import { CreateWatchModal } from "./modal";
import { DEFAULT_SETTINGS, sanitizeSettings } from "./settings";
import { WatchlistSettingTab } from "./settings-tab";
import { WATCHLIST_VIEW_TYPE, WatchlistView } from "./view";
import * as logger from "./logger";
import { TPSNotifierClient } from "./tps-notifier-client";
import type { TPSNotifierConsumerDeliveryResult } from "./tps-notifier-contract";
import { TPSAiGatewayClient } from "./tps-ai-gateway-client";
import type { TPSAiGatewayApiSnapshot } from "./tps-ai-gateway-contract";
import {
  disposeCallbacksSafely,
  registerCallbacksTransactionally,
  TPSAiCapabilityExecutionLease,
  TPSAiCapabilityRegistrationSet,
  TPSGcmActionExecutionLease,
  type TPSAiGatewayCapabilityRegistration,
} from "./ai-capability-registration";
import {
  blockedNotificationPlan,
  cloneNotificationRecordMap,
  createNotificationRecordMap,
  executeNotificationDelivery,
  isDeliveredNotificationState,
  latestNotificationForWatch,
  loadNotificationLedger,
  notificationLedgerPersistenceFields,
  notificationSummary,
  prepareNotificationDelivery,
  settleNotificationAttempt,
  type NotificationDeliveryPlan,
  type NotificationSettlement,
  type PrepareNotificationInput,
} from "./notification-ledger";
import type {
  CreateWatchInput,
  PersistedWatchlistData,
  WatchCheckResult,
  WatchCondition,
  WatchDefinition,
  WatchObservation,
  WatchNotificationKind,
  WatchNotificationRecord,
  WatchNotificationSummary,
  WatchProvider,
  WatchRow,
  WatchState,
  WatchlistApi,
  WatchlistSettings,
} from "./types";
import type { WatchEffectJournal, WatchIdentityLease, WatchStateMigrationPlan } from "./core";

const WATCH_CONDITIONS: WatchCondition[] = [
  "changed",
  "new-item",
  "contains",
  "not-contains",
  "equals",
  "above",
  "below",
  "available",
];
const WATCH_PROVIDERS: WatchProvider[] = ["page", "json", "rss"];
const WATCH_IDENTITY_STATE_VERSION = 1;

interface WatchIdentitySnapshot {
  revision: number;
  definitions: WatchDefinition[];
  definitionsByPath: Map<string, WatchDefinition>;
  duplicatePathsById: Map<string, string[]>;
  durableIds: Set<string>;
}

interface PreparedWatchIdentity {
  definition: WatchDefinition;
  migration: WatchStateMigrationPlan;
  expectedMtime: number;
  ownerKey: string;
  trustedCatalogOverlays: Map<string, TrustedCatalogOverlay>;
}

interface TrustedCatalogOverlay {
  revision?: number;
  definition: WatchDefinition | null;
}

interface PersistentWatchStateModel {
  states: Record<string, WatchState>;
  transientStates: Record<string, WatchState>;
  quarantinedWatchIds: Set<string>;
  quarantinedWatchPaths: Set<string>;
  notificationDeliveries: Record<string, WatchNotificationRecord>;
  notificationLedgerBlockedReason: string;
  rawNotificationLedgerVersion: unknown;
  rawNotificationDeliveries: unknown;
}

interface PersistentStateMutation<T> {
  changed: boolean;
  value: T;
}

interface CatalogRecoveryResult {
  settled: number;
  remaining: number;
  readFailures: number;
}

interface PendingPathStateMove {
  oldPath: string;
  newPath: string;
}

interface WatchEventWriteResult {
  appended: boolean;
  targetPath: string;
  targetFile: TFile;
  contentAfterWrite: string;
}

interface StableLiveWatchDefinition {
  definition: WatchDefinition;
  file: TFile;
  expectedMtime: number;
  ownerKey: string;
  pendingRevision?: number;
}

interface PendingNotificationCommit {
  eventId: string;
  kind: WatchNotificationKind;
  eventAppended: boolean;
}

class WatchDefinitionChangedError extends Error {}
class WatchStatePersistenceError extends Error {}

export default class TPSWatchlistPlugin extends Plugin {
  settings: WatchlistSettings = DEFAULT_SETTINGS;
  private states: Record<string, WatchState> = createWatchStateRecord();
  private transientStates: Record<string, WatchState> = createWatchStateRecord();
  private quarantinedWatchIds = new Set<string>();
  private quarantinedWatchPaths = new Set<string>();
  private notificationDeliveries: Record<string, WatchNotificationRecord> = createNotificationRecordMap();
  private notificationLedgerBlockedReason = "";
  private rawNotificationLedgerVersion: unknown;
  private rawNotificationDeliveries: unknown;
  private recoveredNotificationAttemptCount = 0;
  private startupPrunedNotificationRecordCount = 0;
  private notifierClient!: TPSNotifierClient<TFile>;
  private aiGatewayClient!: TPSAiGatewayClient;
  private aiCapabilityRegistrations = new TPSAiCapabilityRegistrationSet();
  private aiAvailabilityEpoch = 0;
  private availableAiGatewayApi?: Readonly<TPSAiGatewayApiSnapshot>;
  private aiIntegrationsReady = false;
  private aiCatalogReady = false;
  private activeAiCapabilityExecutionLease?: TPSAiCapabilityExecutionLease;
  private schedulerIntervalId: number | null = null;
  private startupTimeoutId: number | null = null;
  private batchInFlight = false;
  private checksInFlight = new Map<string, Promise<WatchCheckResult>>();
  private identityLeases = new WatchIdentityLeaseRegistry();
  private watchCatalogRevision = 0;
  private identitySnapshotCache: WatchIdentitySnapshot | null = null;
  private watchCatalogReady = false;
  private catalogVaultEventsReady = false;
  private catalogSettlements = new WatchCatalogSettlementTracker();
  private knownWatchPaths = new Set<string>();
  private catalogReadinessProbe: Promise<void> | null = null;
  private catalogRecoveryTimerId: number | null = null;
  private catalogRecoveryInFlight: Promise<void> | null = null;
  private catalogRecoveryRequested = false;
  private catalogRecoveryAttempt = 0;
  private catalogRecoveryReadFailurePaths = new Set<string>();
  private unloading = false;
  private lifecycleEpoch = 0;
  private fileOwnerKeys = new WeakMap<TFile, string>();
  private nextFileOwnerKey = 1;
  private saveSerial: Promise<void> = Promise.resolve();
  private quarantinePersistBarrier: Promise<void> = Promise.resolve();
  private pendingQuarantineIds = new Set<string>();
  private pendingQuarantinePaths = new Set<string>();
  private pendingPathStateMoves: PendingPathStateMove[] = [];
  private unregisterGcmActions: Array<() => void> = [];
  private gcmRegistrationBlocked = false;
  private activeGcmActionExecutionLease?: TPSGcmActionExecutionLease;
  private api!: WatchlistApi;

  async onload(): Promise<void> {
    const lifecycleEpoch = ++this.lifecycleEpoch;
    this.unloading = false;
    await this.saveSerial;
    if (!this.isCurrentLifecycle(lifecycleEpoch)) return;
    if (!await this.loadPluginData(lifecycleEpoch)
      || !this.isCurrentLifecycle(lifecycleEpoch)) return;
    logger.setLogging(this.settings.enableLogging);
    this.notifierClient = new TPSNotifierClient<TFile>(this.app, this.manifest.id);
    this.notifierClient.start((eventRef) => this.registerEvent(eventRef));
    this.registerView(WATCHLIST_VIEW_TYPE, (leaf) => new WatchlistView(leaf, this));
    this.registerCommands();
    this.addRibbonIcon("binoculars", "Open TPS Watchlist", () => {
      void this.runUserAction("open-dashboard", "Open Watchlist", () => this.openDashboard());
    });
    this.addSettingTab(new WatchlistSettingTab(this.app, this));
    this.exposeApi();

    this.registerEvent(this.app.metadataCache.on("changed", (file, data, cache) => {
      const wasWatch = this.knownWatchPaths.has(file.path)
        || this.identitySnapshotCache?.definitionsByPath.has(file.path) === true;
      const isWatch = normalizeText(cache.frontmatter?.kind).toLocaleLowerCase() === "watch";
      void this.settleCatalogMetadata(file, data, wasWatch || isWatch).then((result) => {
        if (result === "superseded") this.requestCatalogRecovery("metadata-superseded");
      }).catch((error) => {
        logger.failure("Identity", "metadata-settlement:failed", new Error(sanitizeWatchErrorMessage(error)), {
          path: file.path,
        });
        this.requestCatalogRecovery("metadata-read-failed");
      });
    }));
    this.registerEvent(this.app.metadataCache.on("resolved", () => {
      this.catalogRecoveryAttempt = 0;
      this.requestCatalogRecovery("metadata-resolved", true);
    }));
    this.registerEvent(this.app.workspace.on("tps:controller-role-changed" as any, (() => {
      logger.flow("Scheduler", "controller-role-changed");
      void this.runScheduledChecks("controller-role-changed");
    }) as any));

    const layoutLifecycleEpoch = this.lifecycleEpoch;
    this.app.workspace.onLayoutReady(() => {
      if (!this.isCurrentLifecycle(layoutLifecycleEpoch)) return;
      this.registerCatalogVaultEvents();
      this.catalogVaultEventsReady = true;
      this.requestCatalogRecovery("layout-ready", true);
      void this.initializeIntegrations(layoutLifecycleEpoch);
    });
    this.aiGatewayClient = new TPSAiGatewayClient(this.app, this.manifest.id);
    this.aiGatewayClient.start(
      (eventRef) => this.registerEvent(eventRef),
      (api) => this.handleAiGatewayAvailability(api),
    );
    this.startScheduler();
    logger.flow("Lifecycle", "loaded", {
      executionMode: this.settings.executionMode,
      defaultIntervalMinutes: this.settings.defaultIntervalMinutes,
      stateCount: Object.keys(this.states).length,
      transientStateCount: Object.keys(this.transientStates).length,
      quarantinedIdentityCount: this.quarantinedWatchIds.size,
      quarantinedPathCount: this.quarantinedWatchPaths.size,
      notificationRecordCount: Object.keys(this.notificationDeliveries).length,
      notificationLedgerBlocked: Boolean(this.notificationLedgerBlockedReason),
      recoveredNotificationAttemptCount: this.recoveredNotificationAttemptCount,
      startupPrunedNotificationRecordCount: this.startupPrunedNotificationRecordCount,
    });
  }

  onunload(): void {
    this.unloading = true;
    this.lifecycleEpoch += 1;
    this.aiAvailabilityEpoch += 1;
    this.availableAiGatewayApi = undefined;
    this.aiIntegrationsReady = false;
    this.aiCatalogReady = false;
    this.invalidateAiCapabilityExecutionLease();
    this.disposeAiCapabilityRegistrations("plugin-unload");
    this.aiGatewayClient?.dispose();
    this.stopCatalogRecovery();
    this.stopScheduler();
    this.notifierClient?.dispose();
    this.invalidateGcmActionExecutionLease();
    const gcmCleanup = disposeCallbacksSafely(this.unregisterGcmActions.splice(0));
    if (gcmCleanup.failureCount > 0) {
      this.gcmRegistrationBlocked = true;
      logger.warn("GCM", "actions:unregister-incomplete", {
        attempted: gcmCleanup.attemptCount,
        failed: gcmCleanup.failureCount,
      });
    }
    this.app.workspace.detachLeavesOfType(WATCHLIST_VIEW_TYPE);
    if ((this.app as any).tpsWatchlist === this.api) delete (this.app as any).tpsWatchlist;
    delete (this as any).api;
    logger.flow("Lifecycle", "unloaded");
  }

  async saveSettings(): Promise<void> {
    const lifecycleEpoch = this.lifecycleEpoch;
    if (!this.isCurrentLifecycle(lifecycleEpoch)) throw new WatchDefinitionChangedError();
    this.settings = sanitizeSettings(this.settings);
    this.invalidateWatchCatalog();
    logger.setLogging(this.settings.enableLogging);
    await this.persistData(lifecycleEpoch);
    if (!this.isCurrentLifecycle(lifecycleEpoch)) throw new WatchDefinitionChangedError();
    this.startScheduler();
    logger.flow("Settings", "saved", {
      executionMode: this.settings.executionMode,
      defaultIntervalMinutes: this.settings.defaultIntervalMinutes,
      schedulerTickSeconds: this.settings.schedulerTickSeconds,
      eventLogTarget: this.settings.eventLogTarget,
    });
  }

  openCreateModal(): void {
    new CreateWatchModal(this, this.settings.defaultIntervalMinutes, this.settings.defaultNotify).open();
  }

  async runUserAction(
    actionId: string,
    label: string,
    action: () => void | Promise<void>,
  ): Promise<void> {
    try {
      await action();
    } catch (error) {
      const summary = truncate(sanitizeWatchErrorMessage(error), 200);
      logger.failure("UI", "action:failed", new Error(summary), { actionId });
      new Notice(label + " failed: " + summary);
    }
  }

  async createWatch(input: CreateWatchInput): Promise<TFile> {
    const title = normalizeText(input.title);
    const url = normalizeText(input.url);
    const provider = WATCH_PROVIDERS.includes(input.provider as WatchProvider)
      ? input.provider as WatchProvider
      : inferProvider(url, normalizeText(input.jsonPath));
    const condition = WATCH_CONDITIONS.includes(input.condition as WatchCondition)
      ? input.condition as WatchCondition
      : provider === "rss" ? "new-item" : "changed";
    const id = this.createUniqueWatchId();
    const intervalMinutes = clampInteger(input.intervalMinutes, this.settings.defaultIntervalMinutes, 1, 10080);
    const cooldownMinutes = clampInteger(input.cooldownMinutes, 0, 0, 10080);
    const tags = Array.from(new Set((input.tags || []).map((tag) => normalizeText(tag).replace(/^#/, "")).filter(Boolean)));
    const draft: WatchDefinition = {
      id,
      hasDurableId: true,
      path: "",
      title,
      provider,
      url,
      selector: normalizeText(input.selector),
      jsonPath: normalizeText(input.jsonPath),
      pattern: String(input.pattern || "").trim(),
      query: normalizeText(input.query),
      condition,
      target: normalizeText(input.target),
      intervalMinutes,
      notify: input.notify !== false,
      cooldownMinutes,
      caseSensitive: input.caseSensitive === true,
      status: "working",
      tags,
    };
    const validation = validateDefinition(draft);
    if (validation.length) throw new Error("Invalid watch: " + validation.join("; ") + ".");

    await this.ensureFolder(this.settings.defaultFolder);
    const filePath = this.uniqueWatchPath(title);
    draft.path = filePath;
    const content = buildWatchNote(draft);
    logger.flow("Create", "write:start", {
      path: filePath,
      provider,
      condition,
      intervalMinutes,
      notify: draft.notify,
    });
    const file = await this.app.vault.create(filePath, content);
    await this.applyGcmRules(file);
    await this.openWatchFile(file.path);
    const result = await this.checkOne(draft, "create", true);
    logger.flow("Create", "write:done", { path: file.path, baselineOutcome: result.outcome });
    new Notice(result.error
      ? "Watch created, but its first check needs attention: " + result.error
      : "Watch created and baseline stored.");
    await this.refreshViews();
    return file;
  }

  getWatchRows(): WatchRow[] {
    const snapshot = this.getIdentitySnapshot();
    return snapshot.definitions
      .map((definition) => {
        const conflictingPaths = snapshot.duplicatePathsById.get(definition.id) || [];
        const blocked = conflictingPaths.length > 1;
        const stateTrusted = !blocked && this.isStateTrusted(definition);
        const storedState = this.getStoredState(definition, snapshot);
        const state = blocked
          ? createEmptyState()
          : stateTrusted
            ? { ...storedState }
            : createUntrustedOperationalState(storedState);
        return {
          definition: cloneWatchDefinition(definition),
          state,
          active: isActiveStatus(definition.status),
          configurationErrors: validateDefinition(definition, conflictingPaths),
          blocked,
          stateTrusted,
          identityNotice: !blocked && !stateTrusted
            ? "Identity was previously duplicated; the next successful check will establish a new silent baseline."
            : undefined,
          latestNotification: latestNotificationForWatch(this.notificationDeliveries, definition.id),
        };
      });
  }

  getNotificationLedgerWarning(): string {
    return this.notificationLedgerBlockedReason;
  }

  private scanWatchDefinitions(): WatchDefinition[] {
    return this.app.vault.getMarkdownFiles()
      .map((file) => this.definitionFromFile(file))
      .filter((definition): definition is WatchDefinition => definition != null);
  }

  private getIdentitySnapshot(): WatchIdentitySnapshot {
    if (this.identitySnapshotCache?.revision === this.watchCatalogRevision) {
      return this.identitySnapshotCache;
    }
    const definitions = this.scanWatchDefinitions();
    const snapshot: WatchIdentitySnapshot = {
      revision: this.watchCatalogRevision,
      definitions,
      definitionsByPath: new Map(definitions.map((definition) => [definition.path, definition])),
      duplicatePathsById: findDuplicateWatchIdPaths(definitions),
      durableIds: new Set(definitions
        .filter((definition) => definition.hasDurableId !== false)
        .map((definition) => definition.id)),
    };
    this.knownWatchPaths = new Set(definitions.map((definition) => definition.path));
    this.identitySnapshotCache = snapshot;
    return snapshot;
  }

  private invalidateWatchCatalog(): void {
    this.watchCatalogRevision += 1;
    this.identitySnapshotCache = null;
  }

  private registerCatalogVaultEvents(): void {
    this.registerEvent(this.app.vault.on("create", (file) => {
      if (!(file instanceof TFile) || file.extension !== "md") return;
      this.catalogSettlements.markPending(file.path);
      this.invalidateWatchCatalog();
      this.requestCatalogRecovery("vault-create");
    }));
    this.registerEvent(this.app.vault.on("modify", (file) => {
      if (!(file instanceof TFile) || file.extension !== "md") return;
      this.catalogSettlements.markPending(file.path);
      this.invalidateWatchCatalog();
      this.requestCatalogRecovery("vault-modify");
    }));
    this.registerEvent(this.app.vault.on("delete", (file) => {
      if (file instanceof TFile && file.extension === "md") {
        const wasWatch = this.knownWatchPaths.delete(file.path)
          || this.identitySnapshotCache?.definitionsByPath.has(file.path) === true;
        this.catalogSettlements.forget(file.path);
        this.invalidateWatchCatalog();
        if (wasWatch) void this.refreshViews();
        this.requestCatalogRecovery("vault-delete");
        return;
      }
      if (!(file instanceof TFolder)) return;
      const prefix = file.path.replace(/\/$/, "") + "/";
      let wasWatch = false;
      for (const path of Array.from(this.knownWatchPaths)) {
        if (!path.startsWith(prefix)) continue;
        this.knownWatchPaths.delete(path);
        wasWatch = true;
      }
      for (const [path] of this.catalogSettlements.entries()) {
        if (path.startsWith(prefix)) this.catalogSettlements.forget(path);
      }
      this.invalidateWatchCatalog();
      if (wasWatch) void this.refreshViews();
      this.requestCatalogRecovery("vault-folder-delete");
    }));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      if (file instanceof TFolder) {
        this.handleCatalogFolderRename(file, oldPath);
        return;
      }
      if (!(file instanceof TFile)) return;
      const oldWasMarkdown = oldPath.toLocaleLowerCase().endsWith(".md");
      const newIsMarkdown = file.extension === "md";
      const wasWatch = this.knownWatchPaths.delete(oldPath)
        || this.identitySnapshotCache?.definitionsByPath.has(oldPath) === true;
      if (wasWatch && newIsMarkdown) this.knownWatchPaths.add(file.path);
      this.catalogSettlements.forget(oldPath);
      if (newIsMarkdown) this.catalogSettlements.markPending(file.path);
      else this.catalogSettlements.forget(file.path);
      this.movePathScopedIdentityState(oldPath, file.path);
      if (!oldWasMarkdown && !newIsMarkdown && !wasWatch) return;
      this.invalidateWatchCatalog();
      if (wasWatch) void this.refreshViews();
      this.requestCatalogRecovery("vault-rename", true);
    }));
  }

  private handleCatalogFolderRename(folder: TFolder, oldPath: string): void {
    const oldPrefix = oldPath.replace(/\/$/, "") + "/";
    const newPrefix = folder.path.replace(/\/$/, "") + "/";
    const pathMoves = new Map<string, string>();
    let wasWatch = false;
    for (const path of Array.from(this.knownWatchPaths)) {
      if (!path.startsWith(oldPrefix)) continue;
      const newPath = newPrefix + path.slice(oldPrefix.length);
      this.knownWatchPaths.delete(path);
      this.knownWatchPaths.add(newPath);
      pathMoves.set(path, newPath);
      wasWatch = true;
    }
    for (const [path] of this.catalogSettlements.entries()) {
      if (!path.startsWith(oldPrefix)) continue;
      this.catalogSettlements.forget(path);
    }
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (!file.path.startsWith(newPrefix)) continue;
      const priorPath = oldPrefix + file.path.slice(newPrefix.length);
      pathMoves.set(priorPath, file.path);
      this.catalogSettlements.markPending(file.path);
    }
    this.movePathScopedIdentityStates(Array.from(pathMoves, ([oldPath, newPath]) => ({ oldPath, newPath })));
    this.invalidateWatchCatalog();
    if (wasWatch) void this.refreshViews();
    this.requestCatalogRecovery("vault-folder-rename", true);
  }

  private async settleCatalogMetadata(
    file: TFile,
    indexedData: string,
    refreshAffectedViews: boolean,
  ): Promise<"settled" | "superseded"> {
    const path = file.path;
    const pendingRevision = this.catalogSettlements.getRevision(path);
    const ownerKey = this.getFileOwnerKey(file);
    const expectedMtime = file.stat.mtime;
    const liveData = await this.app.vault.read(file);
    if (this.unloading) return "superseded";
    const current = this.app.vault.getAbstractFileByPath(path);
    if (current !== file
      || this.getFileOwnerKey(file) !== ownerKey
      || file.stat.mtime !== expectedMtime
      || liveData !== indexedData) {
      return "superseded";
    }
    if (pendingRevision != null && !this.catalogSettlements.settle(path, pendingRevision)) {
      return "superseded";
    }
    const liveDefinition = this.definitionFromData(file, liveData);
    if (liveDefinition) this.knownWatchPaths.add(path);
    else this.knownWatchPaths.delete(path);
    this.invalidateWatchCatalog();
    if (!refreshAffectedViews && !liveDefinition) return "settled";
    await this.reconcileDuplicateIdentities("metadata-change");
    await this.refreshViews();
    return "settled";
  }

  private requestCatalogRecovery(reason: string, immediate = false): void {
    if (this.unloading || !this.catalogVaultEventsReady) return;
    if (this.catalogRecoveryInFlight) {
      this.catalogRecoveryRequested = true;
      return;
    }
    if (immediate && this.catalogRecoveryTimerId != null) {
      window.clearTimeout(this.catalogRecoveryTimerId);
      this.catalogRecoveryTimerId = null;
    }
    if (this.catalogRecoveryTimerId != null) return;
    const delayMs = immediate
      ? 0
      : Math.min(10000, 200 * Math.pow(2, Math.min(this.catalogRecoveryAttempt, 6)));
    this.catalogRecoveryTimerId = window.setTimeout(() => {
      this.catalogRecoveryTimerId = null;
      if (!this.unloading) void this.runCatalogRecovery(reason);
    }, delayMs);
  }

  private stopCatalogRecovery(): void {
    if (this.catalogRecoveryTimerId != null) window.clearTimeout(this.catalogRecoveryTimerId);
    this.catalogRecoveryTimerId = null;
    this.catalogRecoveryRequested = false;
    this.catalogRecoveryReadFailurePaths.clear();
  }

  private async runCatalogRecovery(reason: string): Promise<void> {
    if (this.unloading || !this.catalogVaultEventsReady) return;
    if (this.catalogRecoveryInFlight) {
      this.catalogRecoveryRequested = true;
      return await this.catalogRecoveryInFlight;
    }
    const recovery = (async () => {
      this.catalogRecoveryRequested = false;
      let madeProgress = false;
      try {
        const result = await this.recoverPendingCatalogSettlements();
        if (this.unloading) return;
        madeProgress = result.settled > 0;
        if (!this.watchCatalogReady) await this.probeWatchCatalogReadiness();
        if (this.unloading) return;
        if (this.watchCatalogReady && !this.hasUntrustedCatalogPending()) {
          await this.reconcileDuplicateIdentities(reason);
          if (!this.unloading && !this.hasUntrustedCatalogPending()) {
            this.aiCatalogReady = true;
            this.registerAvailableAiCapabilities("catalog-reconciled");
          }
        }
        if (this.watchCatalogReady && !this.hasUntrustedCatalogPending()) {
          this.catalogRecoveryAttempt = 0;
          return;
        }
        this.catalogRecoveryAttempt = madeProgress
          ? 0
          : Math.min(7, this.catalogRecoveryAttempt + 1);
      } catch (error) {
        if (this.unloading) return;
        this.catalogRecoveryRequested = true;
        this.catalogRecoveryAttempt = Math.min(7, this.catalogRecoveryAttempt + 1);
        logger.failure("Identity", "metadata-recovery:failed", new Error(sanitizeWatchErrorMessage(error)), {
          reason,
          pendingPathCount: this.catalogSettlements.entries().length,
          retryDelayMs: Math.min(10000, 200 * Math.pow(2, Math.min(this.catalogRecoveryAttempt, 6))),
        });
      }
    })().finally(() => {
      if (this.catalogRecoveryInFlight === recovery) this.catalogRecoveryInFlight = null;
      if (!this.unloading && (this.catalogRecoveryRequested
        || !this.watchCatalogReady
        || this.hasUntrustedCatalogPending())) {
        this.requestCatalogRecovery("pending-catalog-retry");
      }
    });
    this.catalogRecoveryInFlight = recovery;
    await recovery;
  }

  private async recoverPendingCatalogSettlements(): Promise<CatalogRecoveryResult> {
    let settled = 0;
    let readFailures = 0;
    for (const [path, revision] of this.catalogSettlements.entries()) {
      if (this.unloading) break;
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile) || file.extension !== "md") {
        this.catalogSettlements.forget(path);
        this.catalogRecoveryReadFailurePaths.delete(path);
        settled += 1;
        continue;
      }
      const ownerKey = this.getFileOwnerKey(file);
      const expectedMtime = file.stat.mtime;
      let liveData: string;
      try {
        liveData = await this.app.vault.read(file);
      } catch (error) {
        readFailures += 1;
        if (!this.catalogRecoveryReadFailurePaths.has(path)) {
          this.catalogRecoveryReadFailurePaths.add(path);
          logger.failure("Identity", "metadata-recovery-read:failed", new Error(sanitizeWatchErrorMessage(error)), {
            path,
          });
        }
        continue;
      }
      this.catalogRecoveryReadFailurePaths.delete(path);
      if (this.unloading) break;
      const current = this.app.vault.getAbstractFileByPath(path);
      if (current !== file
        || this.getFileOwnerKey(file) !== ownerKey
        || file.stat.mtime !== expectedMtime
        || this.catalogSettlements.getRevision(path) !== revision) {
        continue;
      }
      const liveDefinition = this.definitionFromData(file, liveData);
      const cachedDefinition = this.definitionFromFile(file);
      if (watchDefinitionSignatureOrEmpty(liveDefinition)
        !== watchDefinitionSignatureOrEmpty(cachedDefinition)) {
        continue;
      }
      if (!this.catalogSettlements.settle(path, revision)) continue;
      if (liveDefinition) this.knownWatchPaths.add(path);
      else this.knownWatchPaths.delete(path);
      settled += 1;
    }
    if (settled > 0 && !this.unloading) {
      this.invalidateWatchCatalog();
      await this.refreshViews();
    }
    return {
      settled,
      remaining: this.catalogSettlements.entries().length,
      readFailures,
    };
  }

  private async activateWatchCatalog(reason: string): Promise<void> {
    if (this.unloading || this.watchCatalogReady || !this.catalogVaultEventsReady
      || this.hasUntrustedCatalogPending()) return;
    this.watchCatalogReady = true;
    this.invalidateWatchCatalog();
    try {
      await this.reconcileDuplicateIdentities(reason);
      if (this.unloading || !this.watchCatalogReady || this.hasUntrustedCatalogPending()) return;
      this.aiCatalogReady = true;
      this.registerAvailableAiCapabilities("catalog-ready");
    } catch (error) {
      this.catalogRecoveryRequested = true;
      logger.failure("Identity", "catalog-activation:failed", new Error(sanitizeWatchErrorMessage(error)), {
        reason,
      });
      throw error;
    }
  }

  private async probeWatchCatalogReadiness(): Promise<void> {
    if (this.unloading || this.watchCatalogReady) return;
    if (this.catalogReadinessProbe) return await this.catalogReadinessProbe;
    const probe = (async () => {
      const startingRevision = this.watchCatalogRevision;
      const files = this.app.vault.getMarkdownFiles();
      for (const file of files) {
        if (this.unloading || this.watchCatalogReady) return;
        const path = file.path;
        const ownerKey = this.getFileOwnerKey(file);
        const expectedMtime = file.stat.mtime;
        const liveData = await this.app.vault.read(file);
        if (this.unloading) return;
        const current = this.app.vault.getAbstractFileByPath(path);
        if (current !== file
          || this.getFileOwnerKey(file) !== ownerKey
          || file.stat.mtime !== expectedMtime
          || this.catalogSettlements.getRevision(path) != null) {
          return;
        }
        const liveDefinition = this.definitionFromData(file, liveData);
        const cachedDefinition = this.definitionFromFile(file);
        if (watchDefinitionSignatureOrEmpty(liveDefinition)
          !== watchDefinitionSignatureOrEmpty(cachedDefinition)) {
          return;
        }
      }
      if (startingRevision !== this.watchCatalogRevision
        || this.hasUntrustedCatalogPending()) {
        return;
      }
      await this.activateWatchCatalog("layout-ready-verified-cache");
    })().finally(() => {
      if (this.catalogReadinessProbe === probe) this.catalogReadinessProbe = null;
    });
    this.catalogReadinessProbe = probe;
    await probe;
  }

  private async reconcileDuplicateIdentities(reason: string): Promise<void> {
    if (this.unloading || !this.watchCatalogReady || this.hasUntrustedCatalogPending()) return;
    const snapshot = this.getIdentitySnapshot();
    if (this.unloading || snapshot.revision !== this.watchCatalogRevision
      || this.hasUntrustedCatalogPending()) return;
    await this.quarantineDuplicateIdentities(snapshot.duplicatePathsById, reason);
  }

  private hasUntrustedCatalogPending(
    localOverlays: ReadonlyMap<string, TrustedCatalogOverlay> = new Map(),
  ): boolean {
    const trusted = new Map<string, number>();
    for (const [path, overlay] of localOverlays) {
      if (overlay.revision != null
        && this.catalogSettlements.getRevision(path) === overlay.revision) {
        trusted.set(path, overlay.revision);
      }
    }
    return this.catalogSettlements.hasUntrustedPending(trusted);
  }

  private getActiveCatalogDefinitionOverlays(
    overlays: ReadonlyMap<string, TrustedCatalogOverlay>,
  ): Map<string, WatchDefinition | null> {
    const active = new Map<string, WatchDefinition | null>();
    for (const [path, overlay] of overlays) {
      if (this.catalogSettlements.getRevision(path) === overlay.revision) {
        active.set(path, overlay.definition);
      }
    }
    return active;
  }

  private async quarantineDuplicateIdentities(
    duplicatePathsById: ReadonlyMap<string, readonly string[]>,
    reason: string,
  ): Promise<void> {
    if (this.unloading) throw new WatchDefinitionChangedError();
    for (const [id, paths] of duplicatePathsById) {
      this.identityLeases.taint(id, paths);
      this.pendingQuarantineIds.add(id);
      for (const path of paths) this.pendingQuarantinePaths.add(path);
    }
    const persist = this.persistPendingIdentitySafetyState(reason);
    this.trackIdentitySafetyPersistence(persist);
    try {
      const { addedIds, addedPaths } = await persist;
      if (!addedIds.length && !addedPaths.length) return;
      logger.warn("Identity", "quarantine:added", {
        reason,
        identityCount: addedIds.length,
        pathCount: addedPaths.length,
        watchIds: addedIds.slice(0, 5),
        paths: addedPaths.slice(0, 5),
      });
    } catch (error) {
      logger.failure("Identity", "quarantine:persist-failed", new Error(sanitizeWatchErrorMessage(error)), {
        reason,
        identityCount: this.pendingQuarantineIds.size,
        pathCount: this.pendingQuarantinePaths.size,
      });
      throw error;
    }
  }

  private movePathScopedIdentityState(oldPath: string, newPath: string): void {
    this.movePathScopedIdentityStates([{ oldPath, newPath }]);
  }

  private movePathScopedIdentityStates(pathMoves: readonly PendingPathStateMove[]): void {
    if (!pathMoves.length) return;
    this.pendingPathStateMoves.push(...pathMoves);
    const persist = this.persistPendingIdentitySafetyState("path-state-rename");
    this.trackIdentitySafetyPersistence(persist);
    void persist.catch((error) => {
      logger.failure("Identity", "path-state-rename:persist-failed", new Error(sanitizeWatchErrorMessage(error)), {
        pathMoveCount: pathMoves.length,
        firstOldPath: pathMoves[0]?.oldPath,
        firstNewPath: pathMoves[0]?.newPath,
      });
    });
  }

  private trackIdentitySafetyPersistence(persist: Promise<unknown>): void {
    this.quarantinePersistBarrier = persist.then(() => undefined);
    void this.quarantinePersistBarrier.catch(() => undefined);
  }

  private async persistPendingIdentitySafetyState(
    reason: string,
  ): Promise<{ addedIds: string[]; addedPaths: string[] }> {
    const quarantineIds = Array.from(this.pendingQuarantineIds);
    const quarantinePaths = Array.from(this.pendingQuarantinePaths);
    const pathMoves = this.pendingPathStateMoves.slice();
    if (!quarantineIds.length && !quarantinePaths.length && !pathMoves.length) {
      return { addedIds: [], addedPaths: [] };
    }
    const result = await this.mutatePersistentWatchState((draft) => {
      if (this.unloading) throw new WatchDefinitionChangedError();
      const addedIds = quarantineWatchIdentities(
        draft.states,
        draft.quarantinedWatchIds,
        quarantineIds,
      );
      const addedPaths: string[] = [];
      for (const path of quarantinePaths) {
        if (draft.quarantinedWatchPaths.has(path)) continue;
        draft.quarantinedWatchPaths.add(path);
        addedPaths.push(path);
      }
      let changed = false;
      for (const move of pathMoves) {
        if (Object.prototype.hasOwnProperty.call(draft.transientStates, move.oldPath)) {
          draft.transientStates[move.newPath] = draft.transientStates[move.oldPath];
          delete draft.transientStates[move.oldPath];
          changed = true;
        }
        if (draft.quarantinedWatchPaths.delete(move.oldPath)) {
          draft.quarantinedWatchPaths.add(move.newPath);
          changed = true;
        }
      }
      return {
        changed: changed || addedIds.length > 0 || addedPaths.length > 0,
        value: { addedIds, addedPaths },
      };
    });
    for (const id of quarantineIds) this.pendingQuarantineIds.delete(id);
    for (const path of quarantinePaths) this.pendingQuarantinePaths.delete(path);
    const completedMoves = new Set(pathMoves);
    this.pendingPathStateMoves = this.pendingPathStateMoves.filter((move) => !completedMoves.has(move));
    logger.flow("Identity", "safety-state:persisted", {
      reason,
      identityCount: quarantineIds.length,
      pathCount: quarantinePaths.length,
      pathMoveCount: pathMoves.length,
    });
    return result;
  }

  private getStateMigration(
    definition: WatchDefinition,
    snapshot: WatchIdentitySnapshot,
  ): WatchStateMigrationPlan {
    return planWatchStateMigration(
      definition,
      this.states,
      this.transientStates,
      snapshot.durableIds,
      this.quarantinedWatchPaths,
    );
  }

  private getStoredState(
    definition: WatchDefinition,
    snapshot = this.getIdentitySnapshot(),
  ): WatchState {
    if (definition.hasDurableId !== false && this.states[definition.id]) {
      return this.states[definition.id];
    }
    return this.getStateMigration(definition, snapshot).state || createEmptyState();
  }

  private isStateTrusted(definition: WatchDefinition): boolean {
    return !this.quarantinedWatchIds.has(definition.id)
      && !this.quarantinedWatchPaths.has(definition.path);
  }

  private getEvaluationState(
    definition: WatchDefinition,
    migration: WatchStateMigrationPlan,
  ): { state: WatchState; trusted: boolean } {
    const stored = this.states[definition.id] || migration.state || createEmptyState();
    const trusted = this.isStateTrusted(definition);
    return {
      state: trusted ? stored : createUntrustedOperationalState(stored),
      trusted,
    };
  }

  async checkAll(reason = "api"): Promise<WatchCheckResult[]> {
    return await this.checkDefinitions(
      this.getWatchRows().filter((row) => row.active).map((row) => row.definition),
      reason,
      false,
    );
  }

  async checkPath(path: string, reason = "api"): Promise<WatchCheckResult> {
    const normalized = normalizePath(path);
    const file = this.app.vault.getAbstractFileByPath(normalized);
    if (!(file instanceof TFile) || file.extension !== "md") {
      throw new Error("Watch note was not found: " + normalized);
    }
    const definition = this.definitionFromFile(file);
    if (!definition) throw new Error("The target note is not kind: watch.");
    return await this.checkOne(definition, reason);
  }

  async toggleWatchStatus(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
    if (!(file instanceof TFile)) throw new Error("Watch note was not found.");
    const definition = this.definitionFromFile(file);
    if (!definition) throw new Error("The target note is not kind: watch.");
    const next = isActiveStatus(definition.status) ? "holding" : "working";
    logger.flow("Status", "update:start", { path: file.path, previous: definition.status, next });
    await this.processFrontmatter(file, (frontmatter) => {
      frontmatter.status = next;
    });
    logger.flow("Status", "update:done", { path: file.path, next });
    new Notice(next === "holding" ? "Watch paused." : "Watch resumed.");
    await this.refreshViews();
  }

  async openWatchFile(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
    if (!(file instanceof TFile)) throw new Error("Watch file was not found.");
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.openFile(file);
    this.app.workspace.revealLeaf(leaf);
  }

  async openDashboard(): Promise<void> {
    let leaf = this.app.workspace.getLeavesOfType(WATCHLIST_VIEW_TYPE)[0];
    if (!leaf) {
      leaf = this.app.workspace.getLeaf("tab");
      await leaf.setViewState({ type: WATCHLIST_VIEW_TYPE, active: true });
    }
    this.app.workspace.revealLeaf(leaf);
    if (leaf.view instanceof WatchlistView) await leaf.view.render();
  }

  async ensureBases(showNotice = true): Promise<{ watchlist: string; events: string }> {
    const watchlist = await this.ensureBaseFile(this.settings.watchlistBasePath, watchlistBaseContent());
    const events = await this.ensureBaseFile(this.settings.watchEventsBasePath, watchEventsBaseContent());
    logger.flow("Bases", "ensure:done", { watchlist, events });
    if (showNotice) new Notice("TPS Watchlist collection Bases are ready.");
    return { watchlist, events };
  }

  private async initializeIntegrations(lifecycleEpoch: number): Promise<void> {
    try {
      await this.ensureBases(false);
    } catch (error) {
      if (this.isCurrentLifecycle(lifecycleEpoch)) logger.failure("Bases", "ensure:failed", error);
    }
    if (!this.isCurrentLifecycle(lifecycleEpoch)) return;
    try {
      this.registerGcmActions(lifecycleEpoch);
    } catch (error) {
      logger.failure("GCM", "actions:register-failed", error, { route: "integration-initialization" });
    }
    if (!this.isCurrentLifecycle(lifecycleEpoch)) return;
    if (!this.unregisterGcmActions.length && !this.gcmRegistrationBlocked) {
      const retry = window.setTimeout(() => {
        if (this.isCurrentLifecycle(lifecycleEpoch) && !this.unregisterGcmActions.length) {
          this.registerGcmActions(lifecycleEpoch);
        }
      }, 3000);
      this.register(() => window.clearTimeout(retry));
    }
    this.aiIntegrationsReady = true;
    this.registerAvailableAiCapabilities("integrations-ready");
  }

  private registerCommands(): void {
    this.addCommand({
      id: "create-watch",
      name: "Create watch",
      callback: () => this.openCreateModal(),
    });
    this.addCommand({
      id: "open-watchlist",
      name: "Open Watchlist",
      callback: () => {
        void this.runUserAction("command-open-dashboard", "Open Watchlist", () => this.openDashboard());
      },
    });
    this.addCommand({
      id: "open-watchlist-base",
      name: "Open Watchlist Base",
      callback: () => {
        void this.runUserAction("command-open-watchlist-base", "Open Watchlist Base", () => (
          this.openBase(this.settings.watchlistBasePath)
        ));
      },
    });
    this.addCommand({
      id: "open-watch-events-base",
      name: "Open Watch Events Base",
      callback: () => {
        void this.runUserAction("command-open-events-base", "Open Watch Events Base", () => (
          this.openBase(this.settings.watchEventsBasePath)
        ));
      },
    });
    this.addCommand({
      id: "check-all-watches",
      name: "Check all active watches now",
      callback: () => {
        void this.runUserAction("command-check-all", "Check all watches", async () => {
          const results = await this.checkAll("command");
          const events = results.filter((result) => result.outcome === "event"
            || (result.sideEffectsCommitted && Boolean(result.eventId))).length;
          const failures = results.filter((result) => result.outcome === "failed").length;
          const blocked = results.filter((result) => result.code === "duplicate-watch-id"
            || result.code === "watch-definition-changed").length;
          new Notice("Watchlist checked " + results.length + " watch(es): " + events + " event(s), "
            + failures + " failure(s), " + blocked + " blocked or stale.");
        });
      },
    });
    this.addCommand({
      id: "check-active-watch",
      name: "Check active watch now",
      checkCallback: (checking) => {
        const file = this.getActiveWatchFile();
        if (!file) return false;
        if (!checking) void this.runUserAction("command-check-active", "Check active watch", async () => {
          const result = await this.checkPath(file.path, "command-active");
          new Notice(result.error || "Watch check: " + result.outcome + ".");
        });
        return true;
      },
    });
    this.addCommand({
      id: "toggle-active-watch",
      name: "Pause or resume active watch",
      checkCallback: (checking) => {
        const file = this.getActiveWatchFile();
        if (!file) return false;
        if (!checking) void this.runUserAction("command-toggle-active", "Pause or resume watch", () => (
          this.toggleWatchStatus(file.path)
        ));
        return true;
      },
    });
  }

  private startScheduler(): void {
    this.stopScheduler();
    if (this.unloading) return;
    const intervalMs = Math.max(30000, this.settings.schedulerTickSeconds * 1000);
    this.startupTimeoutId = window.setTimeout(() => {
      this.startupTimeoutId = null;
      void this.runScheduledChecks("startup");
    }, 10000);
    this.schedulerIntervalId = window.setInterval(() => {
      void this.runScheduledChecks("interval");
    }, intervalMs);
    this.registerInterval(this.schedulerIntervalId);
    logger.flow("Scheduler", "started", {
      intervalMs,
      executionMode: this.settings.executionMode,
    });
  }

  private stopScheduler(): void {
    if (this.startupTimeoutId != null) {
      window.clearTimeout(this.startupTimeoutId);
      this.startupTimeoutId = null;
    }
    if (this.schedulerIntervalId != null) {
      window.clearInterval(this.schedulerIntervalId);
      this.schedulerIntervalId = null;
    }
  }

  private async runScheduledChecks(reason: string): Promise<void> {
    if (!this.canRunAutomatic()) {
      logger.flow("Scheduler", "tick:skipped", {
        reason,
        executionMode: this.settings.executionMode,
        isMobile: Platform.isMobile,
        controllerAvailable: !!this.getControllerApi(),
      });
      return;
    }
    try {
      await this.reconcileDuplicateIdentities("scheduler:" + reason);
    } catch (error) {
      logger.failure("Scheduler", "identity-reconcile:failed", new Error(sanitizeWatchErrorMessage(error)), { reason });
      return;
    }
    const rows = this.getWatchRows().filter((row) => row.active);
    const invalid = rows.filter((row) => (row.configurationErrors || []).length > 0);
    if (invalid.length) {
      logger.warn("Scheduler", "configuration:skipped", {
        count: invalid.length,
        paths: invalid.slice(0, 5).map((row) => row.definition.path),
      });
    }
    const due = rows
      .filter((row) => (row.configurationErrors || []).length === 0 && isDue(row.definition, row.state))
      .map((row) => row.definition);
    if (!due.length) return;
    await this.checkDefinitions(due, "scheduler:" + reason, true);
  }

  private canRunAutomatic(): boolean {
    if (Platform.isMobile) return false;
    if (this.settings.executionMode === "this-device") return true;
    return this.getControllerApi()?.isController?.() === true;
  }

  private async checkDefinitions(
    definitions: WatchDefinition[],
    reason: string,
    dueOnly: boolean,
  ): Promise<WatchCheckResult[]> {
    if (this.batchInFlight) {
      logger.warn("Check", "batch:already-running", { reason, requested: definitions.length });
      return definitions.map((definition) => ({
        watchId: definition.id,
        path: definition.path,
        outcome: "skipped",
        error: "Another watch batch is already running.",
      }));
    }
    this.batchInFlight = true;
    const started = Date.now();
    const queue = definitions.slice();
    const results: WatchCheckResult[] = [];
    logger.flow("Check", "batch:start", {
      reason,
      dueOnly,
      count: queue.length,
      concurrency: this.settings.maxConcurrentChecks,
    });
    try {
      try {
        await this.reconcileDuplicateIdentities("batch:" + reason);
      } catch (error) {
        logger.failure("Identity", "batch-reconcile:failed", new Error(sanitizeWatchErrorMessage(error)), {
          reason,
        });
      }
      const workers = Array.from(
        { length: Math.min(this.settings.maxConcurrentChecks, Math.max(1, queue.length)) },
        async () => {
          while (queue.length) {
            const definition = queue.shift();
            if (!definition) break;
            try {
              results.push(await this.checkOne(definition, reason));
            } catch (error) {
              const summary = truncate(sanitizeWatchErrorMessage(error), 240);
              logger.failure("Check", "watch:unhandled-rejection", new Error(summary), {
                reason,
                path: definition.path,
                provider: definition.provider,
              });
              results.push({
                watchId: definition.id,
                path: definition.path,
                outcome: "failed",
                error: summary,
              });
            }
          }
        },
      );
      await Promise.all(workers);
      try {
        await this.refreshViews();
      } catch (error) {
        logger.failure("Check", "batch:view-refresh-failed", new Error(sanitizeWatchErrorMessage(error)), {
          reason,
          checked: results.length,
        });
      }
      logger.flow("Check", "batch:done", {
        reason,
        durationMs: Date.now() - started,
        checked: results.length,
        events: results.filter((result) => result.outcome === "event"
          || (result.sideEffectsCommitted && Boolean(result.eventId))).length,
        failures: results.filter((result) => result.outcome === "failed").length,
        baselines: results.filter((result) => result.outcome === "baseline").length,
        identityBlocked: results.filter((result) => result.code === "duplicate-watch-id").length,
        definitionChanged: results.filter((result) => result.code === "watch-definition-changed").length,
      });
      return results;
    } finally {
      this.batchInFlight = false;
    }
  }

  private async checkOne(
    inputDefinition: WatchDefinition,
    reason: string,
    allowCatalogOverlay = false,
  ): Promise<WatchCheckResult> {
    const path = normalizePath(inputDefinition.path);
    const trustedCatalogOverlays = new Map<string, TrustedCatalogOverlay>();
    let liveOverlay: StableLiveWatchDefinition | null = null;
    if (allowCatalogOverlay) {
      liveOverlay = await this.captureStableLiveWatchDefinition(path);
      if (!liveOverlay) return this.watchDefinitionChangedResult(inputDefinition, reason, false);
      trustedCatalogOverlays.set(path, this.createTrustedCatalogOverlay(
        path,
        liveOverlay.definition,
        liveOverlay.pendingRevision,
      ));
    }
    if (!this.watchCatalogReady
      || this.hasUntrustedCatalogPending(trustedCatalogOverlays)) {
      return this.watchDefinitionChangedResult(inputDefinition, reason, false);
    }
    const snapshot = this.getIdentitySnapshot();
    const catalogDefinition = snapshot.definitionsByPath.get(path);
    const definition = liveOverlay?.definition || catalogDefinition;
    if (!definition || (!liveOverlay && catalogDefinition
      && watchDefinitionSignature(catalogDefinition) !== watchDefinitionSignature(inputDefinition))) {
      return this.watchDefinitionChangedResult(inputDefinition, reason, false);
    }
    const effectiveDuplicates = trustedCatalogOverlays.size
      ? this.getDuplicateWatchIdPathsWithOverlays(snapshot, trustedCatalogOverlays)
      : snapshot.duplicatePathsById;
    try {
      await this.quarantineDuplicateIdentities(effectiveDuplicates, "check-preflight");
    } catch (error) {
      return this.identitySafetyPersistenceFailureResult(inputDefinition, reason, false, error);
    }
    if (snapshot.revision !== this.watchCatalogRevision
      || this.hasUntrustedCatalogPending(trustedCatalogOverlays)) {
      return this.watchDefinitionChangedResult(definition, reason, false);
    }
    const conflictingPaths = definition.hasDurableId === false
      ? []
      : effectiveDuplicates.get(definition.id) || [];
    if (conflictingPaths.length > 1) {
      return await this.duplicateWatchIdResult(definition, conflictingPaths, reason, false);
    }
    const file = liveOverlay?.file || this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      return this.watchDefinitionChangedResult(definition, reason, false);
    }
    const signature = watchDefinitionSignature(definition);
    const flightKey = path + "|" + signature;
    const flight = joinSingleFlight(
      this.checksInFlight,
      flightKey,
      () => this.performCheckOne(
        definition,
        reason,
        liveOverlay?.expectedMtime ?? file.stat.mtime,
        liveOverlay?.ownerKey || this.getFileOwnerKey(file),
        trustedCatalogOverlays,
      ),
    );
    if (flight.joined) {
      logger.flow("Check", "watch:joined-in-flight", {
        reason,
        path,
        provider: definition.provider,
        definitionSignatureHash: stableHash(signature),
      });
    }
    return await flight.promise;
  }

  private async performCheckOne(
    inputDefinition: WatchDefinition,
    reason: string,
    initialMtime: number,
    ownerKey: string,
    trustedCatalogOverlays: Map<string, TrustedCatalogOverlay>,
  ): Promise<WatchCheckResult> {
    let definition = inputDefinition;
    let prepared: PreparedWatchIdentity | null = null;
    let identityLease: WatchIdentityLease | null = null;
    let previous = createEmptyState();
    let providerAttempted = false;
    let providerResultAccepted = false;
    const effects = createWatchEffectJournal();
    try {
      prepared = await this.ensureWatchIdentity(
        inputDefinition,
        initialMtime,
        ownerKey,
        trustedCatalogOverlays,
        effects,
      );
      definition = prepared.definition;
      const ownershipFailure = await this.identityOwnershipFailure(prepared, null, reason, false);
      if (ownershipFailure) return this.withEffectJournal(ownershipFailure, effects);

      identityLease = this.identityLeases.acquire(definition.id, prepared.ownerKey, definition.path);
      if (identityLease.conflicted) {
        return this.withEffectJournal(await this.duplicateWatchIdResult(
          definition,
          Array.from(identityLease.conflictPaths),
          reason,
          false,
        ), effects);
      }
      const leasedOwnershipFailure = await this.identityOwnershipFailure(prepared, identityLease, reason, false);
      if (leasedOwnershipFailure) return this.withEffectJournal(leasedOwnershipFailure, effects);
      await this.ensureQuarantinePersisted();
      const persistedQuarantineOwnershipFailure = await this.identityOwnershipFailure(
        prepared,
        identityLease,
        reason,
        false,
      );
      if (persistedQuarantineOwnershipFailure) {
        return this.withEffectJournal(persistedQuarantineOwnershipFailure, effects);
      }

      const validation = validateDefinition(definition);
      if (validation.length) throw new Error("Invalid watch: " + validation.join("; "));
      let evaluationState = this.getEvaluationState(definition, prepared.migration);
      previous = evaluationState.state;
      logger.flow("Check", "watch:start", {
        reason,
        path: definition.path,
        provider: definition.provider,
        condition: definition.condition,
        baselineReady: previous.baselineReady,
        failureCount: previous.failureCount,
        stateTrusted: evaluationState.trusted,
      });

      let observation: WatchObservation;
      try {
        providerAttempted = true;
        observation = await fetchWatchObservation(
          definition,
          this.settings.requestTimeoutSeconds * 1000,
        );
      } catch (error) {
        const providerFailureOwnership = await this.identityOwnershipFailure(
          prepared,
          identityLease,
          reason,
          true,
        );
        if (providerFailureOwnership) return this.withEffectJournal(providerFailureOwnership, effects);
        evaluationState = this.getEvaluationState(definition, prepared.migration);
        previous = evaluationState.state;
        return await this.handleFailure(
          definition,
          error,
          reason,
          previous,
          prepared.migration,
          true,
          prepared,
          identityLease,
          effects,
        );
      }

      const commitOwnershipFailure = await this.identityOwnershipFailure(
        prepared,
        identityLease,
        reason,
        true,
      );
      if (commitOwnershipFailure) return this.withEffectJournal(commitOwnershipFailure, effects);
      evaluationState = this.getEvaluationState(definition, prepared.migration);
      previous = evaluationState.state;
      providerResultAccepted = true;
      const evaluation = evaluateObservation(definition, observation, previous);
      const fingerprintMigrated = definition.condition === "new-item"
        && previous.baselineReady
        && Boolean(previous.lastFingerprint)
        && previous.fingerprintVersion < WATCH_FINGERPRINT_VERSION;
      if (fingerprintMigrated) {
        logger.flow("Check", "watch:new-item-baseline-migrated", {
          path: definition.path,
          fromVersion: previous.fingerprintVersion,
          toVersion: WATCH_FINGERPRINT_VERSION,
        });
      }
      let outcome: WatchCheckResult["outcome"] = evaluation.eventKind === "baseline" ? "baseline" : "unchanged";
      let eventId = "";
      let appended = false;
      let eventPresent = false;
      if (evaluation.shouldEmit) {
        eventId = createEventId(
          definition.id,
          observation,
          evaluation.eventKind,
          watchEventTransitionKey(previous),
        );
        const eventWrite = await this.appendWatchEvent(
          definition,
          observation,
          evaluation.eventKind,
          eventId,
          evaluation.reason,
          previous.lastValue,
          effects,
        );
        appended = eventWrite.appended;
        eventPresent = true;
        await this.trustExactCatalogMutation(prepared, eventWrite);
        if (appended) {
          outcome = "event";
        }
        const postEventOwnershipFailure = await this.identityOwnershipFailure(
          prepared,
          identityLease,
          reason,
          true,
          appended,
        );
        if (postEventOwnershipFailure) {
          return this.withEffectJournal(postEventOwnershipFailure, effects);
        }
      }
      const nextState: WatchState = {
        ...previous,
        fingerprintVersion: WATCH_FINGERPRINT_VERSION,
        baselineReady: true,
        lastFingerprint: observation.fingerprint,
        lastValue: observation.displayValue,
        lastMatched: evaluation.matched,
        lastCheckedAt: observation.observedAt,
        lastEventAt: eventPresent ? observation.observedAt : previous.lastEventAt,
        lastEventId: eventPresent ? eventId : previous.lastEventId,
        failureCount: 0,
        lastError: "",
        lastErrorNotifiedAt: "",
      };
      let notification: WatchNotificationSummary | undefined;
      if (eventPresent && definition.notify) {
        let postPersistOwnershipFailure: WatchCheckResult | null = null;
        let postNotificationOwnershipFailure: WatchCheckResult | null = null;
        const execution = await executeNotificationDelivery<WatchCheckResult>({
          prepare: async () => {
            const plan = await this.commitWatchStateAndPrepareNotification(
              definition,
              nextState,
              prepared!.migration,
              !identityLease!.conflicted,
              { eventId, kind: "watch-event", eventAppended: appended },
            );
            recordWatchCommittedEffect(effects);
            return plan;
          },
          revalidateBeforeSend: async () => {
            postPersistOwnershipFailure = await this.identityOwnershipFailure(
              prepared!,
              identityLease,
              reason,
              true,
              true,
            );
            return postPersistOwnershipFailure;
          },
          send: async () => await this.deliverNotification(
            "Watch triggered: " + definition.title,
            eventSummary(evaluation.eventKind, observation.displayValue, previous.lastValue),
            definition.path,
          ),
          settle: async (attemptId, settlement) => await this.settleNotificationAttemptDurably(
            eventId,
            attemptId,
            settlement,
          ),
          revalidateAfterSend: async () => {
            postNotificationOwnershipFailure = await this.identityOwnershipFailure(
              prepared!,
              identityLease,
              reason,
              true,
              true,
            );
            return postNotificationOwnershipFailure;
          },
        });
        notification = execution.notification;
        if (execution.settlementError) {
          logger.failure(
            "Notification",
            "ledger:settlement-persist-failed",
            new Error(sanitizeWatchErrorMessage(execution.settlementError)),
            { watchPath: definition.path, eventId },
          );
        }
        if (execution.conflict) {
          return this.withEffectJournal({ ...execution.conflict, notification }, effects);
        }
      } else {
        await this.commitWatchStateDurably(
          definition,
          nextState,
          prepared.migration,
          !identityLease.conflicted,
        );
        recordWatchCommittedEffect(effects);
        const postPersistOwnershipFailure = await this.identityOwnershipFailure(
          prepared,
          identityLease,
          reason,
          true,
          true,
        );
        if (postPersistOwnershipFailure) {
          return this.withEffectJournal(postPersistOwnershipFailure, effects);
        }
      }
      logger.flow("Check", "watch:done", {
        reason,
        path: definition.path,
        outcome,
        matched: evaluation.matched,
        changed: observation.fingerprint !== previous.lastFingerprint,
        eventWritten: appended,
      });
      return this.withEffectJournal({
        watchId: definition.id,
        path: definition.path,
        outcome,
        eventId: appended ? eventId : undefined,
        attempted: true,
        notification,
      }, effects);
    } catch (error) {
      if (error instanceof WatchDefinitionChangedError) {
        return this.withEffectJournal(
          this.watchDefinitionChangedResult(definition, reason, providerAttempted, effects.committed),
          effects,
        );
      }
      if (!prepared) {
        const summary = truncate(sanitizeWatchErrorMessage(error), 240);
        let resultError = summary;
        let resultCode: WatchCheckResult["code"];
        logger.failure("Check", "watch:prepare-failed", new Error(summary), {
          reason,
          path: definition.path,
        });
        if (definition.hasDurableId === false) {
          try {
            await this.recordTransientPreparationFailure(definition.path, summary);
            recordWatchCommittedEffect(effects);
          } catch (persistError) {
            const persistSummary = truncate(sanitizeWatchErrorMessage(persistError), 180);
            resultError += " Preparation health was not persisted: " + persistSummary;
            resultCode = "state-persistence-failed";
            logger.failure("Identity", "transient-failure:persist-failed", new Error(persistSummary), {
              path: definition.path,
            });
          }
        }
        return this.withEffectJournal({
          watchId: definition.id,
          path: definition.path,
          outcome: "failed",
          error: resultError,
          code: resultCode,
          attempted: providerAttempted,
        }, effects);
      }
      const failureOwnership = await this.identityOwnershipFailure(
        prepared,
        identityLease,
        reason,
        providerAttempted,
        effects.committed,
      );
      if (failureOwnership) return this.withEffectJournal(failureOwnership, effects);
      if (providerResultAccepted) {
        const summary = truncate(sanitizeWatchErrorMessage(error), 240);
        logger.failure("Check", "watch:commit-failed", new Error(summary), {
          reason,
          path: definition.path,
          provider: definition.provider,
          sideEffectsCommitted: effects.committed,
          eventId: effects.eventId,
        });
        return this.withEffectJournal({
          watchId: definition.id,
          path: definition.path,
          outcome: "failed",
          error: "The provider result was accepted, but the check could not finish safely: " + summary,
          code: error instanceof WatchStatePersistenceError ? "state-persistence-failed" : undefined,
          attempted: providerAttempted,
        }, effects);
      }
      return await this.handleFailure(
        definition,
        error,
        reason,
        previous,
        prepared.migration,
        providerAttempted,
        prepared,
        identityLease,
        effects,
      );
    } finally {
      if (identityLease && prepared) this.identityLeases.release(identityLease, prepared.ownerKey);
    }
  }

  private getDuplicateWatchIdPathsWithOverlays(
    snapshot: WatchIdentitySnapshot,
    overlays: ReadonlyMap<string, TrustedCatalogOverlay>,
  ): Map<string, string[]> {
    const active = this.getActiveCatalogDefinitionOverlays(overlays);
    return findDuplicateWatchIdPaths(applyWatchDefinitionOverlays(snapshot.definitions, active));
  }

  private createTrustedCatalogOverlay(
    path: string,
    definition: WatchDefinition | null,
    revision?: number,
  ): TrustedCatalogOverlay {
    const file = this.app.vault.getAbstractFileByPath(path);
    const cachedDefinition = file instanceof TFile ? this.definitionFromFile(file) : null;
    let effectiveRevision = revision;
    if (watchDefinitionSignatureOrEmpty(cachedDefinition)
      !== watchDefinitionSignatureOrEmpty(definition)
      && effectiveRevision == null) {
      effectiveRevision = this.catalogSettlements.markPending(path);
      this.invalidateWatchCatalog();
      this.requestCatalogRecovery("verified-live-overlay");
    }
    return { revision: effectiveRevision, definition };
  }

  private async trustExactCatalogMutation(
    prepared: PreparedWatchIdentity,
    write: WatchEventWriteResult,
  ): Promise<void> {
    const { targetFile: file, targetPath: path } = write;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let revision = this.catalogSettlements.getRevision(path);
      if (write.appended && revision == null) {
        revision = this.catalogSettlements.markPending(path);
        this.invalidateWatchCatalog();
      }
      const ownerKey = this.getFileOwnerKey(file);
      const expectedMtime = file.stat.mtime;
      const liveData = await this.app.vault.read(file);
      if (this.unloading) throw new WatchDefinitionChangedError();
      const current = this.app.vault.getAbstractFileByPath(path);
      if (current !== file
        || this.getFileOwnerKey(file) !== ownerKey
        || file.stat.mtime !== expectedMtime
        || liveData !== write.contentAfterWrite) {
        throw new WatchDefinitionChangedError();
      }
      if (this.catalogSettlements.getRevision(path) !== revision) continue;
      const liveDefinition = this.definitionFromData(file, liveData);
      if (path === prepared.definition.path) {
        if (ownerKey !== prepared.ownerKey
          || watchDefinitionSignatureOrEmpty(liveDefinition)
            !== watchDefinitionSignature(prepared.definition)) {
          throw new WatchDefinitionChangedError();
        }
        prepared.expectedMtime = expectedMtime;
      } else if (liveDefinition) {
        throw new WatchDefinitionChangedError();
      }
      const cachedDefinition = this.definitionFromFile(file);
      if (watchDefinitionSignatureOrEmpty(cachedDefinition)
        === watchDefinitionSignatureOrEmpty(liveDefinition)) {
        if (revision != null) {
          if (!this.catalogSettlements.settle(path, revision)) continue;
          this.invalidateWatchCatalog();
        }
        prepared.trustedCatalogOverlays.delete(path);
        if (liveDefinition) this.knownWatchPaths.add(path);
        else this.knownWatchPaths.delete(path);
        return;
      }
      if (revision == null) {
        this.catalogSettlements.markPending(path);
        this.invalidateWatchCatalog();
        continue;
      }
      prepared.trustedCatalogOverlays.set(path, { revision, definition: liveDefinition });
      this.requestCatalogRecovery("exact-write-cache-pending");
      return;
    }
    throw new WatchDefinitionChangedError();
  }

  private withEffectJournal(
    result: WatchCheckResult,
    effects: WatchEffectJournal,
  ): WatchCheckResult {
    return applyWatchEffectJournal(result, effects);
  }

  private async identityOwnershipFailure(
    prepared: PreparedWatchIdentity,
    lease: WatchIdentityLease | null,
    reason: string,
    attempted: boolean,
    sideEffectsMayHaveCommitted = false,
  ): Promise<WatchCheckResult | null> {
    const { definition } = prepared;
    if (!this.watchCatalogReady
      || this.hasUntrustedCatalogPending(prepared.trustedCatalogOverlays)) {
      return this.watchDefinitionChangedResult(definition, reason, attempted, sideEffectsMayHaveCommitted);
    }
    const file = this.app.vault.getAbstractFileByPath(definition.path);
    if (!(file instanceof TFile)
      || this.getFileOwnerKey(file) !== prepared.ownerKey
      || file.stat.mtime !== prepared.expectedMtime) {
      return this.watchDefinitionChangedResult(definition, reason, attempted, sideEffectsMayHaveCommitted);
    }
    const snapshot = this.getIdentitySnapshot();
    const catalogDefinition = snapshot.definitionsByPath.get(definition.path);
    const catalogSignature = catalogDefinition ? watchDefinitionSignature(catalogDefinition) : "";
    const expectedSignature = watchDefinitionSignature(definition);
    const activeOverlays = this.getActiveCatalogDefinitionOverlays(prepared.trustedCatalogOverlays);
    const sourceOverlay = activeOverlays.get(definition.path);
    const usingTrustedOverlay = Boolean(sourceOverlay
      && watchDefinitionSignature(sourceOverlay) === expectedSignature);
    if (catalogSignature !== expectedSignature && !usingTrustedOverlay) {
      return this.watchDefinitionChangedResult(definition, reason, attempted, sideEffectsMayHaveCommitted);
    }
    const effectiveDuplicates = activeOverlays.size
      ? findDuplicateWatchIdPaths(applyWatchDefinitionOverlays(snapshot.definitions, activeOverlays))
      : snapshot.duplicatePathsById;
    try {
      await this.quarantineDuplicateIdentities(effectiveDuplicates, "ownership-check");
    } catch (error) {
      return this.identitySafetyPersistenceFailureResult(
        definition,
        reason,
        attempted,
        error,
        sideEffectsMayHaveCommitted,
      );
    }
    const currentFile = this.app.vault.getAbstractFileByPath(definition.path);
    if (!this.watchCatalogReady
      || this.hasUntrustedCatalogPending(prepared.trustedCatalogOverlays)
      || currentFile !== file
      || !(currentFile instanceof TFile)
      || this.getFileOwnerKey(currentFile) !== prepared.ownerKey
      || currentFile.stat.mtime !== prepared.expectedMtime
      || snapshot.revision !== this.watchCatalogRevision) {
      return this.watchDefinitionChangedResult(definition, reason, attempted, sideEffectsMayHaveCommitted);
    }
    const conflictingPaths = effectiveDuplicates.get(definition.id) || [];
    if (conflictingPaths.length > 1) {
      return await this.duplicateWatchIdResult(
        definition,
        conflictingPaths,
        reason,
        attempted,
        sideEffectsMayHaveCommitted,
      );
    }
    if (lease?.conflicted) {
      return await this.duplicateWatchIdResult(
        definition,
        Array.from(lease.conflictPaths),
        reason,
        attempted,
        sideEffectsMayHaveCommitted,
      );
    }
    return null;
  }

  private async duplicateWatchIdResult(
    definition: WatchDefinition,
    conflictingPaths: readonly string[],
    reason: string,
    attempted: boolean,
    sideEffectsMayHaveCommitted = false,
    eventId?: string,
  ): Promise<WatchCheckResult> {
    const paths = Array.from(new Set(conflictingPaths)).sort((left, right) => left.localeCompare(right));
    try {
      await this.quarantineDuplicateIdentities(new Map([[definition.id, paths]]), "blocked-check");
    } catch (error) {
      return this.identitySafetyPersistenceFailureResult(
        definition,
        reason,
        attempted,
        error,
        sideEffectsMayHaveCommitted,
        eventId,
      );
    }
    const phase = sideEffectsMayHaveCommitted
      ? " The conflict appeared after this check crossed its commit boundary. Any idempotent event or notification already completed is retained, but the identity is quarantined and its next repaired check will establish a new silent baseline."
      : attempted
      ? " A provider request had already started, but its result was discarded before observation/failure state, event, or notification commit; the identity quarantine was persisted."
      : " No provider request, observation evaluation, event, or notification was performed; only the identity quarantine was persisted.";
    const error = duplicateWatchIdError(definition.id, paths) + phase;
    logger.warn("Identity", "duplicate:blocked", {
      reason,
      watchId: definition.id,
      path: definition.path,
      pathCount: paths.length,
      paths: paths.slice(0, 5),
      checksBlocked: true,
      providerAttempted: attempted,
      sideEffectsMayHaveCommitted,
    });
    return {
      watchId: definition.id,
      path: definition.path,
      outcome: "skipped",
      error,
      code: "duplicate-watch-id",
      conflictingPaths: paths,
      attempted,
      sideEffectsCommitted: sideEffectsMayHaveCommitted || undefined,
      eventId,
    };
  }

  private identitySafetyPersistenceFailureResult(
    definition: WatchDefinition,
    reason: string,
    attempted: boolean,
    error: unknown,
    sideEffectsCommitted = false,
    eventId?: string,
  ): WatchCheckResult {
    const summary = truncate(sanitizeWatchErrorMessage(error), 180);
    logger.failure("Identity", "safety-persistence:blocked", new Error(summary), {
      reason,
      path: definition.path,
      watchId: definition.id,
      providerAttempted: attempted,
      sideEffectsCommitted,
    });
    return {
      watchId: definition.id,
      path: definition.path,
      outcome: "failed",
      error: "Identity safety state could not be persisted, so the watch was stopped: " + summary,
      attempted,
      sideEffectsCommitted: sideEffectsCommitted || undefined,
      eventId,
    };
  }

  private watchDefinitionChangedResult(
    definition: WatchDefinition,
    reason: string,
    attempted: boolean,
    sideEffectsMayHaveCommitted = false,
  ): WatchCheckResult {
    const error = sideEffectsMayHaveCommitted
      ? "The watch definition or vault watch catalog changed after this check crossed its commit boundary. Work already completed is retained, and the next check will use the settled definition."
      : attempted
      ? "The watch definition or vault watch catalog changed while its provider request was in progress. The provider result was discarded before this watch committed state, an event, or a notification. Identity-safety quarantine bookkeeping may still have been persisted. Run the check again after metadata settles."
      : "The watch definition or vault watch catalog changed or is still resolving. No provider request, evaluation, event, or notification was performed for this watch; identity-safety quarantine bookkeeping for detected duplicates may still have been persisted. Run the check again after metadata settles.";
    logger.warn("Check", "watch:definition-changed", {
      reason,
      path: definition.path,
      watchId: definition.id,
      providerAttempted: attempted,
    });
    return {
      watchId: definition.id,
      path: definition.path,
      outcome: "skipped",
      error,
      code: "watch-definition-changed",
      attempted,
      sideEffectsCommitted: sideEffectsMayHaveCommitted || undefined,
    };
  }

  private applyWatchStateCommitToModel(
    model: PersistentWatchStateModel,
    definition: WatchDefinition,
    state: WatchState,
    migration: WatchStateMigrationPlan,
    establishTrustedBaseline: boolean,
    durableIds: ReadonlySet<string>,
  ): void {
    const effectiveMigration = { ...migration };
    if (establishTrustedBaseline && model.quarantinedWatchPaths.has(definition.path)) {
      if (Object.prototype.hasOwnProperty.call(model.transientStates, definition.path)) {
        effectiveMigration.transientPath = definition.path;
      }
      const legacyStateKey = "path:" + definition.path;
      if (legacyStateKey !== definition.id
        && !durableIds.has(legacyStateKey)
        && Object.prototype.hasOwnProperty.call(model.states, legacyStateKey)) {
        effectiveMigration.legacyStateKey = legacyStateKey;
      }
    }
    applyWatchStateCommit(
      model.states,
      model.transientStates,
      model.quarantinedWatchIds,
      model.quarantinedWatchPaths,
      definition,
      state,
      effectiveMigration,
      establishTrustedBaseline,
    );
  }

  private async commitWatchStateDurably(
    definition: WatchDefinition,
    state: WatchState,
    migration: WatchStateMigrationPlan,
    establishTrustedBaseline: boolean,
  ): Promise<void> {
    const durableIds = new Set(this.getIdentitySnapshot().durableIds);
    try {
      await this.mutatePersistentWatchState((draft) => {
        this.applyWatchStateCommitToModel(
          draft,
          definition,
          { ...state },
          migration,
          establishTrustedBaseline,
          durableIds,
        );
        return { changed: true, value: undefined };
      });
    } catch (error) {
      if (error instanceof WatchDefinitionChangedError) throw error;
      throw new WatchStatePersistenceError(sanitizeWatchErrorMessage(error));
    }
  }

  private async commitWatchStateAndPrepareNotification(
    definition: WatchDefinition,
    state: WatchState,
    migration: WatchStateMigrationPlan,
    establishTrustedBaseline: boolean,
    notification: PendingNotificationCommit,
  ): Promise<NotificationDeliveryPlan> {
    const durableIds = new Set(this.getIdentitySnapshot().durableIds);
    const input: PrepareNotificationInput = {
      eventId: notification.eventId,
      watchId: definition.id,
      kind: notification.kind,
      eventAppended: notification.eventAppended,
      attemptId: createLocalId("notification-attempt"),
      now: new Date().toISOString(),
    };
    try {
      const plan = await this.mutatePersistentWatchState((draft) => {
        this.applyWatchStateCommitToModel(
          draft,
          definition,
          { ...state },
          migration,
          establishTrustedBaseline,
          durableIds,
        );
        const prepared = draft.notificationLedgerBlockedReason
          ? blockedNotificationPlan(input)
          : prepareNotificationDelivery(draft.notificationDeliveries, input);
        return { changed: true, value: prepared };
      });
      if (plan.prunedEventIds.length) {
        logger.flow("Notification", "ledger:pruned", { count: plan.prunedEventIds.length });
      }
      if (this.notificationLedgerBlockedReason) {
        logger.warn("Notification", "ledger:blocked", {
          watchPath: definition.path,
          eventId: notification.eventId,
          reason: this.notificationLedgerBlockedReason,
        });
      }
      return plan;
    } catch (error) {
      if (error instanceof WatchDefinitionChangedError) throw error;
      throw new WatchStatePersistenceError(sanitizeWatchErrorMessage(error));
    }
  }

  private async settleNotificationAttemptDurably(
    eventId: string,
    attemptId: string,
    settlement: NotificationSettlement,
  ): Promise<WatchNotificationSummary> {
    return await this.mutatePersistentWatchState((draft) => {
      if (draft.notificationLedgerBlockedReason) {
        throw new Error("Notification ledger is blocked and cannot accept delivery results.");
      }
      const result = settleNotificationAttempt(
        draft.notificationDeliveries,
        eventId,
        attemptId,
        settlement,
        new Date().toISOString(),
      );
      if (!result.record) throw new Error("The notification attempt record is missing.");
      return {
        changed: result.changed,
        value: notificationSummary(result.record),
      };
    });
  }

  private async markFailureNotificationAccepted(
    definition: WatchDefinition,
    expectedState: WatchState,
    acceptedAt: string,
  ): Promise<void> {
    await this.mutatePersistentWatchState((draft) => {
      const current = draft.states[definition.id];
      if (!current
        || current.lastCheckedAt !== expectedState.lastCheckedAt
        || current.failureCount !== expectedState.failureCount
        || current.lastError !== expectedState.lastError
        || current.lastErrorNotifiedAt === acceptedAt) {
        return { changed: false, value: undefined };
      }
      draft.states[definition.id] = { ...current, lastErrorNotifiedAt: acceptedAt };
      return { changed: true, value: undefined };
    });
  }

  private async ensureQuarantinePersisted(): Promise<void> {
    await this.quarantinePersistBarrier;
    if (!this.pendingQuarantineIds.size
      && !this.pendingQuarantinePaths.size
      && !this.pendingPathStateMoves.length) return;
    const persist = this.persistPendingIdentitySafetyState("safety-barrier-retry");
    this.trackIdentitySafetyPersistence(persist);
    await persist;
  }

  private async recordTransientPreparationFailure(path: string, summary: string): Promise<void> {
    await this.mutatePersistentWatchState((draft) => {
      const previous = draft.transientStates[path] || createEmptyState();
      draft.transientStates[path] = {
        ...previous,
        lastCheckedAt: new Date().toISOString(),
        failureCount: previous.failureCount + 1,
        lastError: summary,
      };
      return { changed: true, value: undefined };
    });
  }

  private async handleFailure(
    definition: WatchDefinition,
    error: unknown,
    reason: string,
    previous: WatchState,
    migration: WatchStateMigrationPlan,
    providerAttempted: boolean,
    prepared: PreparedWatchIdentity,
    identityLease: WatchIdentityLease | null,
    effects: WatchEffectJournal,
  ): Promise<WatchCheckResult> {
    const summary = truncate(sanitizeWatchErrorMessage(error), 240);
    const failureCount = previous.failureCount + 1;
    const failedAt = new Date().toISOString();
    let failureEscalationFailed = false;
    let failureEventId = "";
    let failureEventAppended = false;
    let failureEventPresent = false;
    let notification: WatchNotificationSummary | undefined;
    let notificationPersistenceFailure = "";
    logger.failure("Check", "watch:failed", new Error(summary), {
      reason,
      path: definition.path,
      provider: definition.provider,
      failureCount,
    });

    const initialFailureOwnership = await this.identityOwnershipFailure(
      prepared,
      identityLease,
      reason,
      providerAttempted,
      effects.committed,
    );
    if (initialFailureOwnership) return this.withEffectJournal(initialFailureOwnership, effects);

    try {
      if (failureCount === this.settings.failureAlertThreshold) {
        const observation: WatchObservation = {
          observedAt: failedAt,
          value: summary,
          displayValue: summary,
          numericValue: null,
          fingerprint: stableHash("error|" + summary),
          summary: "Check failed: " + summary,
        };
        failureEventId = createEventId(
          definition.id,
          observation,
          "error",
          watchEventTransitionKey(previous),
        );
        const eventWrite = await this.appendWatchEvent(
          definition,
          observation,
          "error",
          failureEventId,
          "The watch reached " + failureCount + " consecutive check failures.",
          "",
          effects,
        );
        failureEventAppended = eventWrite.appended;
        failureEventPresent = true;
        await this.trustExactCatalogMutation(prepared, eventWrite);
        const postEventOwnershipFailure = await this.identityOwnershipFailure(
          prepared,
          identityLease,
          reason,
          providerAttempted,
          effects.committed,
        );
        if (postEventOwnershipFailure) {
          return this.withEffectJournal(postEventOwnershipFailure, effects);
        }
      }
    } catch (escalationError) {
      failureEscalationFailed = true;
      logger.failure("Check", "failure-escalation:failed", new Error(sanitizeWatchErrorMessage(escalationError)), {
        reason,
        path: definition.path,
        provider: definition.provider,
        failureCount,
        willRetryAtThreshold: true,
      });
    }

    const preFailureStateOwnership = await this.identityOwnershipFailure(
      prepared,
      identityLease,
      reason,
      providerAttempted,
      effects.committed,
    );
    if (preFailureStateOwnership) {
      return this.withEffectJournal(preFailureStateOwnership, effects);
    }

    let persistenceFailure = "";
    try {
      const nextFailureState: WatchState = {
        ...previous,
        lastCheckedAt: failedAt,
        failureCount: failureEscalationFailed ? previous.failureCount : failureCount,
        lastError: summary,
        lastErrorNotifiedAt: previous.lastErrorNotifiedAt,
      };
      if (failureEventPresent && this.settings.notifyOnFailure && definition.notify) {
        let postFailureStateOwnership: WatchCheckResult | null = null;
        let postNotificationOwnershipFailure: WatchCheckResult | null = null;
        const execution = await executeNotificationDelivery<WatchCheckResult>({
          prepare: async () => {
            const plan = await this.commitWatchStateAndPrepareNotification(
              definition,
              nextFailureState,
              migration,
              false,
              { eventId: failureEventId, kind: "failure-alert", eventAppended: failureEventAppended },
            );
            recordWatchCommittedEffect(effects);
            return plan;
          },
          revalidateBeforeSend: async () => {
            postFailureStateOwnership = await this.identityOwnershipFailure(
              prepared,
              identityLease,
              reason,
              providerAttempted,
              effects.committed,
            );
            return postFailureStateOwnership;
          },
          send: async () => await this.deliverNotification(
            "Watch needs attention: " + definition.title,
            summary,
            definition.path,
          ),
          settle: async (attemptId, settlement) => await this.settleNotificationAttemptDurably(
            failureEventId,
            attemptId,
            settlement,
          ),
          revalidateAfterSend: async () => {
            postNotificationOwnershipFailure = await this.identityOwnershipFailure(
              prepared,
              identityLease,
              reason,
              providerAttempted,
              effects.committed,
            );
            return postNotificationOwnershipFailure;
          },
        });
        notification = execution.notification;
        if (execution.settlementError) {
          notificationPersistenceFailure = truncate(
            sanitizeWatchErrorMessage(execution.settlementError),
            180,
          );
          logger.failure(
            "Notification",
            "ledger:settlement-persist-failed",
            new Error(notificationPersistenceFailure),
            { watchPath: definition.path, eventId: failureEventId },
          );
        }
        if (execution.conflict) {
          return this.withEffectJournal({ ...execution.conflict, notification }, effects);
        }
        if (isDeliveredNotificationState(notification.state)) {
          try {
            await this.markFailureNotificationAccepted(
              definition,
              nextFailureState,
              notification.updatedAt,
            );
          } catch (acceptedStateError) {
            logger.failure(
              "Notification",
              "failure-accepted-state:persist-failed",
              new Error(sanitizeWatchErrorMessage(acceptedStateError)),
              { watchPath: definition.path, eventId: failureEventId },
            );
          }
          const postNotificationStateOwnershipFailure = await this.identityOwnershipFailure(
            prepared,
            identityLease,
            reason,
            providerAttempted,
            effects.committed,
          );
          if (postNotificationStateOwnershipFailure) {
            return this.withEffectJournal({ ...postNotificationStateOwnershipFailure, notification }, effects);
          }
        }
      } else {
        await this.commitWatchStateDurably(definition, nextFailureState, migration, false);
        recordWatchCommittedEffect(effects);
        const postFailureStateOwnership = await this.identityOwnershipFailure(
          prepared,
          identityLease,
          reason,
          providerAttempted,
          effects.committed,
        );
        if (postFailureStateOwnership) {
          return this.withEffectJournal(postFailureStateOwnership, effects);
        }
      }
    } catch (persistError) {
      persistenceFailure = truncate(sanitizeWatchErrorMessage(persistError), 180);
      logger.failure("Check", "failure-state:persist-failed", new Error(persistenceFailure), {
        reason,
        path: definition.path,
        provider: definition.provider,
        failureCount,
      });
    }
    try {
      await this.refreshViews();
    } catch (refreshError) {
      logger.failure("Check", "failure-state:view-refresh-failed", new Error(sanitizeWatchErrorMessage(refreshError)), {
        reason,
        path: definition.path,
        provider: definition.provider,
        failureCount,
      });
    }
    return this.withEffectJournal({
      watchId: definition.id,
      path: definition.path,
      outcome: "failed",
      error: persistenceFailure
        ? summary + " Failure health was not persisted: " + persistenceFailure
        : notificationPersistenceFailure
          ? summary + " Notification accounting remains unresolved: " + notificationPersistenceFailure
        : summary,
      code: persistenceFailure ? "state-persistence-failed" : undefined,
      attempted: providerAttempted,
      eventId: failureEventAppended ? failureEventId : undefined,
      notification,
    }, effects);
  }

  private async appendWatchEvent(
    definition: WatchDefinition,
    observation: WatchObservation,
    eventKind: string,
    eventId: string,
    reason: string,
    previousValue: string,
    effects: WatchEffectJournal,
  ): Promise<WatchEventWriteResult> {
    const watchFile = this.app.vault.getAbstractFileByPath(definition.path);
    if (!(watchFile instanceof TFile)) throw new Error("Watch source note disappeared before event write.");
    let target = watchFile;
    if (this.settings.eventLogTarget !== "watch-note") {
      target = await this.ensureDailyNote(localIsoDate(observation.observedAt));
    }
    const watchPath = safeWikiPath(definition.path.replace(/\.md$/i, ""));
    const alias = safeWikiAlias(definition.title);
    const visible = eventSummary(eventKind, observation.displayValue, previousValue);
    const fields = [
      "[type:: watchEvent]",
      "[watch:: [[" + watchPath + "]]]",
      "[event:: " + inlineValue(eventKind) + "]",
      "[value:: " + inlineValue(observation.displayValue) + "]",
      previousValue ? "[previousValue:: " + inlineValue(previousValue) + "]" : "",
      "[observedAt:: " + inlineValue(localDateTime(observation.observedAt)) + "]",
      "[watchEventId:: " + inlineValue(eventId) + "]",
      "[reason:: " + inlineValue(reason) + "]",
    ].filter(Boolean).join(" ");
    const line = "- [[" + watchPath + "|" + alias + "]]: " + markdownText(visible) + " <!-- " + fields + " -->";
    const marker = "[watchEventId:: " + eventId + "]";
    logger.flow("Event", "write:start", {
      eventId,
      eventKind,
      watchPath: definition.path,
      target: target.path,
      route: this.settings.eventLogTarget,
    });
    let appended = false;
    let contentAfterWrite = "";
    await this.app.vault.process(target, (current) => {
      const targetDefinition = this.definitionFromData(target, current);
      if (target.path === definition.path) {
        if (watchDefinitionSignatureOrEmpty(targetDefinition)
          !== watchDefinitionSignature(definition)) {
          throw new WatchDefinitionChangedError();
        }
      } else if (targetDefinition) {
        throw new WatchDefinitionChangedError();
      }
      const result = appendLineOnce(current, marker, line);
      appended = result.appended;
      contentAfterWrite = result.content;
      return result.content;
    });
    if (appended) {
      recordWatchCommittedEffect(effects, eventId);
    }
    this.reportWatchEventWrite(definition, target, eventId, eventKind, appended);
    return { appended, targetPath: target.path, targetFile: target, contentAfterWrite };
  }

  private reportWatchEventWrite(
    definition: WatchDefinition,
    target: TFile,
    eventId: string,
    eventKind: string,
    appended: boolean,
  ): void {
    try {
      if (appended) this.emitFilesUpdated([target.path, definition.path]);
      logger.flow("Event", appended ? "write:done" : "write:deduped", {
        eventId,
        eventKind,
        target: target.path,
        watchPath: definition.path,
      });
    } catch (error) {
      try {
        logger.failure("Event", "post-write-signal:failed", new Error(sanitizeWatchErrorMessage(error)), {
          eventId,
          target: target.path,
          watchPath: definition.path,
        });
      } catch {
        // The event is already durably appended; optional signaling cannot invalidate it.
      }
    }
  }

  private async deliverNotification(
    title: string,
    body: string,
    watchPath: string,
  ): Promise<TPSNotifierConsumerDeliveryResult> {
    const file = this.app.vault.getAbstractFileByPath(watchPath);
    logger.flow("Notification", "send:start", {
      watchPath,
      route: "tps-notifier-client",
    });
    const result = await this.notifierClient.send({
      title,
      body,
      file: file instanceof TFile ? file : undefined,
    });
    if (result.state === "not-attempted" && result.attempted === false) {
      try {
        new Notice(title + "\n" + body, 10000);
      } catch (error) {
        logger.failure("Notification", "local-notice:failed", error, { watchPath });
      }
    }
    logger.flow("Notification", "send:classified", {
      watchPath,
      state: result.state,
      transport: result.transport,
      evidence: result.evidence,
      attempted: result.attempted,
    });
    return result;
  }

  private definitionFromFile(file: TFile): WatchDefinition | null {
    const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter || {};
    return this.definitionFromFrontmatter(file, frontmatter);
  }

  private definitionFromData(file: TFile, data: string): WatchDefinition | null {
    try {
      const info = getFrontMatterInfo(data);
      if (!info.exists) return null;
      const parsed = parseYaml(info.frontmatter);
      const frontmatter = parsed && typeof parsed === "object"
        ? parsed as Record<string, unknown>
        : {};
      return this.definitionFromFrontmatter(file, frontmatter);
    } catch {
      return null;
    }
  }

  private async captureStableLiveWatchDefinition(path: string): Promise<StableLiveWatchDefinition | null> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile) || file.extension !== "md") return null;
    const ownerKey = this.getFileOwnerKey(file);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const expectedMtime = file.stat.mtime;
      const pendingRevision = this.catalogSettlements.getRevision(path);
      const data = await this.app.vault.read(file);
      const current = this.app.vault.getAbstractFileByPath(path);
      if (current !== file
        || this.getFileOwnerKey(file) !== ownerKey
        || file.stat.mtime !== expectedMtime) {
        return null;
      }
      if (this.catalogSettlements.getRevision(path) !== pendingRevision) continue;
      const definition = this.definitionFromData(file, data);
      if (!definition) return null;
      return { definition, file, expectedMtime, ownerKey, pendingRevision };
    }
    return null;
  }

  private definitionFromFrontmatter(
    file: TFile,
    frontmatter: Record<string, unknown>,
  ): WatchDefinition | null {
    if (normalizeText(frontmatter.kind).toLocaleLowerCase() !== "watch") return null;
    const url = scalar(frontmatter.source) || scalar(frontmatter.watchUrl);
    const jsonPath = scalar(frontmatter.watchJsonPath);
    const providerValue = normalizeText(frontmatter.watchProvider).toLocaleLowerCase() as WatchProvider;
    const provider = WATCH_PROVIDERS.includes(providerValue) ? providerValue : inferProvider(url, jsonPath);
    const conditionValue = normalizeText(frontmatter.watchCondition).toLocaleLowerCase() as WatchCondition;
    const condition = WATCH_CONDITIONS.includes(conditionValue)
      ? conditionValue
      : provider === "rss" ? "new-item" : "changed";
    const durableId = scalar(frontmatter.watchId);
    return {
      id: durableId || "path:" + file.path,
      hasDurableId: Boolean(durableId),
      path: file.path,
      title: scalar(frontmatter.title) || file.basename,
      provider,
      url,
      selector: scalar(frontmatter.watchSelector),
      jsonPath,
      pattern: scalar(frontmatter.watchPattern),
      query: scalar(frontmatter.watchQuery),
      condition,
      target: scalar(frontmatter.watchTarget),
      intervalMinutes: clampInteger(frontmatter.watchIntervalMinutes, this.settings.defaultIntervalMinutes, 1, 10080),
      notify: propertyBoolean(frontmatter.watchNotify, this.settings.defaultNotify),
      cooldownMinutes: clampInteger(frontmatter.watchCooldownMinutes, 0, 0, 10080),
      caseSensitive: propertyBoolean(frontmatter.watchCaseSensitive, false),
      status: scalar(frontmatter.status) || "working",
      tags: stringList(frontmatter.tags),
    };
  }

  private async ensureWatchIdentity(
    definition: WatchDefinition,
    initialMtime: number,
    ownerKey: string,
    trustedCatalogOverlays: Map<string, TrustedCatalogOverlay>,
    effects: WatchEffectJournal,
  ): Promise<PreparedWatchIdentity> {
    const file = this.app.vault.getAbstractFileByPath(definition.path);
    if (!(file instanceof TFile) || file.stat.mtime !== initialMtime) {
      throw new WatchDefinitionChangedError();
    }
    const snapshot = this.getIdentitySnapshot();
    const migration = this.getStateMigration(definition, snapshot);
    if (definition.hasDurableId !== false) {
      return {
        definition,
        migration,
        expectedMtime: initialMtime,
        ownerKey,
        trustedCatalogOverlays,
      };
    }
    const generatedId = this.createUniqueWatchId();
    let resolvedId = generatedId;
    let resolvedDefinition: WatchDefinition | null = null;
    let contentChanged = false;
    let identityWriteRequested = false;
    await this.processFrontmatter(file, (frontmatter) => {
      const liveDefinition = this.definitionFromFrontmatter(file, frontmatter);
      if (!liveDefinition
        || watchDefinitionContentSignature(liveDefinition) !== watchDefinitionContentSignature(definition)) {
        contentChanged = true;
        return;
      }
      const existingId = scalar(frontmatter.watchId);
      if (existingId) resolvedId = existingId;
      else {
        frontmatter.watchId = generatedId;
        identityWriteRequested = true;
      }
      resolvedDefinition = {
        ...liveDefinition,
        id: resolvedId,
        hasDurableId: true,
      };
    });
    if (identityWriteRequested) recordWatchIdentityWrite(effects, generatedId);
    if (contentChanged || !resolvedDefinition) throw new WatchDefinitionChangedError();
    const preparedDefinition = resolvedDefinition as WatchDefinition;
    const live = await this.captureStableLiveWatchDefinition(file.path);
    if (!live
      || live.ownerKey !== ownerKey
      || watchDefinitionSignature(live.definition) !== watchDefinitionSignature(preparedDefinition)) {
      throw new WatchDefinitionChangedError();
    }
    trustedCatalogOverlays.set(file.path, this.createTrustedCatalogOverlay(
      file.path,
      live.definition,
      live.pendingRevision,
    ));
    logger.flow("Identity", "assigned", {
      path: file.path,
      watchId: resolvedId,
      reusedExisting: resolvedId !== generatedId,
      stateMigrationPending: Boolean(migration.state),
    });
    return {
      definition: preparedDefinition,
      migration,
      expectedMtime: live.expectedMtime,
      ownerKey,
      trustedCatalogOverlays,
    };
  }

  private async processFrontmatter(
    file: TFile,
    mutator: (frontmatter: Record<string, unknown>) => void,
  ): Promise<void> {
    await this.app.fileManager.processFrontMatter(file, mutator);
    this.invalidateWatchCatalog();
  }

  private async applyGcmRules(file: TFile): Promise<void> {
    const gcm = this.getGcmApi();
    if (typeof gcm?.applyNotebookNavigatorRulesToFile === "function") {
      await gcm.applyNotebookNavigatorRulesToFile(file, {
        reason: "tps-watchlist-create",
        force: true,
        bypassCreationGrace: true,
      });
    }
  }

  private registerGcmActions(lifecycleEpoch: number): void {
    if (!this.isCurrentLifecycle(lifecycleEpoch)
      || this.unregisterGcmActions.length
      || this.gcmRegistrationBlocked) return;
    let register: any;
    try {
      register = this.getGcmApi()?.externalActions?.register;
    } catch (error) {
      logger.failure("GCM", "actions:register-failed", error, { route: "api-discovery" });
      return;
    }
    if (typeof register !== "function") {
      logger.warn("GCM", "actions:register-unavailable");
      return;
    }
    let executionLease!: TPSGcmActionExecutionLease;
    executionLease = new TPSGcmActionExecutionLease(() => (
      this.activeGcmActionExecutionLease === executionLease
      && this.isCurrentLifecycle(lifecycleEpoch)
    ));
    const visible = ({ file }: { file: TFile }) => {
      if (!executionLease.isExecutable()) return false;
      const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter || {};
      return normalizeText(frontmatter.kind).toLocaleLowerCase() === "watch";
    };
    const result = registerCallbacksTransactionally([
      () => register({
        id: "check-watch",
        pluginId: this.manifest.id,
        order: 32,
        icon: "refresh-cw",
        label: "Check watch now",
        title: "Fetch the source and evaluate this watch",
        isVisible: visible,
        onClick: async ({ file }: { file: TFile }) => {
          executionLease.assertExecutable();
          const checkResult = await this.checkPath(file.path, "gcm");
          if (checkResult.error) new Notice(checkResult.error);
        },
      }),
      () => register({
        id: "toggle-watch",
        pluginId: this.manifest.id,
        order: 33,
        icon: ({ file }: { file: TFile }) => {
          if (!executionLease.isExecutable()) return "play";
          const definition = this.definitionFromFile(file);
          return definition && isActiveStatus(definition.status) ? "pause" : "play";
        },
        label: ({ file }: { file: TFile }) => {
          if (!executionLease.isExecutable()) return "Resume watch";
          const definition = this.definitionFromFile(file);
          return definition && isActiveStatus(definition.status) ? "Pause watch" : "Resume watch";
        },
        title: "Pause or resume automatic monitoring",
        isVisible: visible,
        onClick: ({ file }: { file: TFile }) => {
          executionLease.assertExecutable();
          return this.toggleWatchStatus(file.path);
        },
      }),
      () => register({
        id: "open-watchlist",
        pluginId: this.manifest.id,
        order: 34,
        icon: "binoculars",
        label: "Open Watchlist",
        title: "Open the TPS Watchlist dashboard",
        isVisible: visible,
        onClick: () => {
          executionLease.assertExecutable();
          return this.openDashboard();
        },
      }),
    ], () => this.isCurrentLifecycle(lifecycleEpoch));
    if (result.status === "failed" || result.cleanupFailureCount > 0) {
      this.gcmRegistrationBlocked = true;
    }
    if (result.status === "registered") {
      executionLease.activate();
      this.activeGcmActionExecutionLease = executionLease;
      this.unregisterGcmActions.push(...result.callbacks);
      logger.flow("GCM", "actions:registered", { count: this.unregisterGcmActions.length });
    } else {
      executionLease.invalidate();
    }
    if (result.status === "failed") {
      logger.failure("GCM", "actions:register-failed", result.error, {
        attempted: result.registrationAttemptCount,
        cleanupAttempted: result.cleanupAttemptCount,
        cleanupFailed: result.cleanupFailureCount,
      });
    } else if (result.cleanupFailureCount > 0) {
      logger.warn("GCM", "actions:register-superseded-cleanup-incomplete", {
        attempted: result.registrationAttemptCount,
        cleanupAttempted: result.cleanupAttemptCount,
        cleanupFailed: result.cleanupFailureCount,
      });
    }
  }

  private invalidateGcmActionExecutionLease(): void {
    this.activeGcmActionExecutionLease?.invalidate();
    this.activeGcmActionExecutionLease = undefined;
  }

  private handleAiGatewayAvailability(api: Readonly<TPSAiGatewayApiSnapshot> | undefined): void {
    this.aiAvailabilityEpoch += 1;
    this.availableAiGatewayApi = api;
    this.invalidateAiCapabilityExecutionLease();
    if (this.unloading) {
      this.disposeAiCapabilityRegistrations("availability-after-unload");
      return;
    }
    if (!api) {
      this.disposeAiCapabilityRegistrations("provider-unavailable");
      logger.warn("AI", "capabilities:register-unavailable");
      return;
    }
    if (!this.isAiCapabilityPublicationReady()) {
      this.disposeAiCapabilityRegistrations("provider-change-before-readiness");
      logger.flow("AI", "capabilities:registration-deferred", {
        catalogReady: this.aiCatalogReady,
        integrationsReady: this.aiIntegrationsReady,
      });
      return;
    }
    this.registerAvailableAiCapabilities("provider-available");
  }

  private registerAvailableAiCapabilities(route: string): void {
    const api = this.availableAiGatewayApi;
    if (!api || !this.isAiCapabilityPublicationReady()) return;
    if (this.activeAiCapabilityExecutionLease) return;
    const availabilityEpoch = this.aiAvailabilityEpoch;
    const lifecycleEpoch = this.lifecycleEpoch;
    let executionLease!: TPSAiCapabilityExecutionLease;
    executionLease = new TPSAiCapabilityExecutionLease(() => (
      this.isAiCapabilityExecutionReady(executionLease, api, availabilityEpoch, lifecycleEpoch)
    ));
    const isCurrent = () => (
      !this.unloading
      && this.availableAiGatewayApi === api
      && availabilityEpoch === this.aiAvailabilityEpoch
      && lifecycleEpoch === this.lifecycleEpoch
      && this.isAiCapabilityPublicationReady()
    );
    const result = this.aiCapabilityRegistrations.synchronize(
      api,
      this.createAiCapabilityDescriptors(executionLease),
      isCurrent,
      () => this.invalidateAiCapabilityExecutionLease(),
    );
    if (result.status === "registered") {
      if (!isCurrent()) {
        executionLease.invalidate();
        this.disposeAiCapabilityRegistrations("registration-superseded-after-commit");
        return;
      }
      executionLease.activate();
      this.activeAiCapabilityExecutionLease = executionLease;
      logger.flow("AI", "capabilities:registered", {
        count: result.registeredCount,
        replacedPrevious: result.unregisterAttemptCount > 0,
        route,
      });
    } else if (result.status === "failed") {
      executionLease.invalidate();
      logger.failure("AI", "capabilities:register-failed", result.error, {
        cleanupAttempted: result.unregisterAttemptCount,
        cleanupBlocked: result.cleanupBlocked,
        route,
      });
    } else {
      executionLease.invalidate();
      if (result.status === "cleanup-failed") {
        logger.warn("AI", "capabilities:registration-blocked-by-cleanup", {
          attempted: result.unregisterAttemptCount,
          failed: result.unregisterFailureCount,
          route,
        });
      }
    }
  }

  private createAiCapabilityDescriptors(
    executionLease: TPSAiCapabilityExecutionLease,
  ): readonly TPSAiGatewayCapabilityRegistration[] {
    return [{
      id: "watchlist.create-watch",
      ownerPluginId: this.manifest.id,
      description: "Create a TPS watch note for a confirmed URL, extraction method, condition, and threshold.",
      requiresConfirmation: true,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["title", "url"],
        properties: {
          title: { type: "string" },
          url: { type: "string" },
          provider: { type: "string", enum: WATCH_PROVIDERS },
          selector: { type: "string" },
          jsonPath: { type: "string" },
          pattern: { type: "string" },
          query: { type: "string" },
          condition: { type: "string", enum: WATCH_CONDITIONS },
          target: { type: "string" },
          intervalMinutes: { type: "number" },
          notify: { type: "boolean" },
          cooldownMinutes: { type: "number" },
          caseSensitive: { type: "boolean" },
          tags: { type: "array", items: { type: "string" } },
        },
      },
      execute: async (input: CreateWatchInput) => {
        executionLease.assertExecutable();
        const file = await this.createWatch(input);
        return { path: file.path, watchId: this.definitionFromFile(file)?.id || "" };
      },
    }, {
      id: "watchlist.check-watch",
      ownerPluginId: this.manifest.id,
      description: "Run a confirmed check for one existing TPS watch note.",
      requiresConfirmation: true,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["path"],
        properties: { path: { type: "string" } },
      },
      execute: async (input: { path: string }) => {
        executionLease.assertExecutable();
        return await this.checkPath(input.path, "ai-capability");
      },
    }];
  }

  private isAiCapabilityPublicationReady(): boolean {
    return !this.unloading
      && this.aiIntegrationsReady
      && this.aiCatalogReady
      && this.catalogVaultEventsReady
      && this.watchCatalogReady
      && !this.hasUntrustedCatalogPending();
  }

  private isAiCapabilityExecutionReady(
    executionLease: TPSAiCapabilityExecutionLease,
    api: Readonly<TPSAiGatewayApiSnapshot>,
    availabilityEpoch: number,
    lifecycleEpoch: number,
  ): boolean {
    return this.activeAiCapabilityExecutionLease === executionLease
      && this.availableAiGatewayApi === api
      && availabilityEpoch === this.aiAvailabilityEpoch
      && lifecycleEpoch === this.lifecycleEpoch
      && this.isAiCapabilityPublicationReady();
  }

  private invalidateAiCapabilityExecutionLease(): void {
    this.activeAiCapabilityExecutionLease?.invalidate();
    this.activeAiCapabilityExecutionLease = undefined;
  }

  private disposeAiCapabilityRegistrations(route: string): void {
    this.invalidateAiCapabilityExecutionLease();
    const result = this.aiCapabilityRegistrations.dispose();
    if (result.cleanupBlocked) {
      logger.warn("AI", "capabilities:unregister-incomplete", {
        attempted: result.unregisterAttemptCount,
        failed: result.unregisterFailureCount,
        replacementBlocked: true,
        route,
      });
    } else if (result.unregisterAttemptCount > 0) {
      logger.flow("AI", "capabilities:unregistered", {
        count: result.unregisterAttemptCount,
        route,
      });
    }
  }

  private exposeApi(): void {
    this.api = {
      createWatch: async (input) => (await this.createWatch(input)).path,
      checkAll: (reason = "api") => this.checkAll(reason),
      checkPath: (path, reason = "api") => this.checkPath(path, reason),
      getWatches: () => this.getWatchRows(),
      ensureBases: () => this.ensureBases(),
      openDashboard: () => this.openDashboard(),
      getSettings: () => ({ ...this.settings }),
    };
    (this as any).api = this.api;
    (this.app as any).tpsWatchlist = this.api;
  }

  private async ensureDailyNote(isoDate: string): Promise<TFile> {
    const gcm = this.getGcmApi();
    if (typeof gcm?.dailyNotes?.ensureForIsoDate !== "function") {
      throw new Error("Daily-note event logging requires the TPS Global Context Menu daily-notes capability.");
    }
    const file = await gcm.dailyNotes.ensureForIsoDate(isoDate);
    if (!(file instanceof TFile)) {
      throw new Error("TPS Global Context Menu did not return a daily note file for " + isoDate + ".");
    }
    return file;
  }

  private async ensureBaseFile(pathValue: string, content: string): Promise<string> {
    const path = normalizePath(pathValue).replace(/^\/+/, "");
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) return existing.path;
    await this.ensureFolderForFile(path);
    const created = await this.app.vault.create(path, content);
    return created.path;
  }

  private async openBase(path: string): Promise<void> {
    await this.ensureBases();
    const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
    if (!(file instanceof TFile)) throw new Error("Base was not found: " + path);
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.openFile(file);
    this.app.workspace.revealLeaf(leaf);
  }

  private async ensureFolder(path: string): Promise<void> {
    let current = "";
    for (const segment of normalizePath(path).split("/").filter(Boolean)) {
      current = current ? current + "/" + segment : segment;
      if (!this.app.vault.getAbstractFileByPath(current)) await this.app.vault.createFolder(current);
    }
  }

  private async ensureFolderForFile(path: string): Promise<void> {
    const segments = normalizePath(path).split("/");
    segments.pop();
    if (segments.length) await this.ensureFolder(segments.join("/"));
  }

  private uniqueWatchPath(title: string): string {
    const filename = safeFilename(title) || "Watch";
    const folder = normalizePath(this.settings.defaultFolder).replace(/^\/+|\/+$/g, "");
    let index = 0;
    while (true) {
      const suffix = index ? " " + index : "";
      const path = normalizePath((folder ? folder + "/" : "") + filename + suffix + ".md");
      if (!this.app.vault.getAbstractFileByPath(path)) return path;
      index += 1;
    }
  }

  private createUniqueWatchId(): string {
    const durableIds = this.getIdentitySnapshot().durableIds;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const id = createLocalId("watch");
      if (!durableIds.has(id)
        && !Object.prototype.hasOwnProperty.call(this.states, id)
        && !this.quarantinedWatchIds.has(id)) {
        return id;
      }
    }
    throw new Error("Could not allocate a unique watch identity.");
  }

  private getActiveWatchFile(): TFile | null {
    const file = this.app.workspace.getActiveFile();
    return file && this.definitionFromFile(file) ? file : null;
  }

  private getFileOwnerKey(file: TFile): string {
    let key = this.fileOwnerKeys.get(file);
    if (!key) {
      key = "file-" + this.nextFileOwnerKey;
      this.nextFileOwnerKey += 1;
      this.fileOwnerKeys.set(file, key);
    }
    return key;
  }

  private getGcmApi(): any {
    return (this.app as any)?.plugins?.getPlugin?.("tps-global-context-menu")?.api || null;
  }

  private getControllerApi(): any {
    return (this.app as any)?.plugins?.getPlugin?.("tps-controller")?.api || null;
  }

  private emitFilesUpdated(paths: string[]): void {
    const gcm = this.getGcmApi();
    if (typeof gcm?.events?.emitFilesUpdated === "function") {
      gcm.events.emitFilesUpdated(paths, { sourcePluginId: this.manifest.id });
      return;
    }
    this.app.workspace.trigger("tps:files-updated" as any, {
      sourcePluginId: this.manifest.id,
      timestamp: Date.now(),
      paths,
    });
  }

  private async refreshViews(): Promise<void> {
    for (const leaf of this.app.workspace.getLeavesOfType(WATCHLIST_VIEW_TYPE)) {
      if (leaf.view instanceof WatchlistView) await leaf.view.render();
    }
  }

  private async loadPluginData(lifecycleEpoch: number): Promise<boolean> {
    const raw = await this.loadData() as Partial<PersistedWatchlistData> | null;
    if (!this.isCurrentLifecycle(lifecycleEpoch)) return false;
    this.settings = sanitizeSettings(raw?.settings || raw || {});
    this.states = createWatchStateRecord();
    const states = raw?.states && typeof raw.states === "object" ? raw.states : {};
    for (const [key, value] of Object.entries(states)) this.states[key] = sanitizeState(value);
    this.transientStates = createWatchStateRecord();
    const transientStates = raw?.transientStates && typeof raw.transientStates === "object"
      ? raw.transientStates
      : {};
    for (const [path, value] of Object.entries(transientStates)) {
      this.transientStates[path] = sanitizeState(value);
    }
    this.quarantinedWatchIds = new Set(
      Array.isArray(raw?.quarantinedWatchIds)
        ? raw!.quarantinedWatchIds!.map((id) => normalizeText(id)).filter(Boolean)
        : [],
    );
    this.quarantinedWatchPaths = new Set(
      Array.isArray(raw?.quarantinedWatchPaths)
        ? raw!.quarantinedWatchPaths!.map((path) => String(path || "")).filter(Boolean)
        : [],
    );
    if (raw?.identityStateVersion !== WATCH_IDENTITY_STATE_VERSION) {
      for (const id of this.quarantinedWatchIds) this.states[id] = createEmptyState();
    }
    const ledger = loadNotificationLedger(raw, new Date().toISOString());
    this.notificationDeliveries = ledger.records;
    this.notificationLedgerBlockedReason = ledger.blockedReason || "";
    this.rawNotificationLedgerVersion = ledger.rawVersion;
    this.rawNotificationDeliveries = ledger.rawDeliveries;
    this.recoveredNotificationAttemptCount = ledger.recoveredAttemptCount;
    this.startupPrunedNotificationRecordCount = ledger.prunedRecordCount;
    if (ledger.recoveredAttemptCount > 0 || ledger.prunedRecordCount > 0) {
      if (!this.isCurrentLifecycle(lifecycleEpoch)) return false;
      try {
        await this.enqueueDataOperation(async () => {
          if (!this.isCurrentLifecycle(lifecycleEpoch)) throw new WatchDefinitionChangedError();
          const payload = this.persistentDataPayload(this.clonePersistentWatchState());
          await this.saveData(payload);
          if (!this.isCurrentLifecycle(lifecycleEpoch)) throw new WatchDefinitionChangedError();
        });
      } catch (error) {
        if (!this.isCurrentLifecycle(lifecycleEpoch)) return false;
        this.notificationDeliveries = createNotificationRecordMap();
        this.notificationLedgerBlockedReason = "Notification ledger startup recovery could not be persisted durably: "
          + truncate(sanitizeWatchErrorMessage(error), 180);
      }
      if (!this.isCurrentLifecycle(lifecycleEpoch)) return false;
    }
    return true;
  }

  private clonePersistentWatchState(): PersistentWatchStateModel {
    return {
      states: cloneWatchStateRecord(this.states),
      transientStates: cloneWatchStateRecord(this.transientStates),
      quarantinedWatchIds: new Set(this.quarantinedWatchIds),
      quarantinedWatchPaths: new Set(this.quarantinedWatchPaths),
      notificationDeliveries: cloneNotificationRecordMap(this.notificationDeliveries),
      notificationLedgerBlockedReason: this.notificationLedgerBlockedReason,
      rawNotificationLedgerVersion: this.rawNotificationLedgerVersion,
      rawNotificationDeliveries: this.rawNotificationDeliveries,
    };
  }

  private installPersistentWatchState(model: PersistentWatchStateModel): void {
    this.states = model.states;
    this.transientStates = model.transientStates;
    this.quarantinedWatchIds = model.quarantinedWatchIds;
    this.quarantinedWatchPaths = model.quarantinedWatchPaths;
    this.notificationDeliveries = model.notificationDeliveries;
    this.notificationLedgerBlockedReason = model.notificationLedgerBlockedReason;
    this.rawNotificationLedgerVersion = model.rawNotificationLedgerVersion;
    this.rawNotificationDeliveries = model.rawNotificationDeliveries;
  }

  private persistentDataPayload(model: PersistentWatchStateModel): PersistedWatchlistData {
    const notificationData = notificationLedgerPersistenceFields(
      Boolean(model.notificationLedgerBlockedReason),
      model.notificationDeliveries,
      model.rawNotificationLedgerVersion,
      model.rawNotificationDeliveries,
    );
    return {
      settings: { ...this.settings },
      states: cloneWatchStateRecord(model.states),
      transientStates: cloneWatchStateRecord(model.transientStates),
      quarantinedWatchIds: Array.from(model.quarantinedWatchIds).sort((left, right) => left.localeCompare(right)),
      quarantinedWatchPaths: Array.from(model.quarantinedWatchPaths).sort((left, right) => left.localeCompare(right)),
      identityStateVersion: WATCH_IDENTITY_STATE_VERSION,
      ...notificationData,
    };
  }

  private enqueueDataOperation<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.saveSerial.then(operation, operation);
    this.saveSerial = run.then(() => undefined, () => undefined);
    return run;
  }

  private isCurrentLifecycle(lifecycleEpoch: number): boolean {
    return !this.unloading && lifecycleEpoch === this.lifecycleEpoch;
  }

  private async mutatePersistentWatchState<T>(
    mutate: (draft: PersistentWatchStateModel) => PersistentStateMutation<T>,
  ): Promise<T> {
    const lifecycleEpoch = this.lifecycleEpoch;
    return await this.enqueueDataOperation(async () => {
      if (!this.isCurrentLifecycle(lifecycleEpoch)) throw new WatchDefinitionChangedError();
      const draft = this.clonePersistentWatchState();
      const result = mutate(draft);
      if (!result.changed) return result.value;
      await this.saveData(this.persistentDataPayload(draft));
      if (!this.isCurrentLifecycle(lifecycleEpoch)) throw new WatchDefinitionChangedError();
      this.installPersistentWatchState(draft);
      return result.value;
    });
  }

  private async persistData(lifecycleEpoch: number): Promise<void> {
    await this.enqueueDataOperation(async () => {
      if (!this.isCurrentLifecycle(lifecycleEpoch)) throw new WatchDefinitionChangedError();
      const snapshot = this.clonePersistentWatchState();
      await this.saveData(this.persistentDataPayload(snapshot));
      if (!this.isCurrentLifecycle(lifecycleEpoch)) throw new WatchDefinitionChangedError();
    });
  }
}

function inferProvider(url: string, jsonPath: string): WatchProvider {
  if (jsonPath) return "json";
  if (/\.(?:rss|atom|xml)(?:$|[?#])/i.test(url) || /(?:rss|atom|feed)/i.test(url)) return "rss";
  return "page";
}

function isDue(definition: WatchDefinition, state: WatchState): boolean {
  if (!state.lastCheckedAt) return true;
  const last = Date.parse(state.lastCheckedAt);
  if (!Number.isFinite(last)) return true;
  return Date.now() - last >= definition.intervalMinutes * 60 * 1000;
}

function createLocalId(prefix: string): string {
  return prefix + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 9);
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.round(parsed))) : fallback;
}

function scalar(value: unknown): string {
  if (Array.isArray(value)) return scalar(value[0]);
  return normalizeText(value);
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(scalar).filter(Boolean);
  return scalar(value).split(",").map((item) => item.trim()).filter(Boolean);
}

function propertyBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  const normalized = normalizeText(value).toLocaleLowerCase();
  if (["true", "yes", "1", "on"].includes(normalized)) return true;
  if (["false", "no", "0", "off"].includes(normalized)) return false;
  return fallback;
}

function sanitizeState(value: unknown): WatchState {
  const raw = value && typeof value === "object" ? value as Partial<WatchState> : {};
  return {
    fingerprintVersion: raw.fingerprintVersion === WATCH_FINGERPRINT_VERSION ? WATCH_FINGERPRINT_VERSION : 1,
    baselineReady: raw.baselineReady === true,
    lastFingerprint: normalizeText(raw.lastFingerprint),
    lastValue: truncate(normalizeText(raw.lastValue), 220),
    lastMatched: raw.lastMatched === true,
    lastCheckedAt: normalizeText(raw.lastCheckedAt),
    lastEventAt: normalizeText(raw.lastEventAt),
    lastEventId: normalizeText(raw.lastEventId),
    failureCount: clampInteger(raw.failureCount, 0, 0, 100000),
    lastError: truncate(normalizeText(raw.lastError), 240),
    lastErrorNotifiedAt: normalizeText(raw.lastErrorNotifiedAt),
  };
}

function cloneWatchDefinition(definition: WatchDefinition): WatchDefinition {
  return {
    ...definition,
    tags: definition.tags.slice(),
  };
}

function watchDefinitionSignatureOrEmpty(definition: WatchDefinition | null): string {
  return definition ? watchDefinitionSignature(definition) : "";
}

function buildWatchNote(definition: WatchDefinition): string {
  const lines = [
    "---",
    "title: " + yamlString(definition.title),
    "kind: watch",
    "status: working",
    "watchId: " + yamlString(definition.id),
    "source: " + yamlString(definition.url),
    "watchProvider: " + definition.provider,
    "watchCondition: " + definition.condition,
  ];
  if (definition.selector) lines.push("watchSelector: " + yamlString(definition.selector));
  if (definition.jsonPath) lines.push("watchJsonPath: " + yamlString(definition.jsonPath));
  if (definition.pattern) lines.push("watchPattern: " + yamlString(definition.pattern));
  if (definition.query) lines.push("watchQuery: " + yamlString(definition.query));
  if (definition.target) lines.push("watchTarget: " + yamlString(definition.target));
  lines.push("watchIntervalMinutes: " + definition.intervalMinutes);
  lines.push("watchNotify: " + String(definition.notify));
  if (definition.cooldownMinutes) lines.push("watchCooldownMinutes: " + definition.cooldownMinutes);
  if (definition.caseSensitive) lines.push("watchCaseSensitive: true");
  if (definition.tags.length) {
    lines.push("tags:");
    for (const tag of definition.tags) lines.push("  - " + yamlString(tag));
  }
  lines.push("created: " + localIsoDate(new Date().toISOString()));
  lines.push("---", "");
  return lines.join("\n");
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function safeFilename(value: string): string {
  return normalizeText(value)
    .replace(/[\\/:*?"<>|#^[\]]+/g, " ")
    .replace(/\.+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function safeWikiPath(value: string): string {
  return value.replace(/[\[\]|]/g, " ").replace(/\s+/g, " ").trim();
}

function safeWikiAlias(value: string): string {
  return value.replace(/[\[\]|]/g, " ").replace(/\s+/g, " ").trim();
}

function inlineValue(value: string): string {
  return truncate(normalizeText(value).replace(/[\[\]]/g, (token) => token === "[" ? "(" : ")").replace(/%%/g, "% %"), 260);
}

function markdownText(value: string): string {
  return truncate(normalizeText(value).replace(/[\r\n]+/g, " "), 320);
}

function eventSummary(kind: string, value: string, previous: string): string {
  if (kind === "error") return "check failed: " + value;
  if (kind === "new-item") return "new item: " + value;
  if (kind === "condition-met") return "condition met: " + value;
  if (kind === "changed" && previous) return "changed from " + previous + " to " + value;
  if (kind === "changed") return "changed: " + value;
  return value;
}

function localIsoDate(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  if (!Number.isFinite(date.getTime())) return isoTimestamp.slice(0, 10);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return year + "-" + month + "-" + day;
}

function localDateTime(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  if (!Number.isFinite(date.getTime())) return isoTimestamp.replace("T", " ");
  const datePart = localIsoDate(isoTimestamp);
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return datePart + " " + hours + ":" + minutes + ":" + seconds;
}

function watchlistBaseContent(): string {
  return [
    "model:",
    "  version: 1",
    "  kind: Table",
    "  columns: []",
    "pluginVersion: 1.0.0",
    "filters:",
    "  and:",
    "    - kind == \"watch\"",
    "views:",
    "  - type: table",
    "    name: Watchlist",
    "    order:",
    "      - title",
    "      - status",
    "      - watchProvider",
    "      - watchCondition",
    "      - watchTarget",
    "      - watchIntervalMinutes",
    "      - watchNotify",
    "      - source",
    "      - file.name",
    "    sort:",
    "      - property: status",
    "        direction: ASC",
    "      - property: title",
    "        direction: ASC",
    "",
  ].join("\n");
}

function watchEventsBaseContent(): string {
  return [
    "model:",
    "  version: 1",
    "  kind: Table",
    "  columns: []",
    "pluginVersion: 1.0.0",
    "filters:",
    "  and:",
    "    - file.ext == \"md\"",
    "views:",
    "  - type: tps-table",
    "    name: Watch Events",
    "    lineFilterKey: watchEventId",
    "    createAction: command",
    "    createCommandId: tps-watchlist:create-watch",
    "    order:",
    "      - observedAt",
    "      - watch",
    "      - event",
    "      - value",
    "      - previousValue",
    "      - reason",
    "      - file.name",
    "      - title",
    "    sort:",
    "      - property: observedAt",
    "        direction: DESC",
    "",
  ].join("\n");
}
