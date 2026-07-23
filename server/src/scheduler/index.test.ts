import { beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getPending } from "../web-fetch/pending-interactions.js";
import type { ScheduledTaskRecord } from "./types.js";

/**
 * Task 7 (TASKS.md) — proves the scheduler's own session-construction wiring
 * (scheduler/index.ts's createScheduledSession(), extracted from runTask() so it's
 * testable without a real model/auth setup or a live session.prompt() call)
 * actually builds `web_fetch` with `sessionKind: "scheduled"`, not "interactive".
 *
 * env.ts reads process.env into a module-level constant at import time, so the
 * scratch PI_DESKTOP_* dirs must be set before scheduler/index.ts (and its
 * transitive env.js/deps.js imports) is ever loaded -- same dynamic-import-in-
 * beforeAll pattern as agent/conversations.test.ts.
 */
let scheduler: typeof import("./index.js");

beforeAll(async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-scheduler-test-"));
  process.env.PI_DESKTOP_AGENT_DIR = path.join(tmpRoot, "agent");
  process.env.PI_DESKTOP_DATA_DIR = path.join(tmpRoot, "data");
  process.env.PI_DESKTOP_WORKSPACE_DIR = path.join(tmpRoot, "workspace");
  delete process.env.PI_DESKTOP_MODEL;

  scheduler = await import("./index.js");
});

/** A ctx.ui.confirm() that throws if ever called -- proves the hard-block path never reaches the approval gate at all (mirrors web-fetch/tools.test.ts's own helper of the same name/intent). */
function buildConfirmMustNotBeCalledContext(): ExtensionContext {
  return {
    ui: {
      confirm: async () => {
        throw new Error("ctx.ui.confirm() must not be called on a scheduled session's web_fetch tool");
      },
    },
  } as unknown as ExtensionContext;
}

const PRIVATE_URL = "http://127.0.0.1:9/private-page";

describe("scheduler session construction", () => {
  // AC-3.2 [R] — Given a scheduled/background agent run, when its session is
  // created, then its web_fetch tool instance was constructed with
  // sessionKind: "scheduled", not "interactive" -- verified by confirming a
  // private-URL call from that session hits the hard-block path (an explicit
  // "not permitted in a background run" error, no pending interaction ever
  // created), not the approval-pending path. Uses the real
  // createScheduledSession()/web_fetch tool obtained via the SDK's own
  // AgentSession#getToolDefinition() introspection -- not a mock, and not a
  // hand-rolled re-implementation of scheduler/index.ts's wiring -- so a
  // regression that accidentally passed "interactive" here (US-05's exact
  // failure mode: an unattended run silently entering the pending-approval
  // state and hanging forever) would be caught by this test actually invoking
  // ctx.ui.confirm() and failing loudly, not by inspecting source text.
  test("AC-3.2 [R]: a scheduled session's web_fetch tool hard-blocks a private URL instead of creating a pending approval", async () => {
    const taskId = `scheduled-task-${Date.now()}`;
    const task: ScheduledTaskRecord = {
      id: taskId,
      name: "Safety test",
      prompt: "Do not run",
      cron: "0 9 * * 1",
      timezone: "UTC",
      enabled: true,
      createdAt: "2026-07-22T00:00:00.000Z",
      updatedAt: "2026-07-22T00:00:00.000Z",
    };
    const runStore = new (await import("./run-store.js")).RunStore(process.env.PI_DESKTOP_DATA_DIR!);
    const session = await scheduler.createScheduledSession(task, { runId: "safety-run", publishFile: () => {} }, runStore);

    expect(session.getActiveToolNames?.()).toContain("web_fetch");
    expect(session.getActiveToolNames?.().some((name) => name.startsWith("computer_") || name.startsWith("mcp_"))).toBe(false);
    const webFetch = session.getToolDefinition?.("web_fetch");
    expect(webFetch).toBeDefined();

    const ctx = buildConfirmMustNotBeCalledContext();
    const result = await webFetch!.execute("call-1", { url: PRIVATE_URL }, undefined, undefined, ctx);

    const text = result.content.map((c) => ("text" in c ? c.text : "")).join("");
    expect(text).toContain(new URL(PRIVATE_URL).host);
    expect(text).toContain("not permitted in a background run");

    // AC-7.2's core proof: no pending interaction was ever created for this
    // conversationId/taskId -- if createScheduledSession() had wired
    // sessionKind: "interactive" instead, the private URL would have called
    // ctx.ui.confirm() (which throws above, failing this test loudly) and
    // created a real pending interaction here.
    expect(getPending(taskId)).toBeUndefined();

    session.dispose();
  });
});
