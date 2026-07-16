import { normalizePath } from "obsidian";
import type { WatchEventLogTarget, WatchExecutionMode, WatchlistSettings } from "./types";

export const DEFAULT_SETTINGS: WatchlistSettings = {
  settingsVersion: 1,
  defaultFolder: "Watches",
  watchlistBasePath: "Watchlist.base",
  watchEventsBasePath: "Watch Events.base",
  defaultIntervalMinutes: 15,
  schedulerTickSeconds: 60,
  executionMode: "controller-only",
  eventLogTarget: "daily-note",
  defaultNotify: true,
  requestTimeoutSeconds: 20,
  maxConcurrentChecks: 3,
  failureAlertThreshold: 3,
  notifyOnFailure: true,
  enableLogging: false,
};

export function sanitizeSettings(value: unknown): WatchlistSettings {
  const raw = record(value);
  const executionMode: WatchExecutionMode = raw.executionMode === "this-device" ? "this-device" : "controller-only";
  const eventLogTarget: WatchEventLogTarget = raw.eventLogTarget === "watch-note" ? "watch-note" : "daily-note";
  return {
    settingsVersion: 1,
    defaultFolder: normalizePath(text(raw.defaultFolder, DEFAULT_SETTINGS.defaultFolder)).replace(/^\/+|\/+$/g, ""),
    watchlistBasePath: basePath(raw.watchlistBasePath, DEFAULT_SETTINGS.watchlistBasePath),
    watchEventsBasePath: basePath(raw.watchEventsBasePath, DEFAULT_SETTINGS.watchEventsBasePath),
    defaultIntervalMinutes: integer(raw.defaultIntervalMinutes, DEFAULT_SETTINGS.defaultIntervalMinutes, 1, 10080),
    schedulerTickSeconds: integer(raw.schedulerTickSeconds, DEFAULT_SETTINGS.schedulerTickSeconds, 30, 3600),
    executionMode,
    eventLogTarget,
    defaultNotify: boolean(raw.defaultNotify, DEFAULT_SETTINGS.defaultNotify),
    requestTimeoutSeconds: integer(raw.requestTimeoutSeconds, DEFAULT_SETTINGS.requestTimeoutSeconds, 5, 120),
    maxConcurrentChecks: integer(raw.maxConcurrentChecks, DEFAULT_SETTINGS.maxConcurrentChecks, 1, 10),
    failureAlertThreshold: integer(raw.failureAlertThreshold, DEFAULT_SETTINGS.failureAlertThreshold, 1, 20),
    notifyOnFailure: boolean(raw.notifyOnFailure, DEFAULT_SETTINGS.notifyOnFailure),
    enableLogging: boolean(raw.enableLogging, false),
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function boolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function integer(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.round(parsed))) : fallback;
}

function basePath(value: unknown, fallback: string): string {
  const normalized = normalizePath(text(value, fallback)).replace(/^\/+/, "");
  return normalized.toLocaleLowerCase().endsWith(".base") ? normalized : normalized + ".base";
}
