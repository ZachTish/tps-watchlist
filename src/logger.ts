let enabled = false;

export function setLogging(value: boolean): void {
  enabled = value;
}

export function flow(scope: string, event: string, data: Record<string, unknown> = {}): void {
  if (enabled) console.log("[TPS Watchlist] [" + scope + "] " + event, data);
}

export function warn(scope: string, event: string, data: Record<string, unknown> = {}): void {
  if (enabled) console.warn("[TPS Watchlist] [" + scope + "] " + event, data);
}

export function failure(scope: string, event: string, error: unknown, data: Record<string, unknown> = {}): void {
  console.error("[TPS Watchlist] [" + scope + "] " + event, { ...data, error: errorSummary(error) });
}

export function errorSummary(value: unknown): string {
  return value instanceof Error ? value.message : String(value || "Unknown error");
}
