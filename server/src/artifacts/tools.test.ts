import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * tools.ts -> store.ts -> ../agent/conversations.js, which reads env.ts into a
 * module-level constant at import time — same dynamic-import-after-env-setup
 * pattern as agent/conversations.test.ts and artifacts/store.test.ts.
 *
 * Like store.test.ts, this file deliberately never calls
 * conversations.createConversation()/listConversations() — only
 * conversationCwd(), a pure function of env.dataDir with no registry
 * side effects — so it can't collide with agent/conversations.test.ts's exact-
 * emptiness assertions against the shared conversations registry, regardless of
 * which test file's env vars end up backing the process-wide env.js singleton
 * (see store.test.ts's beforeAll comment for the full explanation).
 */
let tools: typeof import("./tools.js");
let store: typeof import("./store.js");
let conversationCwd: typeof import("../agent/conversations.js").conversationCwd;
let tmpRoot: string;

beforeAll(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-artifacts-tools-test-"));
  process.env.PI_DESKTOP_AGENT_DIR = path.join(tmpRoot, "agent");
  process.env.PI_DESKTOP_DATA_DIR = path.join(tmpRoot, "data");
  process.env.PI_DESKTOP_WORKSPACE_DIR = path.join(tmpRoot, "workspace");
  delete process.env.PI_DESKTOP_MODEL;

  ({ conversationCwd } = await import("../agent/conversations.js"));
  store = await import("./store.js");
  tools = await import("./tools.js");
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("artifact tools", () => {
  // AC-7.3 [R] — Given an agent session with createArtifactTools(id) wired in, when
  // the agent calls publish_artifact with valid params, then getLatestArtifact(id)
  // reflects the published content (tool executes and persists correctly).
  //
  // conversations.ts's createSession() wires createArtifactTools(id)'s output
  // straight into the AgentSession's customTools (see agent/conversations.ts), but
  // AgentSession exposes no public way to list/invoke its installed tools outside a
  // real LLM turn. So this exercises the exact same defineTool()-wrapped tool
  // object directly -- calling its own execute() with a fake toolCallId, mirroring
  // how the agent runtime itself would invoke it -- which is both the load-bearing
  // per-conversation wiring point and the full persistence path, without needing a
  // live model call.
  test("AC-7.3: publish_artifact tool execute() persists content visible via getLatestArtifact()", async () => {
    const conversationId = randomUUID();
    const [publishArtifact] = tools.createArtifactTools(conversationId);

    expect(publishArtifact.name).toBe("publish_artifact");

    const params = {
      id: "chart-1",
      title: "WAU chart",
      language: "tsx",
      code: "export const Chart = () => null;",
    };

    const result = await publishArtifact.execute(
      "fake-tool-call-id",
      params,
      undefined,
      undefined,
      {} as ExtensionContext,
    );

    expect(result.details).toEqual({ id: "chart-1" });
    expect(result.content[0]).toMatchObject({ type: "text" });

    const latest = store.getLatestArtifact(conversationId);
    expect(latest?.id).toBe("chart-1");
    expect(latest?.title).toBe("WAU chart");
    expect(latest?.language).toBe("tsx");
    expect(latest?.code).toBe(params.code);
    expect(latest?.publishedAt).toBeTruthy();
  });

  test("createArtifactTools() scopes publish_artifact to the given conversationId — no cross-conversation leakage", async () => {
    const a = randomUUID();
    const b = randomUUID();
    const [publishA] = tools.createArtifactTools(a);

    await publishA.execute(
      "call-1",
      { id: "only-a", title: "A", language: "text", code: "a" },
      undefined,
      undefined,
      {} as ExtensionContext,
    );

    expect(store.getLatestArtifact(a)?.id).toBe("only-a");
    expect(store.getLatestArtifact(b)).toBeUndefined();
  });

  // AC-7.2 [R] regression, exercised through the tool rather than the store
  // directly: publishing with the same id twice via the tool must overwrite, not
  // duplicate, matching store.test.ts's direct-store coverage of the same contract.
  test("AC-7.2: re-invoking publish_artifact with the same id overwrites instead of duplicating", async () => {
    const conversationId = randomUUID();
    const [publishArtifact] = tools.createArtifactTools(conversationId);

    await publishArtifact.execute(
      "call-1",
      { id: "x", title: "V1", language: "text", code: "v1" },
      undefined,
      undefined,
      {} as ExtensionContext,
    );
    await publishArtifact.execute(
      "call-2",
      { id: "x", title: "V2", language: "text", code: "v2" },
      undefined,
      undefined,
      {} as ExtensionContext,
    );

    expect(store.getLatestArtifact(conversationId)?.code).toBe("v2");

    const raw = JSON.parse(
      fs.readFileSync(path.join(conversationCwd(conversationId), "artifacts.json"), "utf8"),
    ) as Array<{ id: string }>;
    expect(raw.filter((entry) => entry.id === "x")).toHaveLength(1);
  });
});
