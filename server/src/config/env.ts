import os from "node:os";
import path from "node:path";

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Comma-separated list env var -> trimmed, non-empty entries. Falls back to
 * `fallback` when unset (not merged with it — an explicit override replaces the
 * default list entirely, same convention as the other env vars in this file).
 */
function list(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return parsed.length > 0 ? parsed : fallback;
}

/**
 * Security-review finding (Critical, /tgd-review security-auditor): the previous
 * `app.use(cors())` in index.ts used the `cors` package's wildcard default
 * (`Access-Control-Allow-Origin: *`), which combined with zero auth on any route
 * (including the chat route, which drives bash/computer-use/MCP tools) let *any*
 * web page open in the user's regular browser POST arbitrary prompts into the
 * local agent.
 * This is the explicit allowlist of origins this app's own frontend legitimately
 * runs from — everything else gets rejected at the CORS preflight, which browsers
 * require for `Content-Type: application/json` POSTs (not a CORS-"simple" request):
 *  - `http://localhost:1420` — the Vite dev server, per src-tauri/tauri.conf.json's
 *    `build.devUrl`; in `tauri dev` the webview navigates directly to this URL, so
 *    its origin *is* the Vite origin, not a tauri:// one.
 *  - `tauri://localhost` — the packaged webview's origin on macOS and Linux (the
 *    custom-protocol scheme Tauri v2 serves production assets over on those
 *    platforms; confirmed via Tauri v2 docs/migration guide, not assumed).
 *  - `http://tauri.localhost` — the packaged webview's origin on Windows and
 *    Android as of Tauri v2 (changed from the v1 `https://` scheme; this repo's
 *    tauri.conf.json does not set `app.windows.useHttpsScheme`, so the default
 *    `http://` form applies).
 *  - `https://tauri.localhost` — included defensively for Windows/Android in case
 *    `useHttpsScheme` is ever turned on (the v1-compatible form); harmless to
 *    allow since it's still this app's own webview, never a third-party origin.
 * Override/extend via PI_DESKTOP_CORS_ORIGINS (comma-separated) for additional dev
 * origins without a code change — e.g. a different Vite port.
 *
 * Scoped mitigation only, NOT a full auth fix: this closes the demonstrated
 * browser-based cross-origin attack vector but does not add request
 * authentication. A local process (or a non-browser HTTP client) can still reach
 * these routes directly since there is no token/auth check — that remains a
 * separate, larger tracked initiative.
 */
const DEFAULT_CORS_ORIGINS = [
  "http://localhost:1420",
  "tauri://localhost",
  "http://tauri.localhost",
  "https://tauri.localhost",
];

export const env = {
  port: int("PI_DESKTOP_PORT", 4319),
  host: process.env.PI_DESKTOP_HOST ?? "127.0.0.1",
  agentDir: process.env.PI_DESKTOP_AGENT_DIR ?? path.join(os.homedir(), ".pi-desktop"),
  dataDir: process.env.PI_DESKTOP_DATA_DIR ?? path.join(os.homedir(), ".pi-desktop", "data"),
  workspaceDir: process.env.PI_DESKTOP_WORKSPACE_DIR ?? path.join(os.homedir(), ".pi-desktop", "workspace"),
  /** e.g. "anthropic/claude-opus-4-5" — parsed by resolveCliModel(), same as pi's --model flag. */
  modelSpec: process.env.PI_DESKTOP_MODEL,
  corsOrigins: list("PI_DESKTOP_CORS_ORIGINS", DEFAULT_CORS_ORIGINS),
};
