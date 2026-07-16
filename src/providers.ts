import { requestUrl } from "obsidian";
import {
  createFeedSourceIdentity,
  extractPattern,
  normalizeText,
  observationFingerprint,
  parseNumericValue,
  stableSerialize,
  truncate,
} from "./core";
import type { WatchDefinition, WatchObservation } from "./types";

export async function fetchWatchObservation(
  definition: WatchDefinition,
  timeoutMs: number,
): Promise<WatchObservation> {
  const response = await withTimeout(
    requestUrl({
      url: definition.url,
      method: "GET",
      headers: {
        Accept: definition.provider === "json"
          ? "application/json,text/plain;q=0.9,*/*;q=0.8"
          : definition.provider === "rss"
            ? "application/rss+xml,application/atom+xml,application/xml,text/xml;q=0.9,*/*;q=0.8"
            : "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
      },
      throw: true,
    }),
    timeoutMs,
    "Watch request timed out.",
  );

  if (definition.provider === "json") return fromJson(definition, response.json);
  if (definition.provider === "rss") return fromFeed(definition, response.text);
  return fromPage(definition, response.text);
}

function fromPage(definition: WatchDefinition, html: string): WatchObservation {
  const parser = new DOMParser();
  const document = parser.parseFromString(html, "text/html");
  document.querySelectorAll("script,style,noscript,template,svg").forEach((element) => element.remove());
  let raw = "";
  if (definition.selector) {
    let matches: Element[];
    try {
      matches = Array.from(document.querySelectorAll(definition.selector));
    } catch (error) {
      throw new Error("Invalid watchSelector: " + String(error));
    }
    if (!matches.length) throw new Error("watchSelector matched no elements.");
    raw = matches.map((element) => normalizeText(element.textContent)).filter(Boolean).join(" | ");
  } else {
    raw = normalizeText(document.body?.textContent || document.documentElement.textContent || "");
  }
  if (!raw) throw new Error("The page produced no monitorable text.");
  const extracted = extractPattern(raw, definition.pattern, definition.caseSensitive);
  return observation(definition, extracted, definition.url, undefined, definition.selector ? "Selected page content" : "Page content");
}

function fromJson(definition: WatchDefinition, json: unknown): WatchObservation {
  const value = resolveJsonValue(json, definition.jsonPath);
  const serialized = typeof value === "string" ? value : stableSerialize(value);
  const extracted = extractPattern(serialized, definition.pattern, definition.caseSensitive);
  return observation(definition, extracted, definition.url, undefined, "JSON value");
}

function fromFeed(definition: WatchDefinition, xml: string): WatchObservation {
  const parser = new DOMParser();
  const document = parser.parseFromString(xml, "application/xml");
  if (document.querySelector("parsererror")) throw new Error("The feed response was not valid XML.");
  const candidates = Array.from(document.querySelectorAll("item, entry"));
  if (!candidates.length) throw new Error("The feed contained no items or entries.");
  const query = definition.caseSensitive ? definition.query : definition.query.toLocaleLowerCase();
  const selected = candidates.find((entry) => {
    if (!query) return true;
    const text = feedText(entry);
    return (definition.caseSensitive ? text : text.toLocaleLowerCase()).includes(query);
  });
  if (!selected) throw new Error("No feed item matched watchQuery.");

  const title = normalizeText(selected.querySelector("title")?.textContent || "Untitled feed item");
  const description = normalizeText(
    selected.querySelector("description, summary, content")?.textContent || "",
  );
  const linkElement = selected.querySelector("link");
  const itemLink = normalizeText(linkElement?.getAttribute("href") || linkElement?.textContent || "");
  const publishedAt = normalizeText(selected.querySelector("pubDate, published, updated")?.textContent);
  const sourceId = createFeedSourceIdentity(
    normalizeText(selected.querySelector("guid, id")?.textContent),
    itemLink,
    title,
    publishedAt,
  );
  const combined = title + (description ? " — " + description : "");
  const extracted = extractPattern(combined, definition.pattern, definition.caseSensitive);
  return observation(definition, extracted, itemLink || definition.url, sourceId, title);
}

function feedText(entry: Element): string {
  return normalizeText([
    entry.querySelector("title")?.textContent,
    entry.querySelector("description, summary, content")?.textContent,
    ...Array.from(entry.querySelectorAll("category")).map((element) => element.getAttribute("term") || element.textContent),
  ].filter(Boolean).join(" "));
}

function resolveJsonValue(input: unknown, path: string): unknown {
  const normalized = path.trim().replace(/^\$\.?/, "");
  if (!normalized) return input;
  const tokens = normalized
    .replace(/\[(?:'([^']+)'|"([^"]+)"|(\d+))\]/g, (_match, single, double, index) => "." + (single || double || index))
    .split(".")
    .map((token) => token.trim())
    .filter(Boolean);
  let current = input;
  for (const token of tokens) {
    if (current == null || typeof current !== "object") throw new Error("JSON path stopped before " + token + ".");
    const record = current as Record<string, unknown>;
    if (!(token in record)) throw new Error("JSON path key was not found: " + token);
    current = record[token];
  }
  return current;
}

function observation(
  definition: WatchDefinition,
  value: string,
  sourceUrl: string,
  sourceId: string | undefined,
  label: string,
): WatchObservation {
  const normalized = normalizeText(value);
  if (!normalized) throw new Error("The provider produced an empty value.");
  const displayValue = truncate(normalized, 220);
  return {
    observedAt: new Date().toISOString(),
    value: truncate(normalized, 2000),
    displayValue,
    numericValue: parseNumericValue(normalized),
    fingerprint: observationFingerprint(definition.condition, normalized, sourceId),
    summary: label + ": " + displayValue,
    sourceId,
    sourceUrl,
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutId: number | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = window.setTimeout(() => reject(new Error(message)), Math.max(1000, timeoutMs));
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId != null) window.clearTimeout(timeoutId);
  }
}
