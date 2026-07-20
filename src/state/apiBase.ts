/**
 * Task 11: extracted from useConversations.ts (Task 9) so every REST-calling
 * frontend hook/component shares one derivation instead of reimplementing it.
 *
 * Post-/tgd-review remediation (found alongside the CopilotKit/AG-UI stack
 * deletion, server/src/copilot/ and server/src/agui/): this used to read
 * `VITE_COPILOTKIT_RUNTIME_URL` (default `"http://127.0.0.1:4319/copilotkit"`)
 * and strip a trailing `/copilotkit` suffix, because the REST API and the
 * CopilotKit runtime endpoint were the same server on the same base URL and
 * this avoided a second, independently-configurable env var that could drift
 * out of sync. The CopilotKit runtime endpoint (`/copilotkit`) no longer
 * exists — deleted along with `server/src/copilot/runtime.ts` — so keeping an
 * env var named after it, with a default pointing at a route that 404s, would
 * be exactly the kind of dead reference that remediation was about. Renamed to
 * `VITE_SERVER_BASE_URL`; no known deployment has this configured yet (this
 * migration hasn't shipped a release with it), so there's no compatibility
 * cost to renaming now rather than carrying the stale name forward.
 */
const SERVER_BASE_URL_DEFAULT = "http://127.0.0.1:4319";
export const API_BASE = import.meta.env.VITE_SERVER_BASE_URL ?? SERVER_BASE_URL_DEFAULT;
