/**
 * Same env var (and same fallback host/port) `apiBase.ts`'s `API_BASE` uses — derived
 * independently here since `API_BASE` isn't a bare origin (kept in sync manually; do
 * not hardcode a second, divergent default port/host).
 *
 * Post-/tgd-review remediation: renamed from `VITE_COPILOTKIT_RUNTIME_URL` alongside
 * deleting `server/src/copilot/` and `server/src/agui/` — see `apiBase.ts`'s own doc
 * comment for the full rationale. Only the plain HTTP origin is exported (not a
 * path-preserving base) — settings views call REST endpoints under the server root
 * (`/api/settings/...`), so any path component would be irrelevant here even if one
 * were configured.
 */
const SERVER_BASE_URL = import.meta.env.VITE_SERVER_BASE_URL ?? "http://127.0.0.1:4319";

export const SERVER_ORIGIN = new URL(SERVER_BASE_URL).origin;
