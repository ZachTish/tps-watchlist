import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const settingsTabSource = readFileSync(new URL("../src/settings-tab.ts", import.meta.url), "utf8");
const settingsSource = readFileSync(new URL("../src/settings.ts", import.meta.url), "utf8");
const typesSource = readFileSync(new URL("../src/types.ts", import.meta.url), "utf8");
const stylesSource = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const readmeSource = readFileSync(new URL("../README.md", import.meta.url), "utf8");

test("Watchlist settings expose three shallow routed destinations", () => {
  const destinationsStart = settingsTabSource.indexOf("const WATCHLIST_SETTINGS_DESTINATIONS");
  const destinationsEnd = settingsTabSource.indexOf("export class WatchlistSettingTab", destinationsStart);
  const destinationsSource = settingsTabSource.slice(destinationsStart, destinationsEnd);

  for (const route of ["checks-reliability", "files-events", "notifications-logs"]) {
    assert.match(destinationsSource, new RegExp(`id: "${route}"`));
    assert.match(settingsTabSource, new RegExp(`this\\.activeSettingsPage === "${route}"`));
  }
  assert.equal((destinationsSource.match(/\bid: "/g) || []).length, 3);
  assert.match(settingsTabSource, /private activeSettingsPage: WatchlistSettingsPage = "checks-reliability"/);
  assert.match(settingsTabSource, /text: "Choose what to configure"/);
  assert.doesNotMatch(settingsTabSource, /createEl\("details"/);
  assert.doesNotMatch(settingsTabSource, /createEl\("summary"/);
  assert.doesNotMatch(settingsSource, /\bactiveSettingsPage\b/);
  assert.doesNotMatch(typesSource, /\bactiveSettingsPage\b/);
});

test("Watchlist settings retain every persisted user control and action", () => {
  const persistedKeys = [
    "executionMode",
    "defaultIntervalMinutes",
    "schedulerTickSeconds",
    "requestTimeoutSeconds",
    "maxConcurrentChecks",
    "failureAlertThreshold",
    "notifyOnFailure",
    "defaultFolder",
    "watchlistBasePath",
    "watchEventsBasePath",
    "eventLogTarget",
    "defaultNotify",
    "enableLogging",
  ];

  for (const key of persistedKeys) {
    assert.match(settingsTabSource, new RegExp(`\\b${key}\\b`), `missing settings control for ${key}`);
    assert.match(settingsSource, new RegExp(`\\b${key}\\b`), `missing persisted default for ${key}`);
  }
  assert.doesNotMatch(settingsTabSource, /\bsettingsVersion\b/);
  assert.match(settingsTabSource, /this\.plugin\.ensureBases\(\)/);
  assert.match(settingsTabSource, /this\.plugin\.openCreateModal\(\)/);
  assert.match(settingsTabSource, /this\.plugin\.openDashboard\(\)/);
  assert.match(settingsTabSource, /setButtonText\("Ensure Bases"\)/);
  assert.match(settingsTabSource, /text\.inputEl\.min = String\(min\)/);
  assert.match(settingsTabSource, /text\.inputEl\.max = String\(max\)/);
});

test("Watchlist settings routing is accessible, focus-safe, and responsive", () => {
  assert.match(settingsTabSource, /hub\.setAttr\("role", "group"\)/);
  assert.match(settingsTabSource, /hub\.setAttr\("aria-label", "TPS Watchlist settings pages"\)/);
  assert.match(settingsTabSource, /button\.type = "button"/);
  assert.match(settingsTabSource, /button\.setAttr\("aria-pressed"/);
  assert.match(settingsTabSource, /heading\.setAttr\("tabindex", "-1"\)/);
  assert.match(settingsTabSource, /focus\(\{ preventScroll: true \}\)/);
  assert.match(settingsTabSource, /scrollIntoView\(\{ block: "nearest", inline: "nearest" \}\)/);
  assert.match(settingsTabSource, /heading\?\.scrollIntoView\(\{ block: "start" \}\)/);

  assert.match(stylesSource, /\.tps-watch-settings-hub\s*\{[\s\S]*position: sticky/);
  assert.match(stylesSource, /\.tps-watch-settings-route-button:focus-visible/);
  assert.match(stylesSource, /\.tps-watch-settings-page > h3:focus-visible/);
  assert.match(stylesSource, /\.tps-watch-settings-route-button\[aria-pressed="true"\]/);
  assert.match(stylesSource, /@media \(max-width: 640px\)[\s\S]*\.tps-watch-settings-hub\s*\{[\s\S]*display: flex[\s\S]*overflow-x: auto/);
  assert.match(stylesSource, /@media \(max-width: 640px\)[\s\S]*\.tps-watch-settings-page \.setting-item-control[\s\S]*width: 100%/);
  assert.doesNotMatch(stylesSource, /(?:^|\n)\.tps-settings-/);
});

test("Watchlist README documents the routed settings contract", () => {
  assert.match(readmeSource, /\*\*Checks & reliability\*\*/);
  assert.match(readmeSource, /\*\*Files & events\*\*/);
  assert.match(readmeSource, /\*\*Notifications & logs\*\*/);
  assert.match(readmeSource, /Create watch/);
  assert.match(readmeSource, /Open Watchlist/);
  assert.match(readmeSource, /No settings key was renamed or migrated/);
});
