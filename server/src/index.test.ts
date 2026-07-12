import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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
});
