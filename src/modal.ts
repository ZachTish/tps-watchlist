import { App, Modal, Notice, Setting, TFile } from "obsidian";
import type { CreateWatchInput, WatchCondition, WatchProvider } from "./types";

export interface CreateWatchHost {
  app: App;
  createWatch(input: CreateWatchInput): Promise<TFile>;
}

export class CreateWatchModal extends Modal {
  private input: CreateWatchInput = {
    title: "",
    url: "",
    provider: "page",
    selector: "",
    jsonPath: "",
    pattern: "",
    query: "",
    condition: "changed",
    target: "",
    intervalMinutes: 15,
    notify: true,
    cooldownMinutes: 0,
    caseSensitive: false,
    tags: [],
  };
  private submitting = false;

  constructor(private host: CreateWatchHost, defaultIntervalMinutes: number, defaultNotify: boolean) {
    super(host.app);
    this.input.intervalMinutes = defaultIntervalMinutes;
    this.input.notify = defaultNotify;
  }

  onOpen(): void {
    this.modalEl.addClass("tps-keyboard-aware-modal", "tps-watch-modal");
    this.contentEl.empty();
    this.setTitle("Create watch");
    this.contentEl.createEl("p", {
      cls: "tps-watch-modal-intro",
      text: "Create a durable monitor. The first successful check becomes a silent baseline; notifications begin only after a meaningful transition.",
    });

    new Setting(this.contentEl)
      .setName("Title")
      .setDesc("Human-readable name for the watch note.")
      .addText((text) => text
        .setPlaceholder("Herman Miller Embody under $900")
        .onChange((value) => { this.input.title = value.trim(); }));

    new Setting(this.contentEl)
      .setName("Source URL")
      .setDesc("HTTP or HTTPS page, JSON endpoint, RSS feed, or Atom feed.")
      .addText((text) => text
        .setPlaceholder("https://example.com/product")
        .onChange((value) => { this.input.url = value.trim(); }));

    new Setting(this.contentEl)
      .setName("Provider")
      .setDesc("How TPS Watchlist should extract the monitored value.")
      .addDropdown((dropdown) => dropdown
        .addOption("page", "Web page")
        .addOption("json", "JSON API")
        .addOption("rss", "RSS / Atom")
        .setValue(this.input.provider || "page")
        .onChange((value) => {
          this.input.provider = value as WatchProvider;
        }));

    new Setting(this.contentEl)
      .setName("Condition")
      .setDesc("Transition that creates an event and notification.")
      .addDropdown((dropdown) => dropdown
        .addOption("changed", "Value changed")
        .addOption("new-item", "New feed item")
        .addOption("contains", "Contains text")
        .addOption("not-contains", "Does not contain text")
        .addOption("equals", "Equals")
        .addOption("above", "Number above")
        .addOption("below", "Number below")
        .addOption("available", "Becomes available")
        .setValue(this.input.condition || "changed")
        .onChange((value) => { this.input.condition = value as WatchCondition; }));

    new Setting(this.contentEl)
      .setName("Target")
      .setDesc("Required for text, equality, and numeric threshold conditions. Availability can leave this blank.")
      .addText((text) => text
        .setPlaceholder("900 or in stock")
        .onChange((value) => { this.input.target = value.trim(); }));

    new Setting(this.contentEl)
      .setName("CSS selector")
      .setDesc("Web page element to monitor, such as .price or button.add-to-cart. Blank monitors the page text.")
      .addText((text) => text
        .setPlaceholder(".product-price")
        .onChange((value) => { this.input.selector = value.trim(); }));

    new Setting(this.contentEl)
      .setName("JSON path")
      .setDesc("Required for JSON providers. Dot and bracket paths are supported.")
      .addText((text) => text
        .setPlaceholder("$.quote.price")
        .onChange((value) => { this.input.jsonPath = value.trim(); }));

    new Setting(this.contentEl)
      .setName("Extraction pattern")
      .setDesc("Optional regular expression. Capture group 1 becomes the monitored value.")
      .addText((text) => text
        .setPlaceholder("\\$([\\d,.]+)")
        .onChange((value) => { this.input.pattern = value; }));

    new Setting(this.contentEl)
      .setName("Feed query")
      .setDesc("Optional text required in an RSS/Atom item's title, summary, content, or categories.")
      .addText((text) => text
        .setPlaceholder("robotics IPO")
        .onChange((value) => { this.input.query = value.trim(); }));

    new Setting(this.contentEl)
      .setName("Check interval")
      .setDesc("Per-watch cadence in minutes.")
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.min = "1";
        text.inputEl.max = "10080";
        text.setValue(String(this.input.intervalMinutes));
        text.onChange((value) => { this.input.intervalMinutes = Number(value); });
      });

    new Setting(this.contentEl)
      .setName("Cooldown")
      .setDesc("Optional minimum minutes between emitted events. Transition deduplication still applies without a cooldown.")
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.min = "0";
        text.setValue(String(this.input.cooldownMinutes));
        text.onChange((value) => { this.input.cooldownMinutes = Number(value); });
      });

    new Setting(this.contentEl)
      .setName("Tags")
      .setDesc("Optional comma-separated cross-cutting labels.")
      .addText((text) => text
        .setPlaceholder("furniture, office")
        .onChange((value) => {
          this.input.tags = value.split(",").map((tag) => tag.trim().replace(/^#/, "")).filter(Boolean);
        }));

    new Setting(this.contentEl)
      .setName("Case-sensitive matching")
      .addToggle((toggle) => toggle
        .setValue(this.input.caseSensitive === true)
        .onChange((value) => { this.input.caseSensitive = value; }));

    new Setting(this.contentEl)
      .setName("Send notifications")
      .setDesc("Use TPS Notifier when available and fall back to an Obsidian notice.")
      .addToggle((toggle) => toggle
        .setValue(this.input.notify !== false)
        .onChange((value) => { this.input.notify = value; }));

    const actions = this.contentEl.createDiv({ cls: "tps-watch-modal-actions" });
    const cancel = actions.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.close());
    const submit = actions.createEl("button", { cls: "mod-cta", text: "Create and baseline" });
    submit.addEventListener("click", () => void this.submit(submit));
  }

  private async submit(button: HTMLButtonElement): Promise<void> {
    if (this.submitting) return;
    if (!this.input.title?.trim()) {
      new Notice("Watch title is required.");
      return;
    }
    if (!/^https?:\/\//i.test(this.input.url?.trim() || "")) {
      new Notice("Watch source must be an HTTP or HTTPS URL.");
      return;
    }
    this.submitting = true;
    button.disabled = true;
    button.setText("Creating…");
    try {
      await this.host.createWatch(this.input);
      this.close();
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "Could not create watch.");
      button.disabled = false;
      button.setText("Create and baseline");
    } finally {
      this.submitting = false;
    }
  }
}
