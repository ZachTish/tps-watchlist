import { App, PluginSettingTab, Setting } from "obsidian";
import type TPSWatchlistPlugin from "./main";
import type { WatchEventLogTarget, WatchExecutionMode } from "./types";

export class WatchlistSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: TPSWatchlistPlugin) {
    super(app, plugin);
  }

  display(): void {
    const root = this.containerEl;
    root.empty();
    root.createEl("h2", { text: "TPS Watchlist" });
    root.createEl("p", {
      text: "Watch notes remain canonical Markdown. Plugin state stores only baselines, fingerprints, check health, and delivery deduplication.",
    });

    const execution = section(root, "Execution and reliability", true);
    new Setting(execution)
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
    numberSetting(execution, this.plugin, "Default check interval", "Minutes used when a watch has no watchIntervalMinutes property.", "defaultIntervalMinutes", 1, 10080);
    numberSetting(execution, this.plugin, "Scheduler tick", "Seconds between due-watch scans. Individual watches retain their own cadence.", "schedulerTickSeconds", 30, 3600);
    numberSetting(execution, this.plugin, "Request timeout", "Seconds before a provider request is considered failed.", "requestTimeoutSeconds", 5, 120);
    numberSetting(execution, this.plugin, "Concurrent checks", "Maximum provider requests in flight during one run.", "maxConcurrentChecks", 1, 10);
    numberSetting(execution, this.plugin, "Failure alert threshold", "Consecutive failures before one error event and notification are created.", "failureAlertThreshold", 1, 20);
    new Setting(execution)
      .setName("Notify on repeated failures")
      .setDesc("Failure alerts are emitted once when the threshold is reached and reset after recovery.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.notifyOnFailure)
        .onChange(async (value) => {
          this.plugin.settings.notifyOnFailure = value;
          await this.plugin.saveSettings();
        }));

    const storage = section(root, "Storage and collections");
    textSetting(storage, this.plugin, "Default watch folder", "New watch notes are created here. Discovery still uses kind: watch across the entire vault.", "defaultFolder");
    textSetting(storage, this.plugin, "Watchlist Base", "Native Base that manages durable watch notes.", "watchlistBasePath");
    textSetting(storage, this.plugin, "Watch events Base", "TPS Table Base that renders typed watch-event lines.", "watchEventsBasePath");
    new Setting(storage)
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
    new Setting(storage)
      .setName("Create or repair collection files")
      .setDesc("Creates missing Base files without overwriting user-edited existing Bases.")
      .addButton((button) => button.setButtonText("Ensure Bases").onClick(async () => {
        await this.plugin.ensureBases();
      }));

    const delivery = section(root, "Delivery and diagnostics");
    new Setting(delivery)
      .setName("Notify by default")
      .setDesc("New watches inherit this value; each watch can override it with watchNotify.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.defaultNotify)
        .onChange(async (value) => {
          this.plugin.settings.defaultNotify = value;
          await this.plugin.saveSettings();
        }));
    new Setting(delivery)
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

function section(root: HTMLElement, title: string, open = false): HTMLElement {
  const details = root.createEl("details", { cls: "tps-watch-settings-section" });
  details.open = open;
  details.createEl("summary", { text: title });
  return details.createDiv({ cls: "tps-watch-settings-body" });
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
