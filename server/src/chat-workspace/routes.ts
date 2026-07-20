import express, { type NextFunction, type Request, type Response, type Router } from "express";
import { ConversationWorkspace, type ConversationPatch } from "./conversations.js";
import { AttachmentError, AttachmentWorkspace } from "./attachments.js";
import type { AttachmentRecord } from "./store.js";
import { BranchWorkspace, type BranchSession } from "./branches.js";
import { RunManager } from "./runs.js";

type ErrorCode = "VALIDATION_ERROR" | "NOT_FOUND" | "ACTIVE_RUN" | "INTERNAL_ERROR";

function apiError(res: Response, status: number, code: ErrorCode, message: string): void {
  res.status(status).json({ error: { code, message, retryable: code === "INTERNAL_ERROR" } });
}

function bodyObject(req: Request): Record<string, unknown> {
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) throw new Error("JSON object body is required");
  return req.body as Record<string, unknown>;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  return value;
}

function optionalNullableString(value: unknown, field: string): string | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value !== "string") throw new Error(`${field} must be a string or null`);
  return value;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean`);
  return value;
}

function routeId(value: string | string[], field = "id"): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  return value;
}

function handle(handler: (req: Request, res: Response) => void) {
  return (req: Request, res: Response) => {
    try {
      handler(req, res);
    } catch (error) {
      apiError(res, 400, "VALIDATION_ERROR", error instanceof Error ? error.message : "Invalid request");
    }
  };
}

function asyncHandle(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response) => {
    handler(req, res).catch((error: unknown) => {
      if (error instanceof AttachmentError) {
        const status = error.code === "NOT_FOUND" ? 404 : error.code === "TOO_LARGE" ? 413 :
          error.code === "UNSUPPORTED_TYPE" || error.code === "SIGNATURE_MISMATCH" ? 415 : 400;
        apiError(res, status, error.code === "NOT_FOUND" ? "NOT_FOUND" : "VALIDATION_ERROR", error.message);
        return;
      }
      if (error instanceof Error && error.message === "Branch not found") {
        apiError(res, 404, "NOT_FOUND", error.message);
        return;
      }
      if (error instanceof Error && /^(replacementContent|sourceMessageId|Branch navigation)/.test(error.message)) {
        apiError(res, 400, "VALIDATION_ERROR", error.message);
        return;
      }
      if (error instanceof Error && /^(instruction is required|Run cannot be steered)/.test(error.message)) {
        apiError(res, 409, "ACTIVE_RUN", error.message);
        return;
      }
      apiError(res, 500, "INTERNAL_ERROR", "Attachment operation failed");
    });
  };
}

function publicAttachment(record: AttachmentRecord) {
  return {
    id: record.id,
    conversationId: record.conversationId,
    messageId: record.messageId,
    displayName: record.displayName,
    mediaType: record.mediaType,
    byteSize: record.byteSize,
    ingestionStatus: record.ingestionStatus,
    providerDisposition: record.providerDisposition,
    createdAt: record.createdAt,
  };
}

export function createChatWorkspaceRouter(
  workspace: ConversationWorkspace,
  options: {
    hasActiveRun?: (conversationId: string) => boolean;
    attachments?: AttachmentWorkspace;
    branches?: BranchWorkspace;
    branchSession?: (conversationId: string) => Promise<BranchSession>;
    runs?: RunManager;
  } = {},
): Router {
  const router = express.Router();
  const workspaceJson = express.json({ limit: "1mb" });
  router.use((req: Request, res: Response, next: NextFunction) => {
    const isChatRequest = req.method === "POST" && /^\/conversations\/[^/]+\/chat\/?$/.test(req.path);
    if (isChatRequest) return next();
    workspaceJson(req, res, next);
  });

  router.get("/conversations", handle((req, res) => {
    const status = req.query.status;
    if (status !== undefined && status !== "active" && status !== "archived") throw new Error("status must be active or archived");
    const pinned = req.query.pinned;
    if (pinned !== undefined && pinned !== "true" && pinned !== "false") throw new Error("pinned must be true or false");
    res.json(workspace.listConversations({
      q: typeof req.query.q === "string" ? req.query.q : undefined,
      projectId: typeof req.query.projectId === "string" ? req.query.projectId : undefined,
      folderId: typeof req.query.folderId === "string" ? req.query.folderId : undefined,
      status,
      pinned: pinned === undefined ? undefined : pinned === "true",
    }));
  }));

  router.post("/conversations", handle((req, res) => {
    const body = bodyObject(req);
    const created = workspace.createConversation({
      title: optionalString(body.title, "title"),
      projectId: optionalString(body.projectId, "projectId"),
      folderId: optionalString(body.folderId, "folderId"),
    });
    res.status(201).json(created);
  }));

  router.get("/conversations/:id", (req, res) => {
    const conversation = workspace.getConversation(routeId(req.params.id));
    if (!conversation) return apiError(res, 404, "NOT_FOUND", "Conversation not found");
    res.json(conversation);
  });

  router.patch("/conversations/:id", asyncHandle(async (req, res) => {
    const body = bodyObject(req);
    const patch: ConversationPatch = {
      title: optionalString(body.title, "title"),
      projectId: optionalNullableString(body.projectId, "projectId"),
      folderId: optionalNullableString(body.folderId, "folderId"),
      modelId: optionalNullableString(body.modelId, "modelId"),
      activeBranchId: optionalString(body.activeBranchId, "activeBranchId"),
      pinned: optionalBoolean(body.pinned, "pinned"),
      archived: optionalBoolean(body.archived, "archived"),
    };
    const conversationId = routeId(req.params.id);
    if (patch.activeBranchId && options.branches && options.branchSession) {
      await options.branches.select(conversationId, patch.activeBranchId, await options.branchSession(conversationId));
      delete patch.activeBranchId;
    }
    const updated = workspace.updateConversation(conversationId, patch);
    if (!updated) return apiError(res, 404, "NOT_FOUND", "Conversation not found");
    res.json(updated);
  }));

  router.get("/conversations/:id/branches", asyncHandle(async (req, res) => {
    if (!options.branches || !options.branchSession) return apiError(res, 503, "INTERNAL_ERROR", "Branch service unavailable");
    const id = routeId(req.params.id);
    res.json(options.branches.list(id, await options.branchSession(id)));
  }));

  router.post("/conversations/:id/branches", asyncHandle(async (req, res) => {
    if (!options.branches || !options.branchSession) return apiError(res, 503, "INTERNAL_ERROR", "Branch service unavailable");
    const body = bodyObject(req);
    const sourceMessageId = optionalString(body.sourceMessageId, "sourceMessageId");
    const replacementContent = optionalString(body.replacementContent, "replacementContent");
    if (!sourceMessageId || !replacementContent) throw new Error("sourceMessageId and replacementContent are required");
    const id = routeId(req.params.id);
    const branch = await options.branches.create(id, { sourceMessageId, replacementContent }, await options.branchSession(id));
    res.status(201).json(branch);
  }));

  router.delete("/conversations/:id", handle((req, res) => {
    const id = routeId(req.params.id);
    if (options.hasActiveRun?.(id)) return apiError(res, 409, "ACTIVE_RUN", "Conversation has an active run");
    const body = bodyObject(req);
    if (body.deleteOwnedFiles !== true) throw new Error("deleteOwnedFiles must be true");
    if (!workspace.deleteConversation(id, { deleteOwnedFiles: true })) {
      return apiError(res, 404, "NOT_FOUND", "Conversation not found");
    }
    res.status(204).end();
  }));

  router.post("/conversations/:id/attachments", asyncHandle(async (req, res) => {
    if (!options.attachments) return apiError(res, 503, "INTERNAL_ERROR", "Attachment service unavailable");
    const body = bodyObject(req);
    const localPath = optionalString(body.localPath, "localPath");
    if (!localPath) throw new AttachmentError("NOT_FOUND", "Selected file path is required");
    const conversationId = routeId(req.params.id);
    const record = await options.attachments.stage(conversationId, localPath, workspace.getConversation(conversationId)?.activeBranchId);
    res.status(201).json(publicAttachment(record));
  }));

  router.get("/conversations/:id/attachments/:attachmentId", (req, res) => {
    if (!options.attachments) return apiError(res, 503, "INTERNAL_ERROR", "Attachment service unavailable");
    const record = options.attachments.get(routeId(req.params.id), routeId(req.params.attachmentId, "attachmentId"));
    if (!record) return apiError(res, 404, "NOT_FOUND", "Attachment not found");
    res.json(publicAttachment(record));
  });

  router.delete("/conversations/:id/attachments/:attachmentId", (req, res) => {
    if (!options.attachments) return apiError(res, 503, "INTERNAL_ERROR", "Attachment service unavailable");
    if (!options.attachments.delete(routeId(req.params.id), routeId(req.params.attachmentId, "attachmentId"))) {
      return apiError(res, 404, "NOT_FOUND", "Attachment not found");
    }
    res.status(204).end();
  });

  router.post("/conversations/:id/runs", handle((req, res) => {
    if (!options.runs) return apiError(res, 503, "INTERNAL_ERROR", "Run service unavailable");
    const id = routeId(req.params.id);
    if (!workspace.getConversation(id)) return apiError(res, 404, "NOT_FOUND", "Conversation not found");
    const body = bodyObject(req);
    const run = options.runs.start({
      conversationId: id,
      branchId: optionalString(body.branchId, "branchId"),
      model: optionalString(body.model, "model"),
    });
    res.status(201).json(run);
  }));

  router.get("/runs/:runId", (req, res) => {
    if (!options.runs) return apiError(res, 503, "INTERNAL_ERROR", "Run service unavailable");
    const run = options.runs.get(routeId(req.params.runId, "runId"));
    if (!run) return apiError(res, 404, "NOT_FOUND", "Run not found");
    res.json({ ...run, plan: options.runs.plan(run.id) });
  });

  router.get("/conversations/:id/runs", (req, res) => {
    if (!options.runs) return apiError(res, 503, "INTERNAL_ERROR", "Run service unavailable");
    const runs = options.runs.listConversationRuns(routeId(req.params.id));
    const activeOnly = req.query.active === "true";
    res.json(activeOnly ? runs.filter((run) => run.status === "queued" || run.status === "running") : runs);
  });

  router.get("/runs/:runId/events", (req, res) => {
    if (!options.runs) return apiError(res, 503, "INTERNAL_ERROR", "Run service unavailable");
    const runId = routeId(req.params.runId, "runId");
    if (!options.runs.get(runId)) return apiError(res, 404, "NOT_FOUND", "Run not found");
    const rawAfter = typeof req.query.after === "string" ? req.query.after : req.header("Last-Event-ID") ?? "0";
    const after = Number(rawAfter);
    if (!Number.isSafeInteger(after) || after < 0) return apiError(res, 400, "VALIDATION_ERROR", "after must be a non-negative integer");
    const replay = options.runs.events(runId, after);
    if (!req.header("Accept")?.includes("text/event-stream")) return res.json(replay);

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
    const write = (event: (typeof replay)[number]) => {
      res.write(`id: ${event.cursor}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
    };
    replay.forEach(write);
    const unsubscribe = options.runs.subscribe(runId, write);
    req.on("close", unsubscribe);
  });

  router.post("/runs/:runId/stop", (req, res) => {
    if (!options.runs) return apiError(res, 503, "INTERNAL_ERROR", "Run service unavailable");
    const id = routeId(req.params.runId, "runId");
    const existing = options.runs.get(id);
    if (!existing) return apiError(res, 404, "NOT_FOUND", "Run not found");
    res.json(options.runs.stop(id) ?? existing);
  });

  router.post("/runs/:runId/steer", asyncHandle(async (req, res) => {
    if (!options.runs) return apiError(res, 503, "INTERNAL_ERROR", "Run service unavailable");
    const instruction = optionalString(bodyObject(req).instruction, "instruction");
    if (!instruction) throw new Error("instruction is required");
    res.json(await options.runs.steer(routeId(req.params.runId, "runId"), instruction));
  }));

  router.get("/projects", (_req, res) => res.json(workspace.listProjects()));
  router.post("/projects", handle((req, res) => {
    const body = bodyObject(req);
    const name = optionalString(body.name, "name") ?? "";
    res.status(201).json(workspace.createProject({ name }));
  }));
  router.patch("/projects/:id", handle((req, res) => {
    const name = optionalString(bodyObject(req).name, "name") ?? "";
    const updated = workspace.updateProject(routeId(req.params.id), { name });
    if (!updated) return apiError(res, 404, "NOT_FOUND", "Project not found");
    res.json(updated);
  }));
  router.delete("/projects/:id", (req, res) => {
    if (!workspace.deleteProject(routeId(req.params.id))) return apiError(res, 404, "NOT_FOUND", "Project not found");
    res.status(204).end();
  });

  router.get("/folders", (_req, res) => res.json(workspace.listFolders()));
  router.post("/folders", handle((req, res) => {
    const body = bodyObject(req);
    const position = body.position;
    if (position !== undefined && (!Number.isInteger(position) || (position as number) < 0)) throw new Error("position must be a non-negative integer");
    res.status(201).json(workspace.createFolder({
      name: optionalString(body.name, "name") ?? "",
      projectId: optionalString(body.projectId, "projectId"),
      parentId: optionalString(body.parentId, "parentId"),
      position: position as number | undefined,
    }));
  }));
  router.patch("/folders/:id", handle((req, res) => {
    const body = bodyObject(req);
    const position = body.position;
    if (position !== undefined && (!Number.isInteger(position) || (position as number) < 0)) throw new Error("position must be a non-negative integer");
    const updated = workspace.updateFolder(routeId(req.params.id), {
      name: optionalString(body.name, "name"),
      projectId: optionalString(body.projectId, "projectId"),
      parentId: optionalString(body.parentId, "parentId"),
      position: position as number | undefined,
    });
    if (!updated) return apiError(res, 404, "NOT_FOUND", "Folder not found");
    res.json(updated);
  }));
  router.delete("/folders/:id", (req, res) => {
    if (!workspace.deleteFolder(routeId(req.params.id))) return apiError(res, 404, "NOT_FOUND", "Folder not found");
    res.status(204).end();
  });

  return router;
}
