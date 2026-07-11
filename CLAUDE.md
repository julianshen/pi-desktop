# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

pi-desktop is a single-package Tauri v2 desktop app that hosts an AI agent built on
[pi](https://pi.dev/docs/latest/sdk) (`@earendil-works/pi-coding-agent`), exposed through a
[CopilotKit](https://docs.copilotkit.ai/) chat UI over the [AG-UI](https://docs.ag-ui.com) protocol.
It adds everything pi's minimal core deliberately leaves out — MCP, computer use, scheduled
agents, and local memory/RAG — as hand-built extensions, and lives in the system tray.

## Commands

```bash
npm install              # installs the root workspace + server/ workspace together

npm run dev               # Vite + the Bun server, concurrently — frontend only, no native window
npm run tauri dev         # full desktop app: runs the above via beforeDevCommand, then opens the window

npm run typecheck         # tsc --noEmit at root + in server/ (Bun runs TS directly, no build step)
npm run lint               # alias for typecheck (no separate linter configured)
cd src-tauri && cargo check   # Rust-only typecheck for the shell

npm run sidecar:build     # required before a real package build — see "Packaging" below
npm run tauri build        # full packaged app (installer/bundle)
```

There is no test suite yet.

To run only the server standalone: `npm run server:dev` (or `bun --watch src/index.ts` inside
`server/`). It listens on `http://127.0.0.1:4319` by default (`PI_DESKTOP_PORT`/`PI_DESKTOP_HOST`).

## Runtime

Everything JS/TS runs on **Bun**, not Node — both in dev (`bun --watch`) and once packaged (see
"Packaging"). The frontend build still goes through Vite/tsc since it's shipped as static assets
into the Tauri webview, not executed as a standalone JS runtime.

## Architecture

Three processes make up the app:

1. **`src-tauri/`** — the Rust/Tauri v2 shell. Owns the native window, the tray icon and its
   menu (Show/Hide/Quit), and closes-to-tray instead of quitting (`on_window_event` +
   `prevent_close()` in `src-tauri/src/lib.rs`). It does **not** talk to the agent — the frontend
   calls the server directly over HTTP.
2. **`server/`** — a Bun/TypeScript HTTP server that owns all agent logic (pi session, tools,
   MCP, scheduler, memory). See below.
3. **`src/`** — a React/Vite frontend that is just a CopilotKit chat surface (`src/App.tsx`)
   pointed at the server's `/copilotkit` endpoint. No Tauri IPC is used for the chat protocol.

**Dev vs. packaged startup differ**, which matters if you touch process lifecycle: in dev,
`tauri.conf.json`'s `beforeDevCommand` (`npm run dev`) starts the server as a plain concurrent
process alongside Vite, and `src-tauri/src/lib.rs` skips spawning anything (`cfg!(debug_assertions)`
guard). In a packaged build there is no dev server, so `lib.rs`'s `setup()` spawns the sidecar
itself via `tauri-plugin-shell`.

### The pi SDK reality (read before adding agent features)

pi (`@earendil-works/pi-coding-agent`) is a minimal coding-agent kernel — TS/JS only, session
management + streaming events + custom tools + skills. It has **no built-in MCP, computer use,
scheduling, or AG-UI support** by design (its own docs: "build extensions instead"). Every one of
those capabilities in this repo is hand-built glue in `server/src/*`, not something pi provides.
Keep that in mind before assuming a pi API exists — verify against the installed package's own
`.d.ts` / bundled `docs/sdk.md` rather than training-data assumptions; this SDK's actual exports
diverge from its own doc prose in places (e.g. `getModel` isn't exported from the package root
despite the docs showing that import — use `resolveCliModel` from
`@earendil-works/pi-coding-agent`, as `server/src/agent/deps.ts` does).

### Server layout (`server/src/`)

- **`agent/deps.ts`** — builds auth storage, model registry, and the combined custom-tool set
  (memory + computer-use + MCP) **once**, memoized, because MCP tool loading spawns subprocesses.
  Shared by both the interactive session and every scheduled run.
- **`agent/session.ts`** — the single long-lived interactive chat session, persisted via
  `SessionManager.continueRecent(workspaceDir)`. Deliberately separate from scheduled-task sessions
  so background runs don't intermix with live chat history.
- **`agui/adapter.ts`** — the actual AG-UI bridge: subscribes to pi's own `AgentSessionEvent`
  stream (`message_update`/`tool_execution_*`/`agent_end`, not AG-UI's shape) and re-emits it as
  AG-UI protocol events (`RUN_STARTED`, `TEXT_MESSAGE_*`, `TOOL_CALL_*`, `RUN_FINISHED`) via
  `@ag-ui/encoder`'s SSE encoder. This is the piece that doesn't exist anywhere upstream — pi and
  AG-UI know nothing about each other.
- **`copilot/runtime.ts`** — mounts `@copilotkit/runtime` and registers the AG-UI endpoint above as
  a remote `HttpAgent` under the key `"default"`, so the frontend needs no per-component agent
  selection.
- **`mcp/client.ts`** — reads `<agentDir>/mcp-servers.json` (same `{ mcpServers: { name: {
  command, args, env } } }` shape as Claude Desktop), connects over stdio, and exposes each
  server's tools as pi custom tools namespaced `mcp_<server>_<tool>`, using `Type.Unsafe()` to pass
  through MCP's raw JSON Schema into pi's TypeBox-typed tool parameters.
- **`computer-use/tools.ts`** — mouse/keyboard via `@nut-tree/nut-js`, screenshots via
  `screenshot-desktop`.
- **`scheduler/index.ts`** — reads `<agentDir>/scheduled-agents.json`, runs each task on its own
  `node-cron` schedule against its **own** persisted session (keyed by task id under `dataDir`,
  not the interactive session).
- **`memory/`** — local RAG, no API key required: embeddings via `@xenova/transformers`
  (`Xenova/all-MiniLM-L6-v2`, runs locally), storage via **`bun:sqlite`** with an in-process
  brute-force cosine-similarity scan (`memory/store.ts`) instead of the `sqlite-vec` extension —
  Bun's bundled SQLite build can't dynamically load extensions, and at the scale of a desktop
  memory store (hundreds–low thousands of entries) a JS-side scan is plenty fast. Don't reach for
  `sqlite-vec` here without re-checking that constraint.
- Skills need no code — `createAgentSession({ cwd: workspaceDir, agentDir })` gives pi's own
  `DefaultResourceLoader` its standard discovery paths (`<workspaceDir>/.pi/skills/`,
  `<agentDir>/skills/`, etc.).

### Data directories (all under `~/.pi-desktop` by default, overridable via `PI_DESKTOP_*` env vars)

- `agentDir` (`~/.pi-desktop`) — `auth.json`, `models.json`, `mcp-servers.json`,
  `scheduled-agents.json`, `skills/`, `extensions/`.
- `dataDir` (`~/.pi-desktop/data`) — `memory.sqlite3`, `scheduled/<task-id>/` session state,
  `scheduler-logs/`.
- `workspaceDir` (`~/.pi-desktop/workspace`) — `cwd` for the interactive session; where the
  built-in `read`/`bash`/`edit`/`write` tools and project-level `.pi/skills` operate.
- Model selection: `PI_DESKTOP_MODEL` (e.g. `anthropic/claude-opus-4-5`), parsed via
  `resolveCliModel`. Unset falls back to pi's own default resolution (settings, then first
  available model).

### Packaging (the sidecar)

`npm run sidecar:build` (`server/scripts/build-sidecar.ts`) does **not** use `bun build --compile`.
transformers.js's `onnxruntime-node`/`sharp` native and WASM assets don't survive being embedded
into a single-file compiled executable (their runtime asset loading assumes a real filesystem
path — confirmed by hitting dlopen/WASM-path failures when this was tried). Instead the script:

1. Copies the `bun` binary itself into `src-tauri/binaries/pi-desktop-server-<target-triple>` —
   this is the actual Tauri sidecar (`bundle.externalBin` in `tauri.conf.json`).
2. Installs a production-only copy of `server/` into `src-tauri/resources/server/`, bundled via
   `bundle.resources`.
3. `lib.rs` spawns the sidecar with the resource dir's `server/src/index.ts` as its argument —
   i.e. the packaged app runs `bun <resource-path>/index.ts`, same as dev, just via a bundled Bun
   instead of one on `$PATH`.

Re-run `npm run sidecar:build` any time `server/` changes before `npm run tauri build` — it isn't
wired into `beforeBuildCommand` automatically. Building for another platform requires running this
script on that platform (standard Tauri sidecar cross-compilation limitation).

`bun install --production` in that resources copy intentionally leaves 3 postinstall scripts
untrusted (`sharp`, `protobufjs`, `@scarf/scarf` — none are on pi-desktop's code path: sharp is
unused image tooling, protobufjs falls back to its bundled generated code, scarf is a telemetry
beacon). Run `bun pm trust <name>` yourself in `src-tauri/resources/server/` if you have a reason
to need one of them built.
