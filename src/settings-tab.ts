import { App, PluginSettingTab, Setting } from "obsidian";
import type TPSWatchlistPlugin from "./main";
import type { WatchEventLogTarget, WatchExecutionMode } from "./types";

type WatchlistSettingsPage = "checks-reliability" | "files-events" | "notifications-logs";

interface WatchlistSettingsDestination {
  id: WatchlistSettingsPage;
  label: string;
  description: string;
  summary: string;
}

const WATCHLIST_SETTINGS_DESTINATIONS: WatchlistSettingsDestination[] = [
  {
    id: "checks-reliability",
    label: "Checks & reliability",
    description: "Device role, cadence, request limits, and repeated-failure behavior.",
    summary: "Device role · cadence · failures",
  },
  {
    id: "files-events",
    label: "Files & events",
    description: "Watch creation folder, collection Bases, and event ownership.",
    summary: "Folders · 2 Bases · event owner",
  },
  {
    id: "notifications-logs",
    label: "Notifications & logs",
    description: "New-watch notification defaults and diagnostic logging.",
    summary: "Defaults · delivery · diagnostics",
  },
];

export class WatchlistSettingTab extends PluginSettingTab {
  private activeSettingsPage: WatchlistSettingsPage = "checks-reliability";

  constructor(app: App, private plugin: TPSWatchlistPlugin) {
    super(app, plugin);
  }

  private navigateToPage(page: WatchlistSettingsPage): void {
    this.activeSettingsPage = page;
    this.display();
    window.requestAnimationFrame(() => {
      this.containerEl
        .querySelector<HTMLElement>('.tps-watch-settings-route-button[aria-pressed="true"]')
        ?.scrollIntoView({ block: "nearest", inline: "nearest" });
      const heading = this.containerEl.querySelector<HTMLElement>(".tps-watch-settings-page > h3");
      heading?.focus({ preventScroll: true });
      heading?.scrollIntoView({ block: "start" });
    });
  }

  private renderShortcuts(root: HTMLElement): void {
    const shortcuts = root.createDiv({ cls: "tps-watch-settings-shortcuts" });
    const copy = shortcuts.createDiv({ cls: "tps-watch-settings-shortcuts-copy" });
    copy.createEl("strong", { text: "Watch rules live on each watch" });
    copy.createEl("span", {
      text: "Create or open a watch to edit its provider, condition, target, extraction, cadence, and notification overrides.",
    });
    const actions = shortcuts.createDiv({ cls: "tps-watch-settings-shortcuts-actions" });
    const createButton = actions.createEl("button", { text: "Create watch" });
    createButton.type = "button";
    createButton.addEventListener("click", () => this.plugin.openCreateModal());
    const openButton = actions.createEl("button", { text: "Open Watchlist" });
    openButton.type = "button";
    openButton.addEventListener("click", () => void this.plugin.openDashboard());
  }

  private renderDestinationHub(root: HTMLElement): void {
    const hub = root.createDiv({ cls: "tps-watch-settings-hub" });
    hub.setAttr("role", "group");
    hub.setAttr("aria-label", "TPS Watchlist settings pages");

    for (const destination of WATCHLIST_SETTINGS_DESTINATIONS) {
      const button = hub.createEl("button", { cls: "tps-watch-settings-route-button" });
      button.type = "button";
      button.dataset.watchSettingsPage = destination.id;
      button.setAttr("aria-pressed", String(this.activeSettingsPage === destination.id));
      button.createSpan({ cls: "tps-watch-settings-route-title", text: destination.label });
      button.createSpan({ cls: "tps-watch-settings-route-summary", text: destination.summary });
      button.createSpan({ cls: "tps-watch-settings-route-description", text: destination.description });
      button.addEventListener("click", () => {
        if (this.activeSettingsPage === destination.id) return;
        this.navigateToPage(destination.id);
      });
    }
  }

  private createPage(root: HTMLElement, page: WatchlistSettingsPage): HTMLElement {
    const destination = WATCHLIST_SETTINGS_DESTINATIONS.find((candidate) => candidate.id === page)!;
    const section = root.createEl("section", {
      cls: "tps-watch-settings-page",
      attr: {
        "data-watch-settings-page": page,
        "aria-label": destination.label,
      },
    });
    const heading = section.createEl("h3", { text: destination.label });
    heading.setAttr("tabindex", "-1");
    section.createEl("p", {
      cls: "setting-item-description tps-watch-settings-page-description",
      text: destination.description,
    });
    return section;
  }

  display(): void {
    const root = this.containerEl;
    root.empty();
    root.createEl("h2", { text: "TPS Watchlist" });
    root.createEl("p", {
      text: "Watch notes remain canonical Markdown. Plugin state stores only baselines, fingerprints, check health, and delivery deduplication.",
    });

    this.renderShortcuts(root);
    root.createEl("h3", { text: "Choose what to configure", cls: "tps-watch-settings-hub-heading" });
    root.createEl("p", {
      text: "Pick one destination. Watch rules stay in each watch, while these pages control shared defaults and reliability.",
      cls: "setting-item-description tps-watch-settings-hub-description",
    });
    this.renderDestinationHub(root);
    const page = this.createPage(root, this.activeSettingsPage);

    if (this.activeSettingsPage === "checks-reliability") {
      page.createEl("h4", { text: "Scheduling" });
      new Setting(page)
        .setName("Automatic execution")
        .setDesc("Controller-only prevents duplicate polling across synchronized devices.")
        .addDropdown((dropdown) => dropdown
          .addOption("controller-only", "Controller device only")
          .addOption("this-device", "This device")
          .setValue(this.plugin.settings.executionMode)
          .onChange(async (value) => {
            this.plugin.settings.executionMode = value as WatchExecutionMode;
            await this.plugin.saveSettings();
          }));
      numberSetting(page, this.plugin, "Default check interval", "Minutes used when a watch has no watchIntervalMinutes property.", "defaultIntervalMinutes", 1, 10080);
      numberSetting(page, this.plugin, "Scheduler tick", "Seconds between due-watch scans. Individual watches retain their own cadence.", "schedulerTickSeconds", 30, 3600);

      page.createEl("h4", { text: "Reliability" });
      numberSetting(page, this.plugin, "Request timeout", "Seconds before a provider request is considered failed.", "requestTimeoutSeconds", 5, 120);
      numberSetting(page, this.plugin, "Concurrent checks", "Maximum provider requests in flight during one run.", "maxConcurrentChecks", 1, 10);
      numberSetting(page, this.plugin, "Failure alert threshold", "Consecutive failures before one error event and notification are created.", "failureAlertThreshold", 1, 20);
      new Setting(page)
        .setName("Notify on repeated failures")
        .setDesc("Failure alerts are emitted once when the threshold is reached and reset after recovery.")
        .addToggle((toggle) => toggle
          .setValue(this.plugin.settings.notifyOnFailure)
          .onChange(async (value) => {
            this.plugin.settings.notifyOnFailure = value;
            await this.plugin.saveSettings();
          }));
    }

    if (this.activeSettingsPage === "files-events") {
      textSetting(page, this.plugin, "Default watch folder", "New watch notes are created here. Discovery still uses kind: watch across the entire vault.", "defaultFolder");
      textSetting(page, this.plugin, "Watchlist Base", "Native Base that manages durable watch notes.", "watchlistBasePath");
      textSetting(page, this.plugin, "Watch events Base", "TPS Table Base that renders typed watch-event lines.", "watchEventsBasePath");
      new Setting(page)
        .setName("Event log owner")
        .setDesc("Daily notes are the recommended canonical owner for meaningful detected changes.")
        .addDropdown((dropdown) => dropdown
          .addOption("daily-note", "Relevant daily note")
          .addOption("watch-note", "Watch note body")
          .setValue(this.plugin.settings.eventLogTarget)
          .onChange(async (value) => {
            this.plugin.settings.eventLogTarget = value as WatchEventLogTarget;
            await this.plugin.saveSettings();
          }));
      new Setting(page)
        .setName("Create or repair collection files")
        .setDesc("Creates missing Base files without overwriting user-edited existing Bases.")
        .addButton((button) => button.setButtonText("Ensure Bases").onClick(async () => {
          await this.plugin.ensureBases();
        }));
    }

    if (this.activeSettingsPage === "notifications-logs") {
      new Setting(page)
        .setName("Notify by default")
        .setDesc("New watches inherit this value; each watch can override it with watchNotify.")
        .addToggle((toggle) => toggle
          .setValue(this.plugin.settings.defaultNotify)
          .onChange(async (value) => {
            this.plugin.settings.defaultNotify = value;
            await this.plugin.saveSettings();
          }));
      new Setting(page)
        .setName("Enable debug logging")
        .setDesc("Logs trigger, route, counts, transitions, writes, and compact failures without response bodies or full settings.")
        .addToggle((toggle) => toggle
          .setValue(this.plugin.settings.enableLogging)
          .onChange(async (value) => {
            this.plugin.settings.enableLogging = value;
            await this.plugin.saveSettings();
          }));
    }
  }
}

type TextKey = "defaultFolder" | "watchlistBasePath" | "watchEventsBasePath";
function textSetting(root: HTMLElement, plugin: TPSWatchlistPlugin, name: string, description: string, key: TextKey): void {
  new Setting(root)
    .setName(name)
    .setDesc(description)
    .addText((text) => text
      .setValue(plugin.settings[key])
      .onChange(async (value) => {
        plugin.settings[key] = value.trim();
        await plugin.saveSettings();
      }));
}

type NumberKey =
  | "defaultIntervalMinutes"
  | "schedulerTickSeconds"
  | "requestTimeoutSeconds"
  | "maxConcurrentChecks"
  | "failureAlertThreshold";
function numberSetting(
  root: HTMLElement,
  plugin: TPSWatchlistPlugin,
  name: string,
  description: string,
  key: NumberKey,
  min: number,
  max: number,
): void {
  new Setting(root)
    .setName(name)
    .setDesc(description)
    .addText((text) => {
      text.inputEl.type = "number";
      text.inputEl.min = String(min);
      text.inputEl.max = String(max);
      text.setValue(String(plugin.settings[key]));
      text.onChange(async (value) => {
        plugin.settings[key] = Number(value);
        await plugin.saveSettings();
      });
    });
}
