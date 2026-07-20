import fs from "node:fs";
import path from "node:path";
import { env } from "../config/env.js";

export interface SearchSettings { enabled: boolean; provider: "brave"; apiKey?: string; maxResults: number }
const file = () => path.join(env.agentDir, "search-settings.json");
function storedSearchSettings(): Partial<SearchSettings> {
  let stored: Partial<SearchSettings> = {};
  try { stored = JSON.parse(fs.readFileSync(file(), "utf8")) as Partial<SearchSettings>; } catch { /* Defaults/env. */ }
  return stored;
}
export function getSearchSettings(): SearchSettings {
  const stored = storedSearchSettings();
  return { enabled: stored.enabled ?? false, provider: "brave", apiKey: stored.apiKey ?? process.env.BRAVE_SEARCH_API_KEY, maxResults: stored.maxResults ?? 5 };
}
export function publicSearchSettings() {
  const settings = getSearchSettings();
  return { enabled: settings.enabled, provider: settings.provider, keyPresent: !!settings.apiKey, maxResults: settings.maxResults };
}
export function updateSearchSettings(patch: { enabled?: boolean; provider?: "brave"; apiKey?: string; maxResults?: number }) {
  const stored = storedSearchSettings();
  const updated: SearchSettings = {
    enabled: patch.enabled ?? stored.enabled ?? false,
    provider: "brave",
    apiKey: patch.apiKey ?? stored.apiKey,
    maxResults: patch.maxResults ?? stored.maxResults ?? 5,
  };
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(updated, null, 2), { mode: 0o600 });
  return publicSearchSettings();
}
