import { ItemView, Notice, setIcon, WorkspaceLeaf } from "obsidian";
import { validateDefinition } from "./core";
import type TPSWatchlistPlugin from "./main";
import type { WatchRow } from "./types";

export const WATCHLIST_VIEW_TYPE = "tps-watchlist-view";

export class WatchlistView extends ItemView {
  private query = "";

  constructor(leaf: WorkspaceLeaf, private plugin: TPSWatchlistPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return WATCHLIST_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "TPS Watchlist";
  }

  getIcon(): string {
    return "binoculars";
  }

  async onOpen(): Promise<void> {
    await this.render();
  }

  async render(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("tps-watchlist-view");
    const rows = this.plugin.getWatchRows();
    const active = rows.filter((row) => row.active).length;
    const failing = rows.filter((row) => row.state.failureCount > 0 || validateDefinition(row.definition).length > 0).length;

    const header = root.createDiv({ cls: "tps-watchlist-header" });
    const titleGroup = header.createDiv({ cls: "tps-watchlist-title-group" });
    titleGroup.createEl("h2", { text: "Watchlist" });
    titleGroup.createEl("p", {
      text: active + " active · " + (rows.length - active) + " paused or retired · " + failing + " with check failures",
    });
    const headerActions = header.createDiv({ cls: "tps-watchlist-header-actions" });
    actionButton(headerActions, "plus", "New watch", () => this.plugin.openCreateModal());
    actionButton(headerActions, "refresh-cw", "Check all", async () => {
      const results = await this.plugin.checkAll("dashboard");
      const events = results.filter((result) => result.outcome === "event").length;
      const failures = results.filter((result) => result.outcome === "failed").length;
      new Notice("Watchlist check finished: " + events + " event(s), " + failures + " failure(s).");
      await this.render();
    }, true);

    const tools = root.createDiv({ cls: "tps-watchlist-tools" });
    const search = tools.createEl("input", {
      type: "search",
      placeholder: "Filter watches…",
      value: this.query,
    });
    search.addEventListener("input", () => {
      this.query = search.value;
      this.renderRows(list, rows);
    });
    const list = root.createDiv({ cls: "tps-watchlist-list" });
    this.renderRows(list, rows);
  }

  private renderRows(list: HTMLElement, sourceRows: WatchRow[]): void {
    list.empty();
    const query = this.query.trim().toLocaleLowerCase();
    const rows = sourceRows
      .filter((row) => !query || [
        row.definition.title,
        row.definition.provider,
        row.definition.condition,
        row.definition.target,
        row.definition.path,
        row.definition.tags.join(" "),
      ].join(" ").toLocaleLowerCase().includes(query))
      .sort((left, right) =>
        Number(right.state.failureCount > 0) - Number(left.state.failureCount > 0)
        || Number(right.active) - Number(left.active)
        || left.definition.title.localeCompare(right.definition.title));

    if (!rows.length) {
      const empty = list.createDiv({ cls: "tps-watchlist-empty" });
      empty.createEl("strong", { text: sourceRows.length ? "No watches match this filter." : "No watches yet." });
      empty.createEl("p", { text: sourceRows.length ? "Change the search text to reveal other watches." : "Create a watch to establish its first silent baseline." });
      return;
    }

    for (const row of rows) this.renderRow(list, row);
  }

  private renderRow(list: HTMLElement, row: WatchRow): void {
    const configurationErrors = validateDefinition(row.definition);
    const card = list.createDiv({ cls: "tps-watch-card" });
    if (!row.active) card.addClass("is-paused");
    if (row.state.failureCount > 0 || configurationErrors.length > 0) card.addClass("has-error");
    const main = card.createDiv({ cls: "tps-watch-card-main" });
    main.addEventListener("click", () => void this.plugin.openWatchFile(row.definition.path));

    const titleLine = main.createDiv({ cls: "tps-watch-card-title-line" });
    titleLine.createEl("strong", { text: row.definition.title });
    const status = titleLine.createSpan({
      cls: "tps-watch-pill " + (row.active ? "is-active" : "is-muted"),
      text: row.active ? "Active" : row.definition.status || "Paused",
    });
    status.setAttr("aria-label", "Watch status");

    const metadata = main.createDiv({ cls: "tps-watch-card-metadata" });
    metadata.createSpan({ text: row.definition.provider.toUpperCase() });
    metadata.createSpan({ text: conditionLabel(row.definition.condition, row.definition.target) });
    metadata.createSpan({ text: "Every " + row.definition.intervalMinutes + "m" });
    if (!row.definition.notify) metadata.createSpan({ text: "Silent" });

    const latest = main.createDiv({ cls: "tps-watch-card-latest" });
    if (configurationErrors.length) {
      latest.createSpan({ cls: "tps-watch-error", text: "Configuration needed: " + configurationErrors.join("; ") });
    } else if (row.state.lastError) {
      latest.createSpan({ cls: "tps-watch-error", text: row.state.lastError });
    } else if (row.state.baselineReady) {
      latest.createSpan({ text: row.state.lastValue || "Baseline stored" });
    } else {
      latest.createSpan({ cls: "tps-watch-muted", text: "Waiting for first baseline" });
    }
    latest.createSpan({
      cls: "tps-watch-time",
      text: row.state.lastCheckedAt ? relativeTime(row.state.lastCheckedAt) : "Never checked",
    });

    const actions = card.createDiv({ cls: "tps-watch-card-actions" });
    actionButton(actions, "refresh-cw", "Check", async () => {
      const result = await this.plugin.checkPath(row.definition.path, "dashboard-row");
      if (result.outcome === "failed") new Notice(result.error || "Watch check failed.");
      await this.render();
    });
    actionButton(actions, row.active ? "pause" : "play", row.active ? "Pause" : "Resume", async () => {
      await this.plugin.toggleWatchStatus(row.definition.path);
      await this.render();
    });
    actionButton(actions, "external-link", "Open", () => this.plugin.openWatchFile(row.definition.path));
  }
}

function actionButton(
  parent: HTMLElement,
  icon: string,
  label: string,
  action: () => void | Promise<void>,
  withText = false,
): HTMLButtonElement {
  const button = parent.createEl("button", { cls: "clickable-icon tps-watch-action" });
  setIcon(button, icon);
  if (withText) button.createSpan({ text: label });
  button.setAttr("aria-label", label);
  button.setAttr("title", label);
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    void action();
  });
  return button;
}

function conditionLabel(condition: string, target: string): string {
  const labels: Record<string, string> = {
    changed: "Changes",
    "new-item": "New item",
    contains: "Contains",
    "not-contains": "Does not contain",
    equals: "Equals",
    above: "Above",
    below: "Below",
    available: "Availability",
  };
  return labels[condition] + (target ? " · " + target : "");
}

function relativeTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "Unknown check time";
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "Checked just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return "Checked " + minutes + "m ago";
  const hours = Math.round(minutes / 60);
  if (hours < 48) return "Checked " + hours + "h ago";
  return "Checked " + Math.round(hours / 24) + "d ago";
}
