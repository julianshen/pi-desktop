import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import type { Server } from "node:http";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Model, Api } from "@earendil-works/pi-ai";
import type { ConversationMeta } from "./agent/conversations.js";

/**
 * Task 4: exercises the new /api/conversations REST routes end-to-end over real
 * HTTP, mirroring agent/conversations.test.ts's env-isolation pattern (scratch
 * PI_DESKTOP_* dirs set before the first dynamic import of anything that
 * transitively loads config/env.js, since env.ts bakes in process.env at import
 * time and ESM module caching means it never re-reads it afterward).
 *
 * createApp() is imported dynamically (not statically at the top of the file) for
 * that same reason: index.ts's own import of ./agent/conversations.js would
 * otherwise resolve config/env.js against the *real* (unset -> ~/.pi-desktop)
 * environment if this file's static imports were evaluated before beforeAll runs.
 *
 * The app is exercised with plain fetch() against a real app.listen(0) instance on
 * an OS-assigned ephemeral port, torn down in afterAll — server/package.json has no
 * supertest (or similar) devDependency, and the task instructions say not to add
 * one just for this.
 */
/**
 * ADR-001: this file's main app instance now needs a configured resolveToken so
 * the large pre-existing block of ".../resolve" tests below (which predate the
 * ADR-001 auth requirement) keep exercising the route's *other* behaviors
 * (body-shape validation, 404s, promise resolution) rather than being blocked at
 * the very first check by a 401. TEST_RESOLVE_TOKEN is attached via the
 * X-Resolve-Token header on every one of those pre-existing tests; the new
 * "ADR-001 resolve-token auth" describe block below covers the auth check itself,
 * including the no-header / wrong-token / no-server-token cases this constant
 * doesn't exercise.
 */
const TEST_RESOLVE_TOKEN = "test-resolve-token-abc123";

let server: Server;
let baseUrl: string;
let tmpRoot: string;

beforeAll(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-index-test-"));
  process.env.PI_DESKTOP_AGENT_DIR = path.join(tmpRoot, "agent");
  process.env.PI_DESKTOP_DATA_DIR = path.join(tmpRoot, "data");
  process.env.PI_DESKTOP_WORKSPACE_DIR = path.join(tmpRoot, "workspace");
  delete process.env.PI_DESKTOP_MODEL;

  const { createApp } = await import("./index.js");
  const app = createApp({ resolveToken: TEST_RESOLVE_TOKEN });

  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected server.address() to be a net.AddressInfo");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("GET /api/conversations", () => {
  // AC-4.1: Given an empty conversation registry, when GET /api/conversations is
  // called, then it returns 200 [].
  test("AC-4.1: empty registry returns 200 []", async () => {
    const res = await fetch(`${baseUrl}/api/conversations`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});

describe("POST /api/conversations", () => {
  // AC-4.2 [R]: Given a POST /api/conversations with { "title": "Sprint planning" },
  // when it succeeds, then the response is 201 with a ConversationMeta whose title
  // is "Sprint planning", and a subsequent GET /api/conversations includes it.
  test("AC-4.2: POST with a title returns 201 with matching title, and GET list includes it", async () => {
    const res = await fetch(`${baseUrl}/api/conversations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Sprint planning" }),
    });
    expect(res.status).toBe(201);

    const created = (await res.json()) as ConversationMeta;
    expect(created.title).toBe("Sprint planning");
    expect(created.id).toBeTruthy();
    expect(created.createdAt).toBeTruthy();
    expect(created.updatedAt).toBeTruthy();

    const listRes = await fetch(`${baseUrl}/api/conversations`);
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as ConversationMeta[];
    expect(list.some((c) => c.id === created.id && c.title === "Sprint planning")).toBe(true);
  });

  // AC-4.2 (contrast): POST with no body/title falls back to createConversation()'s
  // own default title rather than the route rejecting the request.
  test("AC-4.2: POST with no title still succeeds with a default title", async () => {
    const res = await fetch(`${baseUrl}/api/conversations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(201);

    const created = (await res.json()) as ConversationMeta;
    expect(created.title).toBeTruthy();
  });

  // Task 4 technical design: GET /api/conversations must return updatedAt-desc
  // order per the API contract, proven here by touching an older conversation's
  // sibling via a fresh create so the newest created entry sorts first.
  test("AC-4.2: GET /api/conversations is sorted by updatedAt desc", async () => {
    const first = await (
      await fetch(`${baseUrl}/api/conversations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "older" }),
      })
    ).json() as ConversationMeta;

    await new Promise((resolve) => setTimeout(resolve, 5));

    const second = await (
      await fetch(`${baseUrl}/api/conversations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "newer" }),
      })
    ).json() as ConversationMeta;

    const list = (await (await fetch(`${baseUrl}/api/conversations`)).json()) as ConversationMeta[];
    const firstIndex = list.findIndex((c) => c.id === first.id);
    const secondIndex = list.findIndex((c) => c.id === second.id);
    expect(secondIndex).toBeLessThan(firstIndex);
  });
});

describe("GET /api/conversations/:id", () => {
  // AC-4.3: Given a nonexistent conversation id, when GET /api/conversations/:id is
  // called, then it returns 404, not a silent empty/null 200.
  test("AC-4.3: nonexistent id returns 404, not a silent 200", async () => {
    const res = await fetch(`${baseUrl}/api/conversations/does-not-exist`);
    expect(res.status).toBe(404);
  });

  test("AC-4.3 (contrast): existing id returns 200 with its ConversationMeta", async () => {
    const created = (await (
      await fetch(`${baseUrl}/api/conversations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "lookup me" }),
      })
    ).json()) as ConversationMeta;

    const res = await fetch(`${baseUrl}/api/conversations/${created.id}`);
    expect(res.status).toBe(200);
    const meta = (await res.json()) as ConversationMeta;
    expect(meta.id).toBe(created.id);
    expect(meta.title).toBe("lookup me");
  });
});

/**
 * Task 6: GET /api/models and PATCH /api/conversations/:id/model.
 *
 * A real (unstubbed) modelRegistry, built from the scratch agentDir the rest of this
 * file's beforeAll points at, has no configured provider auth and would always
 * resolve empty/undefined — useless for proving AC-6.1's "non-empty list" or
 * AC-6.2's "valid modelId resolves". So this describe block spins up its own
 * createApp() instance (own ephemeral port) with an injected stub ModelRegistry,
 * mirroring agent/models.test.ts's makeModel/makeRegistryStub helpers exactly —
 * createApp()'s new `options.modelRegistry` (Task 6, index.ts) exists specifically
 * to make this injection possible without touching models.ts.
 */
describe("Task 6: GET /api/models, PATCH /api/conversations/:id/model", () => {
  let modelServer: Server;
  let modelBaseUrl: string;

  function makeModel(overrides: Partial<Model<Api>> & { id: string; provider: string }): Model<Api> {
    return {
      name: overrides.id,
      api: "anthropic-messages",
      baseUrl: "https://example.invalid",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0 },
      contextWindow: 100_000,
      maxTokens: 4096,
      ...overrides,
    } as Model<Api>;
  }

  const STUB_MODEL = makeModel({ id: "claude-opus-4-5", name: "Claude Opus 4.5", provider: "anthropic" });
  const STUB_MODEL_ID = `${STUB_MODEL.provider}/${STUB_MODEL.id}`;

  function makeRegistryStub(): ModelRegistry {
    return {
      getAll: () => [STUB_MODEL],
      getAvailable: () => [STUB_MODEL],
    } as unknown as ModelRegistry;
  }

  beforeAll(async () => {
    const { createApp } = await import("./index.js");
    const app = createApp({ modelRegistry: makeRegistryStub() });

    await new Promise<void>((resolve) => {
      modelServer = app.listen(0, "127.0.0.1", () => resolve());
    });

    const address = modelServer.address();
    if (!address || typeof address === "string") {
      throw new Error("expected server.address() to be a net.AddressInfo");
    }
    modelBaseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      modelServer.close((error) => (error ? reject(error) : resolve()));
    });
  });

  // AC-6.1: Given at least one configured model (stubbed registry, see above), when
  // GET /api/models is called, then it returns 200 with a non-empty list.
  test("AC-6.1: GET /api/models returns 200 with a non-empty list", async () => {
    const res = await fetch(`${modelBaseUrl}/api/models`);
    expect(res.status).toBe(200);

    const models = (await res.json()) as { id: string; label: string; provider: string }[];
    expect(models.length).toBeGreaterThan(0);
    expect(models).toContainEqual({ id: STUB_MODEL_ID, label: STUB_MODEL.name, provider: STUB_MODEL.provider });
  });

  // AC-6.2 [R]: Given an existing conversation and a valid modelId, when PATCH
  // /api/conversations/:id/model is called, then it returns 200 and
  // getConversationMeta(id).modelId reflects the change (checked here via the
  // response body and a follow-up GET, since this describe block's server instance
  // is the only one with the stub registry that can resolve STUB_MODEL_ID).
  test("AC-6.2: valid modelId returns 200 with the conversation's modelId updated", async () => {
    const created = (await (
      await fetch(`${modelBaseUrl}/api/conversations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "model switch target" }),
      })
    ).json()) as ConversationMeta;
    expect(created.modelId).toBeUndefined();

    const patchRes = await fetch(`${modelBaseUrl}/api/conversations/${created.id}/model`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ modelId: STUB_MODEL_ID }),
    });
    expect(patchRes.status).toBe(200);
    const patched = (await patchRes.json()) as ConversationMeta;
    expect(patched.modelId).toBe(STUB_MODEL_ID);

    const getRes = await fetch(`${modelBaseUrl}/api/conversations/${created.id}`);
    const refetched = (await getRes.json()) as ConversationMeta;
    expect(refetched.modelId).toBe(STUB_MODEL_ID);
  });

  // AC-6.3 [R]: Given an invalid modelId, when PATCH /api/conversations/:id/model is
  // called, then it returns 400, and the conversation's modelId is unchanged (no
  // silent no-op success) — proven by asserting the pre-PATCH state (undefined) is
  // still exactly what a follow-up GET returns.
  test("AC-6.3: invalid modelId returns 400 and leaves the conversation's modelId unchanged", async () => {
    const created = (await (
      await fetch(`${modelBaseUrl}/api/conversations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "bad model switch" }),
      })
    ).json()) as ConversationMeta;
    expect(created.modelId).toBeUndefined();

    const patchRes = await fetch(`${modelBaseUrl}/api/conversations/${created.id}/model`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ modelId: "nonexistent/does-not-exist" }),
    });
    expect(patchRes.status).toBe(400);

    const getRes = await fetch(`${modelBaseUrl}/api/conversations/${created.id}`);
    const refetched = (await getRes.json()) as ConversationMeta;
    expect(refetched.modelId).toBeUndefined();
  });

  // AC-6.2 (contrast): unknown conversation id returns 404, not a silent 400, even
  // with a resolvable modelId — matching /api/conversations/:id's own 404 pattern.
  test("AC-6.2 (contrast): unknown conversation id returns 404", async () => {
    const res = await fetch(`${modelBaseUrl}/api/conversations/does-not-exist/model`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ modelId: STUB_MODEL_ID }),
    });
    expect(res.status).toBe(404);
  });

  /**
   * Critical fix (/tgd-review, found independently by code-reviewer and
   * test-engineer): AC-6.2 above only exercises a conversation that has never
   * created a session (sessionPromises has no entry for it yet) -- the one case
   * where the pre-fix code (metadata-only) happened to work. These two tests cover
   * the actually-broken case: a conversation that already has a *live* cached
   * AgentSession (agent/conversations.ts's sessionPromises). conversations.js is
   * imported dynamically here (not statically at the top of the file) for the same
   * reason as index.js above -- it transitively loads config/env.js, which must not
   * resolve against the real environment before this file's top beforeAll sets the
   * scratch PI_DESKTOP_* dirs.
   */
  describe("PATCH /api/conversations/:id/model with an already-live cached session", () => {
    // (b): a conversation with a live session must have setModel() called on that
    // *real* cached AgentSession instance, and the session must reflect the new
    // model afterward -- proving the fix actually reaches the live session instead
    // of only updating stored metadata. The real SDK setModel() validates
    // configured auth via the session's own modelRegistry (see
    // node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js),
    // which this scratch test env never configures for any provider, so the spy's
    // mockImplementation reproduces setModel()'s actual documented effect
    // (assigning the new model onto session.state, which session.model reads from)
    // while skipping the orthogonal auth check -- same test-double pattern as
    // agent/conversations.test.ts's "setLiveSessionModel (Critical /tgd-review fix)"
    // block.
    test("calls setModel() on the real live session and the session reflects the new model afterward", async () => {
      const { getOrCreateSession } = await import("./agent/conversations.js");

      const created = (await (
        await fetch(`${modelBaseUrl}/api/conversations`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "live session model switch" }),
        })
      ).json()) as ConversationMeta;

      // Force a live, cached session to exist for this conversation before the
      // PATCH -- the exact precondition the pre-fix code got wrong.
      const session = await getOrCreateSession(created.id);
      const setModelSpy = spyOn(session, "setModel").mockImplementation(async (model) => {
        session.state.model = model;
      });

      const patchRes = await fetch(`${modelBaseUrl}/api/conversations/${created.id}/model`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ modelId: STUB_MODEL_ID }),
      });
      expect(patchRes.status).toBe(200);
      const patched = (await patchRes.json()) as ConversationMeta;
      expect(patched.modelId).toBe(STUB_MODEL_ID);

      expect(setModelSpy).toHaveBeenCalledTimes(1);
      expect(setModelSpy).toHaveBeenCalledWith(expect.objectContaining({ id: STUB_MODEL.id, provider: STUB_MODEL.provider }));
      expect(session.model?.id).toBe(STUB_MODEL.id);
      expect(session.model?.provider).toBe(STUB_MODEL.provider);

      setModelSpy.mockRestore();
    });

    // (c): if the live session's setModel() rejects (e.g. no auth configured for
    // the target model, per the SDK's own doc comment), the endpoint must return an
    // error response rather than silently succeeding, and must NOT leave stored
    // metadata updated to a model the live session never actually adopted --
    // metadata and the live session's real model must stay consistent.
    test("returns an error and leaves metadata unchanged when the live session's setModel() rejects", async () => {
      const { getOrCreateSession } = await import("./agent/conversations.js");

      const created = (await (
        await fetch(`${modelBaseUrl}/api/conversations`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "live session model switch failure" }),
        })
      ).json()) as ConversationMeta;
      expect(created.modelId).toBeUndefined();

      const session = await getOrCreateSession(created.id);
      const setModelSpy = spyOn(session, "setModel").mockRejectedValueOnce(
        new Error("No API key for anthropic/claude-opus-4-5"),
      );

      const patchRes = await fetch(`${modelBaseUrl}/api/conversations/${created.id}/model`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ modelId: STUB_MODEL_ID }),
      });
      expect(patchRes.status).toBeGreaterThanOrEqual(500);

      expect(setModelSpy).toHaveBeenCalledTimes(1);

      // Metadata must be exactly what it was pre-PATCH -- not updated to the model
      // the live session failed to adopt.
      const getRes = await fetch(`${modelBaseUrl}/api/conversations/${created.id}`);
      const refetched = (await getRes.json()) as ConversationMeta;
      expect(refetched.modelId).toBeUndefined();

      setModelSpy.mockRestore();
    });
  });
});

/**
 * Critical fix (/tgd-review code-reviewer finding — closes US-03's P0 acceptance
 * criterion / TASKS.md's AC-12.2): "switching to a previously-open conversation
 * shows an empty transcript, not its real prior messages." This is the new route
 * SPEC.md anticipated as a contingency (`GET /api/conversations/:id/messages`).
 * Mapping-logic unit tests live in agent/conversations.test.ts
 * (toAGUIHistory/getConversationMessages); these are the route-level integration
 * checks — real HTTP over app.listen(), matching this file's own convention.
 */
describe("GET /api/conversations/:id/messages", () => {
  test("a brand-new conversation with no turns yet returns 200 []", async () => {
    const created = (await (
      await fetch(`${baseUrl}/api/conversations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "no history yet" }),
      })
    ).json()) as ConversationMeta;

    const res = await fetch(`${baseUrl}/api/conversations/${created.id}/messages`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  test("a conversation with real session history returns it mapped to AG-UI Message[] shape", async () => {
    const created = (await (
      await fetch(`${baseUrl}/api/conversations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "has real history" }),
      })
    ).json()) as ConversationMeta;

    const { getOrCreateSession } = await import("./agent/conversations.js");
    const session = await getOrCreateSession(created.id);
    session.state.messages = [
      { role: "user", content: "What's the weather API key stored as?", timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "text", text: "It's WEATHER_API_KEY in your .env." }],
        api: "anthropic-messages",
        provider: "test-provider",
        model: "test-model",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 2,
      },
    ];

    const res = await fetch(`${baseUrl}/api/conversations/${created.id}/messages`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      { id: "history-0", role: "user", content: "What's the weather API key stored as?" },
      { id: "history-1", role: "assistant", content: "It's WEATHER_API_KEY in your .env." },
    ]);
  });

  // Same malformed-id convention as GET /api/conversations/:id/artifacts/latest
  // below: conversations.ts's assertSafeConversationId guard must normalize to a
  // clean 400 with no leaked stack trace, not an unhandled 500.
  test("a malformed conversation id returns 400, not a stack-trace-leaking 500", async () => {
    const res = await fetch(`${baseUrl}/api/conversations/${encodeURIComponent("../../etc")}/messages`);
    expect(res.status).toBe(400);

    const text = await res.text();
    expect(text).not.toContain("at ");
    expect(text).not.toContain(".ts:");
  });
});

describe("GET /api/conversations/:id/artifacts/latest", () => {
  // AC-8.1: Given a conversation with no published artifacts, when the endpoint is
  // called, then it returns 200 null — "no artifact yet" is an expected state, not
  // an error, so this must not be a 404.
  test("AC-8.1: conversation with no published artifacts returns 200 null", async () => {
    const created = (await (
      await fetch(`${baseUrl}/api/conversations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "no artifacts yet" }),
      })
    ).json()) as ConversationMeta;

    const res = await fetch(`${baseUrl}/api/conversations/${created.id}/artifacts/latest`);
    expect(res.status).toBe(200);
    expect(await res.json()).toBeNull();
  });

  // AC-8.2 [R]: Given a conversation with a published artifact, when the endpoint is
  // called, then it returns 200 with that artifact's full content. Publishes via
  // artifacts/store.ts's saveArtifact() directly (same thing publish_artifact's
  // execute() does under the hood, per Task 7) rather than driving a real agent
  // turn, since the tool call itself is already covered by
  // server/src/artifacts/store.test.ts.
  test("AC-8.2: conversation with a published artifact returns 200 with its full content", async () => {
    const created = (await (
      await fetch(`${baseUrl}/api/conversations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "has an artifact" }),
      })
    ).json()) as ConversationMeta;

    const { saveArtifact } = await import("./artifacts/store.js");
    const artifact = {
      id: "chart-1",
      title: "WAU chart",
      language: "tsx",
      code: "export const Chart = () => null;",
      publishedAt: new Date().toISOString(),
    };
    saveArtifact(created.id, artifact);

    const res = await fetch(`${baseUrl}/api/conversations/${created.id}/artifacts/latest`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(artifact);
  });

  // Task 8 fix (path-traversal error handling): a malformed/path-traversal-style id
  // fails conversations.ts's SAFE_ID_PATTERN, so getLatestArtifact() ->
  // artifactsPath() -> conversationCwd() throws synchronously
  // (assertSafeConversationId). Before the fix that throw was uncaught by this
  // route's handler and fell through to Express's default error handler — an
  // unhandled 500 with a full stack trace (including absolute local file paths)
  // leaked in the response body. It must now be a clean 400 with no stack trace.
  test("Task 8 fix: malformed conversation id returns 400, not a stack-trace-leaking 500", async () => {
    const res = await fetch(`${baseUrl}/api/conversations/${encodeURIComponent("../../etc")}/artifacts/latest`);
    expect(res.status).toBe(400);

    const text = await res.text();
    expect(text).not.toContain("at ");
    expect(text).not.toContain(".ts:");
  });
});

describe("GET /api/conversations/:id/artifacts/:artifactId", () => {
  // Artifacts-as-chat-attachments: an older artifact must still be fetchable by id
  // after a newer one has become "latest" — this is the endpoint the chat
  // attachment chip's click handler calls, since it knows the exact id its own
  // tool call published, not just whatever is currently latest.
  test("returns 200 with a specific artifact's full content even after a newer one was published", async () => {
    const created = (await (
      await fetch(`${baseUrl}/api/conversations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "has two artifacts" }),
      })
    ).json()) as ConversationMeta;

    const { saveArtifact } = await import("./artifacts/store.js");
    const older = {
      id: "chart-1",
      title: "WAU chart",
      language: "tsx",
      code: "export const Chart = () => null;",
      publishedAt: "2020-01-01T00:00:00.000Z",
    };
    const newer = {
      id: "chart-2",
      title: "MAU chart",
      language: "tsx",
      code: "export const Chart2 = () => null;",
      publishedAt: "2030-01-01T00:00:00.000Z",
    };
    saveArtifact(created.id, older);
    saveArtifact(created.id, newer);

    const res = await fetch(`${baseUrl}/api/conversations/${created.id}/artifacts/chart-1`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(older);
  });

  // AC parity with /latest's AC-8.1: an unknown artifact id is a "nothing to show"
  // state, not a client error — returns 200 null rather than 404.
  test("returns 200 null for an id that was never published", async () => {
    const created = (await (
      await fetch(`${baseUrl}/api/conversations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "no such artifact" }),
      })
    ).json()) as ConversationMeta;

    const res = await fetch(`${baseUrl}/api/conversations/${created.id}/artifacts/does-not-exist`);
    expect(res.status).toBe(200);
    expect(await res.json()).toBeNull();
  });

  // Same path-traversal guard as /latest — must not leak a stack trace.
  test("malformed conversation id returns 400, not a stack-trace-leaking 500", async () => {
    const res = await fetch(`${baseUrl}/api/conversations/${encodeURIComponent("../../etc")}/artifacts/chart-1`);
    expect(res.status).toBe(400);

    const text = await res.text();
    expect(text).not.toContain("at ");
    expect(text).not.toContain(".ts:");
  });
});

/**
 * Task 5 (TASKS.md): the new Vercel AI SDK / Assistant UI chat route, wired
 * alongside (not replacing yet) /agui. Real HTTP over app.listen(), same
 * convention as every other describe block in this file.
 *
 * Driving a real turn end-to-end would require real provider auth this scratch
 * test env never configures (agent/conversations.ts's createSession() ->
 * getAgentDeps() -> real auth.json/model registry) -- these tests instead get a
 * REAL AgentSession via getOrCreateSession() (same helper the route itself calls)
 * and spy on its subscribe()/prompt() methods, same established pattern as the
 * "PATCH /api/conversations/:id/model with an already-live cached session" block
 * above (spyOn(session, "setModel")). Overriding subscribe() to capture the
 * listener the adapter registers (rather than letting the real SDK's internal
 * event bus drive it) lets prompt()'s mock implementation manually replay a
 * controlled, conversation-specific sequence of pi session events through that
 * exact listener -- proving the route's plumbing (getOrCreateSession ->
 * handleAiSdkRun -> pipeUIMessageStreamToResponse) actually carries THIS
 * conversation's session activity into the HTTP response, without needing a real
 * model call.
 */
describe("POST /api/conversations/:id/chat", () => {
  // `listener`/the events fed into it below are typed `any` deliberately: this test
  // double drives ai-sdk/adapter.ts's PiSessionEvent shape (a narrower, hand-picked
  // duck type — see that file's own doc comment) through the real SDK's
  // AgentSessionEventListener slot, and those two types are related in neither
  // direction under `tsc`'s strict structural check (same mismatch documented at
  // index.ts's handleAiSdkRun() call site) — `any` here is the pragmatic escape
  // hatch for a test double, not a production code path.
  function stubSessionTurn(session: Awaited<ReturnType<typeof import("./agent/conversations.js").getOrCreateSession>>, replyText: string) {
    let listener: ((event: any) => void) | undefined;
    const subscribeSpy = spyOn(session, "subscribe").mockImplementation((l: any) => {
      listener = l;
      return () => {};
    });
    const promptSpy = spyOn(session, "prompt").mockImplementation(async () => {
      if (!listener) throw new Error("expected subscribe() to have been called before prompt()");
      listener({ type: "message_start", message: { role: "assistant" } });
      listener({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: replyText },
      });
      listener({ type: "message_end", message: { role: "assistant" } });
      listener({ type: "agent_end" });
    });
    return { subscribeSpy, promptSpy };
  }

  // AC-5.1 [R]: Given a real HTTP POST to the new route for a given conversation
  // id, when the request carries a valid AI-SDK-shaped body ({ messages:
  // UIMessage[] }), then it receives a real AI-SDK-shaped UI message stream
  // response reflecting that SPECIFIC conversation's actual AgentSession activity
  // — proven here via two distinct conversations, each with its own stubbed
  // session reply, confirming conversation A's response body carries only A's
  // text and never B's (direct re-verification of wire-chat-backend's
  // "Cross-conversation message isolation" catalog entry under the new
  // transport, per TASKS.md's AC-5.1).
  test("AC-5.1: two conversations' chat responses reflect only their own session activity", async () => {
    const { getOrCreateSession } = await import("./agent/conversations.js");

    const convA = (await (
      await fetch(`${baseUrl}/api/conversations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "chat route conversation A" }),
      })
    ).json()) as ConversationMeta;
    const convB = (await (
      await fetch(`${baseUrl}/api/conversations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "chat route conversation B" }),
      })
    ).json()) as ConversationMeta;

    const sessionA = await getOrCreateSession(convA.id);
    const sessionB = await getOrCreateSession(convB.id);
    const { subscribeSpy: subscribeSpyA, promptSpy: promptSpyA } = stubSessionTurn(
      sessionA,
      "reply-only-for-conversation-A",
    );
    const { subscribeSpy: subscribeSpyB, promptSpy: promptSpyB } = stubSessionTurn(
      sessionB,
      "reply-only-for-conversation-B",
    );

    const chatBody = (text: string) =>
      JSON.stringify({
        messages: [{ id: "u1", role: "user", parts: [{ type: "text", text }] }],
      });

    const resA = await fetch(`${baseUrl}/api/conversations/${convA.id}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: chatBody("hello from A"),
    });
    expect(resA.status).toBe(200);
    const bodyA = await resA.text();
    expect(bodyA).toContain("reply-only-for-conversation-A");
    expect(bodyA).not.toContain("reply-only-for-conversation-B");

    const resB = await fetch(`${baseUrl}/api/conversations/${convB.id}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: chatBody("hello from B"),
    });
    expect(resB.status).toBe(200);
    const bodyB = await resB.text();
    expect(bodyB).toContain("reply-only-for-conversation-B");
    expect(bodyB).not.toContain("reply-only-for-conversation-A");

    // Each conversation's own session.prompt() was driven with ITS request's
    // extracted user text, not the other conversation's — the userText argument
    // handleAiSdkRun forwards straight to session.prompt(text, ...) per
    // ai-sdk/adapter.ts.
    expect(promptSpyA).toHaveBeenCalledWith("hello from A", undefined);
    expect(promptSpyB).toHaveBeenCalledWith("hello from B", undefined);

    subscribeSpyA.mockRestore();
    promptSpyA.mockRestore();
    subscribeSpyB.mockRestore();
    promptSpyB.mockRestore();
  });

  // AC-5.2 [R]: Given a malformed conversation id (path-traversal-style, matching
  // assertSafeConversationId's existing convention), when the new route is
  // called, then it returns 400 with no leaked stack trace — same convention as
  // every other per-conversation route in this file (GET .../messages,
  // .../artifacts/latest, .../artifacts/:artifactId above), re-verifying this bug
  // class doesn't regress a third time under a brand-new route.
  test("AC-5.2: malformed conversation id returns 400, not a stack-trace-leaking 500", async () => {
    const res = await fetch(`${baseUrl}/api/conversations/${encodeURIComponent("../../etc")}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] }] }),
    });
    expect(res.status).toBe(400);

    const text = await res.text();
    expect(text).not.toContain("at ");
    expect(text).not.toContain(".ts:");
  });
});

// Security-review finding (Critical, /tgd-review security-auditor): createApp() used
// to mount `cors()` with no options, which is the `cors` package's wildcard default
// (Access-Control-Allow-Origin: *). Combined with zero auth on any route, that let any
// web page open in the user's regular browser cross-origin POST into /agui (arbitrary
// prompt injection, including resuming the well-known "default" conversation id) — see
// config/env.ts's DEFAULT_CORS_ORIGINS for the fix and full origin-allowlist rationale.
//
// `Content-Type: application/json` POSTs are not CORS-"simple" requests, so browsers
// preflight them with an OPTIONS request first; these tests drive that same preflight
// directly against the real app.listen() instance (matching this file's existing
// pattern of exercising real HTTP rather than mocking) to prove a disallowed Origin
// does not get a permissive response, and an allowlisted one does.
describe("CORS", () => {
  test("preflight from a disallowed origin does not get a permissive Access-Control-Allow-Origin", async () => {
    const res = await fetch(`${baseUrl}/agui`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://evil.example",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    });

    const allowOrigin = res.headers.get("access-control-allow-origin");
    expect(allowOrigin).not.toBe("*");
    expect(allowOrigin).not.toBe("https://evil.example");
  });

  // Proves the fix isn't so restrictive it breaks the app's own frontend: the Vite
  // dev-server origin (src-tauri/tauri.conf.json's build.devUrl, which the packaged
  // webview navigates to directly in `tauri dev` — see config/env.ts's comment) must
  // still get a real preflight approval, not just "not blocked".
  test("preflight from the app's own dev-server origin is allowed", async () => {
    const res = await fetch(`${baseUrl}/agui`, {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:1420",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    });

    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:1420");
  });

  // Same check for the packaged macOS/Linux webview's tauri://localhost origin, so a
  // regression here (e.g. someone "simplifying" the allowlist down to just the dev
  // origin) is caught by tests rather than only discovered in a packaged build.
  test("preflight from the packaged macOS/Linux webview origin is allowed", async () => {
    const res = await fetch(`${baseUrl}/agui`, {
      method: "OPTIONS",
      headers: {
        Origin: "tauri://localhost",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    });

    expect(res.headers.get("access-control-allow-origin")).toBe("tauri://localhost");
  });
});

/**
 * Task 4: the pending-interaction poll/resolve routes on top of Task 3's registry
 * (server/src/web-fetch/pending-interactions.ts). Interactions are seeded directly
 * via that module's own create() (same pattern as the artifacts/latest tests above
 * seeding via saveArtifact() directly) rather than driving a real web_fetch tool
 * call, since the tool itself is a separate task's own test coverage.
 */
describe("GET /api/conversations/:id/pending-interaction", () => {
  // AC-4.4: Given no pending interaction exists for a conversation, when GET
  // .../pending-interaction is called, then it returns 200 { interaction: null },
  // not 404 — "nothing pending" is an expected state, matching this repo's existing
  // artifacts/latest convention exactly.
  test("AC-4.4: no pending interaction returns 200 { interaction: null }", async () => {
    const created = (await (
      await fetch(`${baseUrl}/api/conversations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "nothing pending" }),
      })
    ).json()) as ConversationMeta;

    const res = await fetch(`${baseUrl}/api/conversations/${created.id}/pending-interaction`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ interaction: null });
  });

  // Not itself a numbered AC, but exercises the "public shape only" contract SPEC.md
  // and pending-interactions.ts's own getPending() doc comment both call out: the
  // response must be the interaction's public fields, never a leaked resolver.
  test("returns 200 with the pending interaction's public shape when one exists", async () => {
    const created = (await (
      await fetch(`${baseUrl}/api/conversations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "has a pending interaction" }),
      })
    ).json()) as ConversationMeta;

    const { create: createPendingInteraction } = await import("./web-fetch/pending-interactions.js");
    const { id } = createPendingInteraction(created.id, {
      conversationId: created.id,
      kind: "confirm",
      host: "192.168.1.5",
      timeoutMs: 5000,
    });

    const res = await fetch(`${baseUrl}/api/conversations/${created.id}/pending-interaction`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { interaction: Record<string, unknown> | null };
    expect(body.interaction).toMatchObject({
      id,
      conversationId: created.id,
      kind: "confirm",
      host: "192.168.1.5",
    });
    expect(body.interaction).not.toHaveProperty("resolver");
  });

  // AC-4.3: Given a malformed conversation id (path-traversal-style, matching this
  // repo's existing assertSafeConversationId convention — same test pattern as
  // /artifacts/latest's equivalent test), when GET .../pending-interaction is
  // called, then it returns 400 with no leaked stack trace.
  test("AC-4.3: malformed conversation id returns 400, not a stack-trace-leaking 500", async () => {
    const res = await fetch(`${baseUrl}/api/conversations/${encodeURIComponent("../../etc")}/pending-interaction`);
    expect(res.status).toBe(400);

    const text = await res.text();
    expect(text).not.toContain("at ");
    expect(text).not.toContain(".ts:");
  });
});

describe("POST /api/conversations/:id/pending-interaction/:interactionId/resolve", () => {
  // AC-4.1 [R]: Given a pending confirm-kind interaction exists for a conversation,
  // when POST .../resolve is called with { "approved": true }, then it returns 200
  // and the interaction's promise (from create()) resolves with { approved: true }.
  // This is the only path by which a real user approval reaches the waiting tool
  // call — tested in both directions (this test: approve).
  //
  // Also empirically settles AC-2.2 (the poll-vs-push delivery spike): this test
  // drives a real HTTP request against the real running app.listen() server (not a
  // mock) and confirms a pending interaction, created server-side, is genuinely
  // resolvable by an external POST the way a polling frontend would issue — proof
  // the chosen (poll) mechanism actually reaches and unblocks the waiting promise
  // end-to-end, not just in theory. See SPEC.md's "Getting the pending interaction
  // to the frontend — RESOLVED: poll" section for the full architectural trace of
  // why push was ruled out instead.
  test("AC-4.1: { approved: true } returns 200 and resolves the promise with approved: true", async () => {
    const created = (await (
      await fetch(`${baseUrl}/api/conversations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "approve flow" }),
      })
    ).json()) as ConversationMeta;

    const { create: createPendingInteraction } = await import("./web-fetch/pending-interactions.js");
    const { id, promise } = createPendingInteraction(created.id, {
      conversationId: created.id,
      kind: "confirm",
      host: "10.0.0.5",
      timeoutMs: 5000,
    });

    const res = await fetch(`${baseUrl}/api/conversations/${created.id}/pending-interaction/${id}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Resolve-Token": TEST_RESOLVE_TOKEN },
      body: JSON.stringify({ approved: true }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ resolved: true });

    expect(await promise).toEqual({ kind: "confirm", approved: true });
  });

  // AC-4.1 [R]: same as above, but the deny direction — a regression that silently
  // resolved every confirm-kind interaction as approved regardless of the request
  // body would defeat the entire approval-gate safety boundary, so this must be
  // tested explicitly, not inferred from the approve case.
  test("AC-4.1: { approved: false } returns 200 and resolves the promise with approved: false", async () => {
    const created = (await (
      await fetch(`${baseUrl}/api/conversations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "deny flow" }),
      })
    ).json()) as ConversationMeta;

    const { create: createPendingInteraction } = await import("./web-fetch/pending-interactions.js");
    const { id, promise } = createPendingInteraction(created.id, {
      conversationId: created.id,
      kind: "confirm",
      host: "10.0.0.6",
      timeoutMs: 5000,
    });

    const res = await fetch(`${baseUrl}/api/conversations/${created.id}/pending-interaction/${id}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Resolve-Token": TEST_RESOLVE_TOKEN },
      body: JSON.stringify({ approved: false }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ resolved: true });

    expect(await promise).toEqual({ kind: "confirm", approved: false });
  });

  // Render-kind coverage of the same resolve path — not itself a numbered AC, but
  // proves the body-shape-disambiguation design (confirm vs render) actually works
  // both ways, not just for confirm-kind.
  test("{ html } resolves a render-kind interaction's promise", async () => {
    const created = (await (
      await fetch(`${baseUrl}/api/conversations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "render flow" }),
      })
    ).json()) as ConversationMeta;

    const { create: createPendingInteraction } = await import("./web-fetch/pending-interactions.js");
    const { id, promise } = createPendingInteraction(created.id, {
      conversationId: created.id,
      kind: "render",
      url: "https://example.com/app",
      timeoutMs: 5000,
    });

    const res = await fetch(`${baseUrl}/api/conversations/${created.id}/pending-interaction/${id}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Resolve-Token": TEST_RESOLVE_TOKEN },
      body: JSON.stringify({ html: "<html>rendered</html>" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ resolved: true });

    expect(await promise).toEqual({ kind: "render", html: "<html>rendered</html>" });
  });

  // AC-4.2: Given an interaction id that doesn't exist, when POST .../resolve is
  // called, then it returns 404, not 200.
  test("AC-4.2: resolving an unknown interaction id returns 404, not 200", async () => {
    const created = (await (
      await fetch(`${baseUrl}/api/conversations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "unknown interaction" }),
      })
    ).json()) as ConversationMeta;

    const res = await fetch(
      `${baseUrl}/api/conversations/${created.id}/pending-interaction/${randomUUID()}/resolve`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "X-Resolve-Token": TEST_RESOLVE_TOKEN },
        body: JSON.stringify({ approved: true }),
      },
    );
    expect(res.status).toBe(404);
  });

  // AC-4.2: Given an interaction that's already been resolved, when POST
  // .../resolve is called again for that same id, then it returns 404, not 200.
  test("AC-4.2: resolving an already-resolved interaction a second time returns 404, not 200", async () => {
    const created = (await (
      await fetch(`${baseUrl}/api/conversations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "double resolve" }),
      })
    ).json()) as ConversationMeta;

    const { create: createPendingInteraction } = await import("./web-fetch/pending-interactions.js");
    const { id } = createPendingInteraction(created.id, {
      conversationId: created.id,
      kind: "confirm",
      host: "10.0.0.7",
      timeoutMs: 5000,
    });

    const resolveUrl = `${baseUrl}/api/conversations/${created.id}/pending-interaction/${id}/resolve`;
    const first = await fetch(resolveUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Resolve-Token": TEST_RESOLVE_TOKEN },
      body: JSON.stringify({ approved: true }),
    });
    expect(first.status).toBe(200);

    const second = await fetch(resolveUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Resolve-Token": TEST_RESOLVE_TOKEN },
      body: JSON.stringify({ approved: false }),
    });
    expect(second.status).toBe(404);
  });

  // AC-4.3: Given a malformed conversation id (path-traversal-style), when POST
  // .../resolve is called, then it returns 400 with no leaked stack trace.
  test("AC-4.3: malformed conversation id returns 400, not a stack-trace-leaking 500", async () => {
    const res = await fetch(
      `${baseUrl}/api/conversations/${encodeURIComponent("../../etc")}/pending-interaction/${randomUUID()}/resolve`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "X-Resolve-Token": TEST_RESOLVE_TOKEN },
        body: JSON.stringify({ approved: true }),
      },
    );
    expect(res.status).toBe(400);

    const text = await res.text();
    expect(text).not.toContain("at ");
    expect(text).not.toContain(".ts:");
  });

  // Body-shape validation coverage: the route must not guess which kind an
  // interaction is (that's pending-interactions.ts's own private state) — a body
  // matching neither shape unambiguously must 400 before resolve() is ever called.
  test("400 when the body has neither approved nor html", async () => {
    const created = (await (
      await fetch(`${baseUrl}/api/conversations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "empty body" }),
      })
    ).json()) as ConversationMeta;

    const { create: createPendingInteraction } = await import("./web-fetch/pending-interactions.js");
    const { id } = createPendingInteraction(created.id, {
      conversationId: created.id,
      kind: "confirm",
      host: "10.0.0.8",
      timeoutMs: 5000,
    });

    const res = await fetch(`${baseUrl}/api/conversations/${created.id}/pending-interaction/${id}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Resolve-Token": TEST_RESOLVE_TOKEN },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  test("400 when the body has both approved and html", async () => {
    const created = (await (
      await fetch(`${baseUrl}/api/conversations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "ambiguous body" }),
      })
    ).json()) as ConversationMeta;

    const { create: createPendingInteraction } = await import("./web-fetch/pending-interactions.js");
    const { id } = createPendingInteraction(created.id, {
      conversationId: created.id,
      kind: "confirm",
      host: "10.0.0.9",
      timeoutMs: 5000,
    });

    const res = await fetch(`${baseUrl}/api/conversations/${created.id}/pending-interaction/${id}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Resolve-Token": TEST_RESOLVE_TOKEN },
      body: JSON.stringify({ approved: true, html: "<p>x</p>" }),
    });
    expect(res.status).toBe(400);
  });

  test("400 when approved is present but not a boolean", async () => {
    const created = (await (
      await fetch(`${baseUrl}/api/conversations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "wrong type" }),
      })
    ).json()) as ConversationMeta;

    const { create: createPendingInteraction } = await import("./web-fetch/pending-interactions.js");
    const { id } = createPendingInteraction(created.id, {
      conversationId: created.id,
      kind: "confirm",
      host: "10.0.0.10",
      timeoutMs: 5000,
    });

    const res = await fetch(`${baseUrl}/api/conversations/${created.id}/pending-interaction/${id}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Resolve-Token": TEST_RESOLVE_TOKEN },
      body: JSON.stringify({ approved: "yes" }),
    });
    expect(res.status).toBe(400);
  });
});

/**
 * ADR-001 (server/src/index.ts's own doc comment on CreateAppOptions.resolveToken
 * and readResolveToken() has the full design): the resolve route's X-Resolve-Token
 * auth check, closing REVIEW.md's High finding ("self-approval bypass" — this
 * route previously had no auth beyond CORS, so the agent's own unrestricted
 * `bash` tool could poll the pending-interaction GET and auto-POST
 * `{"approved":true}` before a human ever saw the approval chip). The large
 * pre-existing ".../resolve" describe block above (predating this fix) already
 * covers the route's other behaviors with TEST_RESOLVE_TOKEN attached to every
 * request; these tests cover the auth check itself.
 *
 * assistant-ui-migration Task 11 / ADR-002-tool-approval-trust-boundary.md
 * Decision point 2: this exact `POST .../pending-interaction/:interactionId/resolve`
 * route (X-Resolve-Token header, timingSafeEqual comparison, fail-closed when
 * unconfigured) IS the endpoint ADR-002 says to port verbatim for the AI-SDK
 * migration's tool-approval trust boundary — `interactionId` and the AI SDK's
 * `approvalId` refer to the identical value (`PendingInteraction.id`), so no
 * route rename was made (see this task's commit message for the full
 * reasoning). The tests below already prove AC-11.1/AC-11.2/AC-11.3 for that
 * feature; individual tests are tagged with their AC ids inline rather than
 * duplicated.
 */
describe("ADR-001 / REVIEW.md High finding (self-approval bypass): X-Resolve-Token auth on POST .../resolve", () => {
  async function createPendingConfirm(conversationId: string, host: string) {
    const { create: createPendingInteraction } = await import("./web-fetch/pending-interactions.js");
    return createPendingInteraction(conversationId, {
      conversationId,
      kind: "confirm",
      host,
      timeoutMs: 5000,
    });
  }

  // AC-11.2 (assistant-ui-migration Task 11): no X-Resolve-Token header -> 401,
  // pending approval remains unresolved.
  test("missing X-Resolve-Token header returns 401 and does not resolve the interaction", async () => {
    const created = (await (
      await fetch(`${baseUrl}/api/conversations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "auth: missing header" }),
      })
    ).json()) as ConversationMeta;

    const { id } = await createPendingConfirm(created.id, "10.0.1.1");

    const res = await fetch(`${baseUrl}/api/conversations/${created.id}/pending-interaction/${id}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approved: true }),
    });
    expect(res.status).toBe(401);

    // The interaction must genuinely still be pending -- not silently approved --
    // proven via the (deliberately unauthenticated) poll route.
    const pollRes = await fetch(`${baseUrl}/api/conversations/${created.id}/pending-interaction`);
    const pollBody = (await pollRes.json()) as { interaction: { id: string } | null };
    expect(pollBody.interaction?.id).toBe(id);
  });

  // AC-11.2 (assistant-ui-migration Task 11): wrong X-Resolve-Token header -> 401,
  // pending approval remains unresolved.
  test("wrong (non-matching) X-Resolve-Token header returns 401 and does not resolve the interaction", async () => {
    const created = (await (
      await fetch(`${baseUrl}/api/conversations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "auth: wrong token" }),
      })
    ).json()) as ConversationMeta;

    const { id } = await createPendingConfirm(created.id, "10.0.1.2");

    const res = await fetch(`${baseUrl}/api/conversations/${created.id}/pending-interaction/${id}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Resolve-Token": "not-the-right-token" },
      body: JSON.stringify({ approved: true }),
    });
    expect(res.status).toBe(401);

    const pollRes = await fetch(`${baseUrl}/api/conversations/${created.id}/pending-interaction`);
    const pollBody = (await pollRes.json()) as { interaction: { id: string } | null };
    expect(pollBody.interaction?.id).toBe(id);
  });

  // AC-11.1 (assistant-ui-migration Task 11): valid X-Resolve-Token + { approved:
  // true } -> 200 and the pending approval is marked resolved server-side (proven
  // here via the settled promise, the same server-side signal a real ctx.ui.confirm()
  // call is waiting on).
  test("correct X-Resolve-Token header succeeds (same behavior as before this fix)", async () => {
    const created = (await (
      await fetch(`${baseUrl}/api/conversations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "auth: correct token" }),
      })
    ).json()) as ConversationMeta;

    const { id, promise } = await createPendingConfirm(created.id, "10.0.1.3");

    const res = await fetch(`${baseUrl}/api/conversations/${created.id}/pending-interaction/${id}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Resolve-Token": TEST_RESOLVE_TOKEN },
      body: JSON.stringify({ approved: true }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ resolved: true });
    expect(await promise).toEqual({ kind: "confirm", approved: true });
  });

  /**
   * ADR-001 step 1.3: the "no token was ever established" fail-closed case --
   * explicit, deliberate design (not a fail-open fallback). Own app instance with
   * resolveToken deliberately omitted, own ephemeral port + teardown, mirroring
   * this file's existing "Task 6" describe block's modelServer pattern above.
   */
  describe("with no resolveToken configured server-side (ADR-001 step 1.3 fail-closed)", () => {
    let noTokenServer: Server;
    let noTokenBaseUrl: string;

    beforeAll(async () => {
      const { createApp } = await import("./index.js");
      const app = createApp(); // resolveToken deliberately left unset -> null/undefined

      await new Promise<void>((resolve) => {
        noTokenServer = app.listen(0, "127.0.0.1", () => resolve());
      });

      const address = noTokenServer.address();
      if (!address || typeof address === "string") {
        throw new Error("expected server.address() to be a net.AddressInfo");
      }
      noTokenBaseUrl = `http://127.0.0.1:${address.port}`;
    });

    afterAll(async () => {
      await new Promise<void>((resolve, reject) => {
        noTokenServer.close((error) => (error ? reject(error) : resolve()));
      });
    });

    // AC-11.3 (assistant-ui-migration Task 11): no resolve token configured at all
    // (env var unset, no stdin handoff) -> every resolve request rejected
    // unconditionally, fail-closed, whether or not a header is sent.
    test("every resolve request is rejected with 401, even with no header sent at all", async () => {
      const created = (await (
        await fetch(`${noTokenBaseUrl}/api/conversations`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "no server token configured" }),
        })
      ).json()) as ConversationMeta;

      const { create: createPendingInteraction } = await import("./web-fetch/pending-interactions.js");
      const { id } = createPendingInteraction(created.id, {
        conversationId: created.id,
        kind: "confirm",
        host: "10.0.1.4",
        timeoutMs: 5000,
      });

      const noHeaderRes = await fetch(
        `${noTokenBaseUrl}/api/conversations/${created.id}/pending-interaction/${id}/resolve`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ approved: true }),
        },
      );
      expect(noHeaderRes.status).toBe(401);

      // Even attaching some arbitrary header value must not somehow succeed --
      // there is nothing valid to compare against server-side, so this is a
      // fail-closed 401 unconditionally, per ADR-001 step 1.3, not fail-open.
      const withHeaderRes = await fetch(
        `${noTokenBaseUrl}/api/conversations/${created.id}/pending-interaction/${id}/resolve`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "X-Resolve-Token": "anything-at-all" },
          body: JSON.stringify({ approved: true }),
        },
      );
      expect(withHeaderRes.status).toBe(401);

      // The interaction must still be genuinely pending after both attempts.
      const pollRes = await fetch(`${noTokenBaseUrl}/api/conversations/${created.id}/pending-interaction`);
      const pollBody = (await pollRes.json()) as { interaction: { id: string } | null };
      expect(pollBody.interaction?.id).toBe(id);
    });
  });
});

/**
 * Low finding (REVIEW.md finding #4, "Important"): POST .../resolve never
 * verified that :interactionId actually belongs to the conversation named by
 * :id in the URL -- so knowing/guessing/enumerating another conversation's
 * pending interaction id let it be resolved via a different conversation's URL.
 * Fixed by binding on getPending(req.params.id) before calling resolve().
 */
describe("Low finding (REVIEW.md #4): interactionId is bound to conversationId on resolve", () => {
  test("resolving conversation A's interaction via conversation B's URL returns 404 and leaves A's interaction pending", async () => {
    const convA = (await (
      await fetch(`${baseUrl}/api/conversations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "binding: conversation A" }),
      })
    ).json()) as ConversationMeta;

    const convB = (await (
      await fetch(`${baseUrl}/api/conversations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "binding: conversation B" }),
      })
    ).json()) as ConversationMeta;

    const { create: createPendingInteraction } = await import("./web-fetch/pending-interactions.js");
    const { id: interactionIdForA, promise } = createPendingInteraction(convA.id, {
      conversationId: convA.id,
      kind: "confirm",
      host: "10.0.2.1",
      timeoutMs: 5000,
    });

    // Attempt to resolve A's interaction via B's URL, with a correct token.
    const mismatchRes = await fetch(
      `${baseUrl}/api/conversations/${convB.id}/pending-interaction/${interactionIdForA}/resolve`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "X-Resolve-Token": TEST_RESOLVE_TOKEN },
        body: JSON.stringify({ approved: true }),
      },
    );
    expect(mismatchRes.status).toBe(404);

    // A's interaction must be unaffected: still pending, and still resolvable via
    // its own conversation's URL.
    const pollRes = await fetch(`${baseUrl}/api/conversations/${convA.id}/pending-interaction`);
    const pollBody = (await pollRes.json()) as { interaction: { id: string } | null };
    expect(pollBody.interaction?.id).toBe(interactionIdForA);

    const properRes = await fetch(
      `${baseUrl}/api/conversations/${convA.id}/pending-interaction/${interactionIdForA}/resolve`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "X-Resolve-Token": TEST_RESOLVE_TOKEN },
        body: JSON.stringify({ approved: true }),
      },
    );
    expect(properRes.status).toBe(200);
    expect(await promise).toEqual({ kind: "confirm", approved: true });
  });
});

// ADR-001: the polling GET route is explicitly, deliberately left unauthenticated
// (it only leaks "something is pending" and the literal host/URL, not an ability
// to act) -- a quick regression sanity check that this fix didn't accidentally
// add auth there too.
describe("GET .../pending-interaction poll route remains unauthenticated (ADR-001)", () => {
  test("still works with no X-Resolve-Token header at all", async () => {
    const created = (await (
      await fetch(`${baseUrl}/api/conversations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "poll stays unauthenticated" }),
      })
    ).json()) as ConversationMeta;

    const res = await fetch(`${baseUrl}/api/conversations/${created.id}/pending-interaction`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ interaction: null });
  });
});

/**
 * ADR-001 step 1: readResolveToken()'s pure logic, unit-tested with an injected
 * env/stdin rather than the real process.stdin/process.env -- the HTTP-level
 * tests above already cover the resolve route's auth behavior via createApp({
 * resolveToken }); these cover the token-acquisition function itself, per the
 * task's own "your judgment on how much to test at that level" allowance.
 */
describe("readResolveToken (ADR-001 step 1)", () => {
  test("PI_DESKTOP_RESOLVE_TOKEN env var present short-circuits without touching stdin", async () => {
    const { readResolveToken } = await import("./index.js");
    // A stdin whose isTTY getter throwing would fail this test if the function
    // ever touched it -- proving the env-var path truly short-circuits.
    const stdinThatMustNotBeTouched = {
      get isTTY(): boolean {
        throw new Error("stdin must not be touched when the env var is set");
      },
    } as unknown as NodeJS.ReadableStream & { isTTY?: boolean };

    const token = await readResolveToken({
      env: { PI_DESKTOP_RESOLVE_TOKEN: "from-env-var" } as NodeJS.ProcessEnv,
      stdin: stdinThatMustNotBeTouched,
    });
    expect(token).toBe("from-env-var");
  });

  test("TTY stdin skips the read entirely and resolves null when the env var is unset", async () => {
    const { readResolveToken } = await import("./index.js");
    const fakeStdin = { isTTY: true } as unknown as NodeJS.ReadableStream & { isTTY?: boolean };

    const token = await readResolveToken({ env: {} as NodeJS.ProcessEnv, stdin: fakeStdin });
    expect(token).toBeNull();
  });

  test("reads one line from a piped (non-TTY) stdin, matching the packaged Rust stdin-handoff channel", async () => {
    const { readResolveToken } = await import("./index.js");
    const stream = Object.assign(new PassThrough(), { isTTY: false }) as unknown as NodeJS.ReadableStream & {
      isTTY?: boolean;
    };
    (stream as unknown as PassThrough).end("piped-token-value\n");

    const token = await readResolveToken({ env: {} as NodeJS.ProcessEnv, stdin: stream });
    expect(token).toBe("piped-token-value");
  });

  test("bounded timeout resolves null (not hang) when non-TTY stdin never sends a line", async () => {
    const { readResolveToken } = await import("./index.js");
    const stream = Object.assign(new PassThrough(), { isTTY: false }) as unknown as NodeJS.ReadableStream & {
      isTTY?: boolean;
    };

    const token = await readResolveToken({ env: {} as NodeJS.ProcessEnv, stdin: stream, timeoutMs: 50 });
    expect(token).toBeNull();

    (stream as unknown as PassThrough).end();
  });
});
