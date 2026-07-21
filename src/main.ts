import {
  Notice,
  normalizePath,
  Platform,
  Plugin,
  TFile,
  WorkspaceLeaf,
} from "obsidian";
import {
  appendLineOnce,
  createEmptyState,
  createEventId,
  evaluateObservation,
  isActiveStatus,
  joinSingleFlight,
  normalizeText,
  sanitizeWatchErrorMessage,
  WATCH_FINGERPRINT_VERSION,
  stableHash,
  truncate,
  validateDefinition,
} from "./core";
import { fetchWatchObservation } from "./providers";
import { CreateWatchModal } from "./modal";
import { WatchlistPersistenceCoordinator } from "./persistence";
import { DEFAULT_SETTINGS, sanitizeSettings } from "./settings";
import { WatchlistSettingTab } from "./settings-tab";
import { WATCHLIST_VIEW_TYPE, WatchlistView } from "./view";
import * as logger from "./logger";
import type {
  CreateWatchInput,
  PersistedWatchlistData,
  WatchCheckResult,
  WatchCondition,
  WatchDefinition,
  WatchObservation,
  WatchProvider,
  WatchRow,
  WatchState,
  WatchlistApi,
  WatchlistSettings,
} from "./types";

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

export default class TPSWatchlistPlugin extends Plugin {
  settings: WatchlistSettings = DEFAULT_SETTINGS;
  private states: Record<string, WatchState> = {};
  private schedulerIntervalId: number | null = null;
  private startupTimeoutId: number | null = null;
  private batchInFlight = false;
  private checksInFlight = new Map<string, Promise<WatchCheckResult>>();
  private persistence: WatchlistPersistenceCoordinator<WatchlistSettings, Record<string, WatchState>> | null = null;
  private unregisterGcmActions: Array<() => void> = [];
  private unregisterAiCapabilities: Array<() => void> = [];
  private api!: WatchlistApi;

  async onload(): Promise<void> {
    this.persistence = new WatchlistPersistenceCoordinator(
      () => this.loadData(),
      (data) => this.saveData(data),
    );
    await this.loadPluginData();
    this.persistence.setSettingsBaseline(this.settings);
    logger.setLogging(this.settings.enableLogging);
    this.registerView(WATCHLIST_VIEW_TYPE, (leaf) => new WatchlistView(leaf, this));
    this.registerCommands();
    this.addRibbonIcon("binoculars", "Open TPS Watchlist", () => void this.openDashboard());
    this.addSettingTab(new WatchlistSettingTab(this.app, this));
    this.exposeApi();

    this.registerEvent(this.app.metadataCache.on("changed", (file) => {
      const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter || {};
      if (normalizeText(frontmatter.kind).toLocaleLowerCase() === "watch") void this.refreshViews();
    }));
    this.registerEvent(this.app.workspace.on("tps:controller-role-changed" as any, (() => {
      logger.flow("Scheduler", "controller-role-changed");
      void this.runScheduledChecks("controller-role-changed");
    }) as any));

    this.app.workspace.onLayoutReady(() => {
      void this.initializeIntegrations();
    });
    this.startScheduler();
    logger.flow("Lifecycle", "loaded", {
      executionMode: this.settings.executionMode,
      defaultIntervalMinutes: this.settings.defaultIntervalMinutes,
      stateCount: Object.keys(this.states).length,
    });
  }

  onunload(): void {
    this.stopScheduler();
    for (const unregister of this.unregisterGcmActions.splice(0)) unregister();
    for (const unregister of this.unregisterAiCapabilities.splice(0)) unregister();
    this.app.workspace.detachLeavesOfType(WATCHLIST_VIEW_TYPE);
    if ((this.app as any).tpsWatchlist === this.api) delete (this.app as any).tpsWatchlist;
    delete (this as any).api;
    logger.flow("Lifecycle", "unloaded");
  }

  async saveSettings(): Promise<void> {
    this.settings = sanitizeSettings(this.settings);
    logger.setLogging(this.settings.enableLogging);
    if (!this.persistence) throw new Error("TPS Watchlist persistence is not ready.");
    await this.persistence.saveSettings(this.settings);
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

  async createWatch(input: CreateWatchInput): Promise<TFile> {
    const title = normalizeText(input.title);
    const url = normalizeText(input.url);
    const provider = WATCH_PROVIDERS.includes(input.provider as WatchProvider)
      ? input.provider as WatchProvider
      : inferProvider(url, normalizeText(input.jsonPath));
    const condition = WATCH_CONDITIONS.includes(input.condition as WatchCondition)
      ? input.condition as WatchCondition
      : provider === "rss" ? "new-item" : "changed";
    const id = createLocalId("watch");
    const intervalMinutes = clampInteger(input.intervalMinutes, this.settings.defaultIntervalMinutes, 1, 10080);
    const cooldownMinutes = clampInteger(input.cooldownMinutes, 0, 0, 10080);
    const tags = Array.from(new Set((input.tags || []).map((tag) => normalizeText(tag).replace(/^#/, "")).filter(Boolean)));
    const draft: WatchDefinition = {
      id,
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
    const result = await this.checkOne(draft, "create");
    logger.flow("Create", "write:done", { path: file.path, baselineOutcome: result.outcome });
    new Notice(result.outcome === "failed"
      ? "Watch created. Its first baseline check failed; open Watchlist for details."
      : "Watch created and baseline stored.");
    await this.refreshViews();
    return file;
  }

  getWatchRows(): WatchRow[] {
    return this.app.vault.getMarkdownFiles()
      .map((file) => this.definitionFromFile(file))
      .filter((definition): definition is WatchDefinition => definition != null)
      .map((definition) => ({
        definition,
        state: this.states[definition.id] || createEmptyState(),
        active: isActiveStatus(definition.status),
      }));
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
    const gcm = this.getGcmApi();
    if (typeof gcm?.openFileInLeaf === "function") {
      await gcm.openFileInLeaf(file, false, () => this.app.workspace.getLeaf(false), {
        revealLeaf: true,
        active: true,
        reuseLeafIfNoExisting: true,
      });
      return;
    }
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

  private async initializeIntegrations(): Promise<void> {
    try {
      await this.ensureBases(false);
    } catch (error) {
      logger.failure("Bases", "ensure:failed", error);
    }
    this.registerGcmActions();
    this.registerAiCapabilities();
    if (!this.unregisterGcmActions.length || !this.unregisterAiCapabilities.length) {
      const retry = window.setTimeout(() => {
        if (!this.unregisterGcmActions.length) this.registerGcmActions();
        if (!this.unregisterAiCapabilities.length) this.registerAiCapabilities();
      }, 3000);
      this.register(() => window.clearTimeout(retry));
    }
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
      callback: () => void this.openDashboard(),
    });
    this.addCommand({
      id: "open-watchlist-base",
      name: "Open Watchlist Base",
      callback: () => void this.openBase(this.settings.watchlistBasePath),
    });
    this.addCommand({
      id: "open-watch-events-base",
      name: "Open Watch Events Base",
      callback: () => void this.openBase(this.settings.watchEventsBasePath),
    });
    this.addCommand({
      id: "check-all-watches",
      name: "Check all active watches now",
      callback: async () => {
        const results = await this.checkAll("command");
        const events = results.filter((result) => result.outcome === "event").length;
        const failures = results.filter((result) => result.outcome === "failed").length;
        new Notice("Watchlist checked " + results.length + " watch(es): " + events + " event(s), " + failures + " failure(s).");
      },
    });
    this.addCommand({
      id: "check-active-watch",
      name: "Check active watch now",
      checkCallback: (checking) => {
        const file = this.getActiveWatchFile();
        if (!file) return false;
        if (!checking) void this.checkPath(file.path, "command-active").then((result) => {
          new Notice(result.outcome === "failed" ? result.error || "Watch check failed." : "Watch check: " + result.outcome + ".");
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
        if (!checking) void this.toggleWatchStatus(file.path);
        return true;
      },
    });
  }

  private startScheduler(): void {
    this.stopScheduler();
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
    const rows = this.getWatchRows().filter((row) => row.active && isDue(row.definition, row.state));
    const invalid = rows.filter((row) => validateDefinition(row.definition).length > 0);
    if (invalid.length) {
      logger.warn("Scheduler", "drafts:skipped", {
        count: invalid.length,
        paths: invalid.slice(0, 5).map((row) => row.definition.path),
      });
    }
    const due = rows
      .filter((row) => validateDefinition(row.definition).length === 0)
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
        await this.persistStates();
      } catch (error) {
        logger.failure("Check", "batch:persist-failed", new Error(sanitizeWatchErrorMessage(error)), {
          reason,
          checked: results.length,
        });
      }
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
        events: results.filter((result) => result.outcome === "event").length,
        failures: results.filter((result) => result.outcome === "failed").length,
        baselines: results.filter((result) => result.outcome === "baseline").length,
      });
      return results;
    } finally {
      this.batchInFlight = false;
    }
  }

  private async checkOne(inputDefinition: WatchDefinition, reason: string): Promise<WatchCheckResult> {
    const path = normalizePath(inputDefinition.path);
    const flight = joinSingleFlight(
      this.checksInFlight,
      path,
      () => this.performCheckOne(inputDefinition, reason),
    );
    if (flight.joined) {
      logger.flow("Check", "watch:joined-in-flight", {
        reason,
        path,
        provider: inputDefinition.provider,
      });
    }
    return await flight.promise;
  }

  private async performCheckOne(inputDefinition: WatchDefinition, reason: string): Promise<WatchCheckResult> {
    let definition = inputDefinition;
    try {
      definition = await this.ensureWatchIdentity(inputDefinition);
      const validation = validateDefinition(definition);
      if (validation.length) throw new Error("Invalid watch: " + validation.join("; "));
      const previous = this.states[definition.id] || createEmptyState();
      logger.flow("Check", "watch:start", {
        reason,
        path: definition.path,
        provider: definition.provider,
        condition: definition.condition,
        baselineReady: previous.baselineReady,
        failureCount: previous.failureCount,
      });
      const observation = await fetchWatchObservation(
        definition,
        this.settings.requestTimeoutSeconds * 1000,
      );
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
      if (evaluation.shouldEmit) {
        eventId = createEventId(definition.id, observation, evaluation.eventKind);
        appended = await this.appendWatchEvent(
          definition,
          observation,
          evaluation.eventKind,
          eventId,
          evaluation.reason,
          previous.lastValue,
        );
        if (appended) {
          outcome = "event";
          if (definition.notify) {
            await this.deliverNotification(
              "Watch triggered: " + definition.title,
              eventSummary(evaluation.eventKind, observation.displayValue, previous.lastValue),
              definition.path,
            );
          }
        }
      }
      this.states[definition.id] = {
        ...previous,
        fingerprintVersion: WATCH_FINGERPRINT_VERSION,
        baselineReady: true,
        lastFingerprint: observation.fingerprint,
        lastValue: observation.displayValue,
        lastMatched: evaluation.matched,
        lastCheckedAt: observation.observedAt,
        lastEventAt: appended ? observation.observedAt : previous.lastEventAt,
        lastEventId: appended ? eventId : previous.lastEventId,
        failureCount: 0,
        lastError: "",
        lastErrorNotifiedAt: "",
      };
      await this.persistStates();
      logger.flow("Check", "watch:done", {
        reason,
        path: definition.path,
        outcome,
        matched: evaluation.matched,
        changed: observation.fingerprint !== previous.lastFingerprint,
        eventWritten: appended,
      });
      return { watchId: definition.id, path: definition.path, outcome, eventId: eventId || undefined };
    } catch (error) {
      return await this.handleFailure(definition, error, reason);
    }
  }

  private async handleFailure(
    definition: WatchDefinition,
    error: unknown,
    reason: string,
  ): Promise<WatchCheckResult> {
    const previous = this.states[definition.id] || createEmptyState();
    const summary = truncate(sanitizeWatchErrorMessage(error), 240);
    const failureCount = previous.failureCount + 1;
    const failedAt = new Date().toISOString();
    let lastErrorNotifiedAt = previous.lastErrorNotifiedAt;
    let failureEscalationFailed = false;
    logger.failure("Check", "watch:failed", new Error(summary), {
      reason,
      path: definition.path,
      provider: definition.provider,
      failureCount,
    });

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
        const eventId = createEventId(definition.id, observation, "error");
        const appended = await this.appendWatchEvent(
          definition,
          observation,
          "error",
          eventId,
          "The watch reached " + failureCount + " consecutive check failures.",
          "",
        );
        if (appended && this.settings.notifyOnFailure && definition.notify) {
          await this.deliverNotification(
            "Watch needs attention: " + definition.title,
            summary,
            definition.path,
          );
          lastErrorNotifiedAt = failedAt;
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

    this.states[definition.id] = {
      ...previous,
      lastCheckedAt: failedAt,
      failureCount: failureEscalationFailed ? previous.failureCount : failureCount,
      lastError: summary,
      lastErrorNotifiedAt,
    };
    try {
      await this.persistStates();
    } catch (persistError) {
      logger.failure("Check", "failure-state:persist-failed", new Error(sanitizeWatchErrorMessage(persistError)), {
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
    return {
      watchId: definition.id,
      path: definition.path,
      outcome: "failed",
      error: summary,
    };
  }

  private async appendWatchEvent(
    definition: WatchDefinition,
    observation: WatchObservation,
    eventKind: string,
    eventId: string,
    reason: string,
    previousValue: string,
  ): Promise<boolean> {
    const watchFile = this.app.vault.getAbstractFileByPath(definition.path);
    if (!(watchFile instanceof TFile)) throw new Error("Watch source note disappeared before event write.");
    const target = this.settings.eventLogTarget === "watch-note"
      ? watchFile
      : await this.ensureDailyNote(localIsoDate(observation.observedAt));
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
    await this.app.vault.process(target, (current) => {
      const result = appendLineOnce(current, marker, line);
      appended = result.appended;
      return result.content;
    });
    if (!appended) {
      logger.flow("Event", "write:deduped", { eventId, target: target.path, watchPath: definition.path });
      return false;
    }
    this.emitFilesUpdated([target.path, definition.path]);
    logger.flow("Event", "write:done", {
      eventId,
      eventKind,
      target: target.path,
    });
    return true;
  }

  private async deliverNotification(title: string, body: string, watchPath: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(watchPath);
    const notifier = this.getNotifierApi();
    logger.flow("Notification", "send:start", {
      title,
      watchPath,
      route: typeof notifier?.sendNotification === "function" ? "tps-notifier" : "obsidian-notice",
    });
    try {
      if (typeof notifier?.sendNotification === "function") {
        await notifier.sendNotification(title, body, file instanceof TFile ? file : undefined);
      } else {
        new Notice(title + "\n" + body, 10000);
      }
      logger.flow("Notification", "send:done", { watchPath });
    } catch (error) {
      logger.failure("Notification", "send:failed", error, { watchPath });
      new Notice(title + "\n" + body, 10000);
    }
  }

  private definitionFromFile(file: TFile): WatchDefinition | null {
    const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter || {};
    if (normalizeText(frontmatter.kind).toLocaleLowerCase() !== "watch") return null;
    const url = scalar(frontmatter.source) || scalar(frontmatter.watchUrl);
    const jsonPath = scalar(frontmatter.watchJsonPath);
    const providerValue = normalizeText(frontmatter.watchProvider).toLocaleLowerCase() as WatchProvider;
    const provider = WATCH_PROVIDERS.includes(providerValue) ? providerValue : inferProvider(url, jsonPath);
    const conditionValue = normalizeText(frontmatter.watchCondition).toLocaleLowerCase() as WatchCondition;
    const condition = WATCH_CONDITIONS.includes(conditionValue)
      ? conditionValue
      : provider === "rss" ? "new-item" : "changed";
    const id = scalar(frontmatter.watchId) || "path:" + file.path;
    return {
      id,
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

  private async ensureWatchIdentity(definition: WatchDefinition): Promise<WatchDefinition> {
    if (!definition.id.startsWith("path:")) return definition;
    const file = this.app.vault.getAbstractFileByPath(definition.path);
    if (!(file instanceof TFile)) throw new Error("Watch note was not found.");
    const generatedId = createLocalId("watch");
    let resolvedId = generatedId;
    await this.processFrontmatter(file, (frontmatter) => {
      const existingId = scalar(frontmatter.watchId);
      if (existingId) resolvedId = existingId;
      else frontmatter.watchId = generatedId;
    });
    const pathState = this.states[definition.id];
    const stateMigrated = Boolean(pathState && !this.states[resolvedId]);
    if (stateMigrated) this.states[resolvedId] = pathState;
    if (pathState) delete this.states[definition.id];
    logger.flow("Identity", "assigned", {
      path: file.path,
      watchId: resolvedId,
      reusedExisting: resolvedId !== generatedId,
      stateMigrated,
    });
    return { ...definition, id: resolvedId };
  }

  private async processFrontmatter(
    file: TFile,
    mutator: (frontmatter: Record<string, unknown>) => void,
  ): Promise<void> {
    const gcm = this.getGcmApi();
    if (typeof gcm?.frontmatter?.process === "function") {
      await gcm.frontmatter.process(file, mutator);
      return;
    }
    await this.app.fileManager.processFrontMatter(file, mutator);
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

  private registerGcmActions(): void {
    if (this.unregisterGcmActions.length) return;
    const register = this.getGcmApi()?.externalActions?.register;
    if (typeof register !== "function") {
      logger.warn("GCM", "actions:register-unavailable");
      return;
    }
    const visible = ({ file }: { file: TFile }) => {
      const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter || {};
      return normalizeText(frontmatter.kind).toLocaleLowerCase() === "watch";
    };
    this.unregisterGcmActions.push(register({
      id: "check-watch",
      pluginId: this.manifest.id,
      order: 32,
      icon: "refresh-cw",
      label: "Check watch now",
      title: "Fetch the source and evaluate this watch",
      isVisible: visible,
      onClick: ({ file }: { file: TFile }) => this.checkPath(file.path, "gcm"),
    }));
    this.unregisterGcmActions.push(register({
      id: "toggle-watch",
      pluginId: this.manifest.id,
      order: 33,
      icon: ({ file }: { file: TFile }) => {
        const definition = this.definitionFromFile(file);
        return definition && isActiveStatus(definition.status) ? "pause" : "play";
      },
      label: ({ file }: { file: TFile }) => {
        const definition = this.definitionFromFile(file);
        return definition && isActiveStatus(definition.status) ? "Pause watch" : "Resume watch";
      },
      title: "Pause or resume automatic monitoring",
      isVisible: visible,
      onClick: ({ file }: { file: TFile }) => this.toggleWatchStatus(file.path),
    }));
    this.unregisterGcmActions.push(register({
      id: "open-watchlist",
      pluginId: this.manifest.id,
      order: 34,
      icon: "binoculars",
      label: "Open Watchlist",
      title: "Open the TPS Watchlist dashboard",
      isVisible: visible,
      onClick: () => this.openDashboard(),
    }));
    logger.flow("GCM", "actions:registered", { count: this.unregisterGcmActions.length });
  }

  private registerAiCapabilities(): void {
    if (this.unregisterAiCapabilities.length) return;
    const gateway = this.getAiGatewayApi();
    if (typeof gateway?.registerCapability !== "function") {
      logger.warn("AI", "capabilities:register-unavailable");
      return;
    }
    this.unregisterAiCapabilities.push(gateway.registerCapability({
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
        const file = await this.createWatch(input);
        return { path: file.path, watchId: this.definitionFromFile(file)?.id || "" };
      },
    }));
    this.unregisterAiCapabilities.push(gateway.registerCapability({
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
      execute: async (input: { path: string }) => await this.checkPath(input.path, "ai-capability"),
    }));
    logger.flow("AI", "capabilities:registered", { count: this.unregisterAiCapabilities.length });
  }

  private exposeApi(): void {
    this.api = {
      createWatch: async (input) => (await this.createWatch(input)).path,
      checkAll: (reason = "api") => this.checkAll(reason),
      checkPath: (path, reason = "api") => this.checkPath(path, reason),
      getWatches: () => this.getWatchRows(),
      ensureBases: () => this.ensureBases(),
      openDashboard: () => this.openDashboard(),
      getSettings: () => this.settings,
    };
    (this as any).api = this.api;
    (this.app as any).tpsWatchlist = this.api;
  }

  private async ensureDailyNote(isoDate: string): Promise<TFile> {
    const gcm = this.getGcmApi();
    if (typeof gcm?.dailyNotes?.ensureForIsoDate === "function") {
      const file = await gcm.dailyNotes.ensureForIsoDate(isoDate);
      if (file instanceof TFile) return file;
    }
    const options = (this.app as any)?.internalPlugins?.plugins?.["daily-notes"]?.instance?.options || {};
    const moment = (window as any).moment;
    const parsed = moment ? moment(isoDate, "YYYY-MM-DD", true) : null;
    const basename = parsed?.isValid?.() ? parsed.format(String(options.format || "YYYY-MM-DD")) : isoDate;
    const folder = normalizePath(String(options.folder || "")).replace(/^\/+|\/+$/g, "");
    const path = normalizePath(folder ? folder + "/" + basename + ".md" : basename + ".md");
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) return existing;
    await this.ensureFolderForFile(path);
    return await this.app.vault.create(
      path,
      "---\ntitle: " + yamlString(basename) + "\nscheduled: " + isoDate + " 00:00:00\nkind: dailynote\n---\n",
    );
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

  private getActiveWatchFile(): TFile | null {
    const file = this.app.workspace.getActiveFile();
    return file && this.definitionFromFile(file) ? file : null;
  }

  private getGcmApi(): any {
    return (this.app as any)?.plugins?.getPlugin?.("tps-global-context-menu")?.api || null;
  }

  private getControllerApi(): any {
    return (this.app as any)?.plugins?.getPlugin?.("tps-controller")?.api || null;
  }

  private getNotifierApi(): any {
    return (this.app as any)?.plugins?.getPlugin?.("tps-messager")?.api || null;
  }

  private getAiGatewayApi(): any {
    return (this.app as any).tpsAiGateway
      || (this.app as any)?.plugins?.getPlugin?.("tps-ai-gateway")?.api
      || null;
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

  private async loadPluginData(): Promise<void> {
    const raw = await this.loadData() as Partial<PersistedWatchlistData> | null;
    this.settings = sanitizeSettings(raw?.settings || raw || {});
    this.states = {};
    const states = raw?.states && typeof raw.states === "object" ? raw.states : {};
    for (const [key, value] of Object.entries(states)) this.states[key] = sanitizeState(value);
  }

  private async persistStates(): Promise<void> {
    if (!this.persistence) throw new Error("TPS Watchlist persistence is not ready.");
    await this.persistence.saveStates(this.states);
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
  const moment = (window as any).moment;
  const parsed = moment ? moment(isoTimestamp) : null;
  if (parsed?.isValid?.()) return parsed.format("YYYY-MM-DD");
  const date = new Date(isoTimestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return year + "-" + month + "-" + day;
}

function localDateTime(isoTimestamp: string): string {
  const moment = (window as any).moment;
  const parsed = moment ? moment(isoTimestamp) : null;
  if (parsed?.isValid?.()) return parsed.format("YYYY-MM-DD HH:mm:ss");
  return isoTimestamp.replace("T", " ").replace(/\.\d{3}Z$/, "Z");
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
