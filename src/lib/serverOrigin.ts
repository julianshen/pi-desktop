/**
 * Same env var (and same fallback host/port) App.tsx's RUNTIME_URL uses for the
 * CopilotKit endpoint — derived independently here since RUNTIME_URL isn't exported.
 * Do not hardcode a second, divergent default port/host; keep this in sync with
 * App.tsx's `RUNTIME_URL` if that ever changes.
 *
 * Only the plain HTTP origin is exported (not a path-preserving base) — settings
 * views call REST endpoints under the server root (`/api/settings/...`), not under
 * the CopilotKit path, so any path component of the runtime URL is irrelevant here.
 */
const COPILOTKIT_RUNTIME_URL = import.meta.env.VITE_COPILOTKIT_RUNTIME_URL ?? "http://127.0.0.1:4319/copilotkit";

export const SERVER_ORIGIN = new URL(COPILOTKIT_RUNTIME_URL).origin;
