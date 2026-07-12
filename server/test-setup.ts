import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Bun test preload (see bunfig.toml's [test].preload) — runs once, before any test
 * file's own top-level imports are evaluated.
 *
 * Without this, whichever test file's import graph happens to reach
 * "src/config/env.js" first wins: env.ts reads process.env into a module-level
 * constant at import time, and ESM module caching means later re-imports (even
 * dynamic ones, as agent/conversations.test.ts uses) never re-evaluate it. In
 * practice `bun test` (the full suite) loads every test file's static imports during
 * discovery before any beforeAll() runs — e.g. agent/models.test.ts's static
 * `import ... from "./models.js"` chain (models.ts -> deps.ts -> config/env.js) — so
 * env.ts got initialized from real, unset process.env, i.e. the real
 * ~/.pi-desktop paths, *before* agent/conversations.test.ts's beforeAll ever got a
 * chance to point it at a scratch directory. That silently pointed every full-suite
 * test run at (and mutated) the developer's real on-disk ~/.pi-desktop directory.
 *
 * Setting a process-wide scratch root here guarantees env.ts always bakes in a
 * throwaway directory no matter which file's import graph touches it first.
 */
const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-test-"));
process.env.PI_DESKTOP_AGENT_DIR = path.join(scratchRoot, "agent");
process.env.PI_DESKTOP_DATA_DIR = path.join(scratchRoot, "data");
process.env.PI_DESKTOP_WORKSPACE_DIR = path.join(scratchRoot, "workspace");
delete process.env.PI_DESKTOP_MODEL;
