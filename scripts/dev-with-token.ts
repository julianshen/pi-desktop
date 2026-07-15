#!/usr/bin/env bun
/**
 * Wraps `npm run dev`'s normal `concurrently` invocation to generate a single
 * dev-mode "resolve token" and export it under BOTH env var names the two
 * child processes need:
 *
 *   - PI_DESKTOP_RESOLVE_TOKEN — read by the Bun server to authenticate
 *     `POST .../resolve` requests via the `X-Resolve-Token` header.
 *   - VITE_RESOLVE_TOKEN       — the identical value, but under a
 *     `VITE_`-prefixed name, because Vite only injects `VITE_`-prefixed env
 *     vars into the client bundle's `import.meta.env` by design. The
 *     frontend falls back to reading this when no Tauri IPC bridge is
 *     present (i.e. under plain `npm run dev`, which opens no native window).
 *
 * Why this exists at all instead of a plain `concurrently` call: see
 * ADR-001 ("Trust-boundary separation for the pending-interaction resolve
 * endpoint"), §5 "Dev mode fallback" and the Addendum at the bottom —
 * pi-desktop-tGD/web-fetch/decisions/ADR-001-resolve-endpoint-trust-boundary.md.
 * In packaged builds (and `npm run tauri dev`) the token instead originates
 * in Rust and is handed to the frontend only via `invoke()` and to the
 * server only via stdin — channels an unrestricted `bash` tool can't
 * observe. Plain `npm run dev` has no Rust process to originate that
 * handoff at all, so it falls back to this weaker (documented,
 * accepted-risk) env-var-based mechanism instead. Both `vite` and the
 * server must see the SAME token — generating it once here, before
 * `concurrently` spawns either child, is what guarantees that; a `predev`
 * lifecycle script can't do this because npm lifecycle scripts run in their
 * own separate process and can't export env vars back into `dev`.
 *
 * This script does nothing but: generate the token, spawn the existing
 * `concurrently -n web,server -c blue,green "vite" "npm run dev -w server"`
 * command with that token added to its environment, and forward signals /
 * exit code so `npm run dev`'s behavior (including clean Ctrl+C shutdown of
 * both children) is otherwise unchanged.
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

const resolveToken = randomUUID();

console.log(
  `[dev-with-token] generated dev-mode resolve token (${resolveToken.length} chars) ` +
    "for PI_DESKTOP_RESOLVE_TOKEN / VITE_RESOLVE_TOKEN (see ADR-001)",
);

const child = spawn(
  "concurrently",
  ["-n", "web,server", "-c", "blue,green", "vite", "npm run dev -w server"],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      PI_DESKTOP_RESOLVE_TOKEN: resolveToken,
      VITE_RESOLVE_TOKEN: resolveToken,
    },
  },
);

// Forward Ctrl+C / termination to the child so both `vite` and the server
// shut down cleanly, matching the plain `concurrently` invocation's behavior.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    child.kill(signal);
  });
}

child.on("exit", (code, signal) => {
  if (signal) {
    // Re-raise the same signal on ourselves so the parent shell sees the
    // conventional 128+n exit status instead of a bare 0/1.
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
