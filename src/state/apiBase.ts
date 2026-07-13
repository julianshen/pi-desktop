/**
 * Task 11: extracted from useConversations.ts (Task 9) so every REST-calling
 * frontend hook/component shares one derivation instead of reimplementing it.
 *
 * Same derivation App.tsx already uses for the CopilotKit runtime URL
 * (`VITE_COPILOTKIT_RUNTIME_URL ?? "http://127.0.0.1:4319/copilotkit"`), stripping the
 * `/copilotkit` suffix rather than introducing a second, independently-configurable env
 * var — the REST API and the AG-UI endpoint are the same server (server/src/index.ts),
 * so there is exactly one base URL to point at, not two knobs that could drift apart.
 */
const RUNTIME_URL = import.meta.env.VITE_COPILOTKIT_RUNTIME_URL ?? "http://127.0.0.1:4319/copilotkit";
export const API_BASE = RUNTIME_URL.replace(/\/copilotkit\/?$/, "");
