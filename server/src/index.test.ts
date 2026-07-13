import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
  const app = createApp();

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
