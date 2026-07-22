import fs from "node:fs";
import path from "node:path";
import express, { Router, type Request, type Response } from "express";
import { SchedulerError, SchedulerService, type CreateScheduledTaskInput, type UpdateScheduledTaskInput } from "./service.js";

const CREATE_KEYS = new Set(["name", "prompt", "cron", "timezone", "enabled", "modelId"]);
const PATCH_KEYS = CREATE_KEYS;

function fail(code: string, message: string, status = 400): never {
  throw new SchedulerError(code, message, status);
}

function objectBody(request: Request): Record<string, unknown> {
  if (!request.body || typeof request.body !== "object" || Array.isArray(request.body)) {
    return fail("invalid_request", "Request body must be a JSON object.");
  }
  return request.body as Record<string, unknown>;
}

function rejectUnknownKeys(body: Record<string, unknown>, allowed: Set<string>): void {
  if (Object.keys(body).some((key) => !allowed.has(key))) {
    fail("invalid_request", "Request contains an unsupported field.");
  }
}

function routeParam(request: Request, key: string): string {
  const value = request.params[key];
  if (typeof value !== "string") return fail("invalid_request", `Route parameter ${key} is invalid.`);
  return value;
}

function optionalModel(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value !== "string") return fail("invalid_request", "modelId must be a string or null.");
  return value;
}

function createInput(request: Request): CreateScheduledTaskInput {
  const body = objectBody(request);
  rejectUnknownKeys(body, CREATE_KEYS);
  if (
    typeof body.name !== "string"
    || typeof body.prompt !== "string"
    || typeof body.cron !== "string"
    || (body.timezone !== undefined && typeof body.timezone !== "string")
    || typeof body.enabled !== "boolean"
  ) {
    return fail("invalid_request", "name, prompt, cron, and enabled are required with valid types.");
  }
  return {
    name: body.name,
    prompt: body.prompt,
    cron: body.cron,
    ...(body.timezone !== undefined ? { timezone: body.timezone as string } : {}),
    enabled: body.enabled,
    modelId: optionalModel(body.modelId),
  };
}

function updateInput(request: Request): UpdateScheduledTaskInput {
  const body = objectBody(request);
  rejectUnknownKeys(body, PATCH_KEYS);
  if (Object.keys(body).length === 0) return fail("invalid_request", "At least one field is required.");
  for (const key of ["name", "prompt", "cron", "timezone"] as const) {
    if (body[key] !== undefined && typeof body[key] !== "string") {
      return fail("invalid_request", `${key} must be a string.`);
    }
  }
  if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
    return fail("invalid_request", "enabled must be a boolean.");
  }
  return {
    ...(body.name !== undefined ? { name: body.name as string } : {}),
    ...(body.prompt !== undefined ? { prompt: body.prompt as string } : {}),
    ...(body.cron !== undefined ? { cron: body.cron as string } : {}),
    ...(body.timezone !== undefined ? { timezone: body.timezone as string } : {}),
    ...(body.enabled !== undefined ? { enabled: body.enabled as boolean } : {}),
    ...(body.modelId !== undefined ? { modelId: optionalModel(body.modelId) } : {}),
  };
}

function asyncRoute(
  handler: (request: Request, response: Response) => Promise<void> | void,
) {
  return (request: Request, response: Response, next: (error?: unknown) => void) => {
    Promise.resolve(handler(request, response)).catch(next);
  };
}

export function createScheduledTasksRouter(service: SchedulerService): Router {
  const router = Router();
  router.use(express.json({ limit: "256kb" }));

  router.get("/api/scheduled-tasks", (_request, response) => {
    response.json({ tasks: service.listTaskSummaries(), unreadCount: service.unreadCount() });
  });
  router.post("/api/scheduled-tasks", asyncRoute(async (request, response) => {
    const task = await service.create(createInput(request));
    response.status(201).json({ task: service.taskDetail(task.id).task });
  }));
  router.post("/api/scheduled-tasks/read-all", (_request, response) => {
    service.markAllRead();
    response.status(204).end();
  });
  router.get("/api/scheduled-tasks/:taskId", asyncRoute((request, response) => {
    response.json(service.taskDetail(routeParam(request, "taskId")));
  }));
  router.patch("/api/scheduled-tasks/:taskId", asyncRoute(async (request, response) => {
    const task = await service.update(routeParam(request, "taskId"), updateInput(request));
    response.json({ task: service.taskDetail(task.id).task });
  }));
  router.delete("/api/scheduled-tasks/:taskId", asyncRoute(async (request, response) => {
    await service.delete(routeParam(request, "taskId"));
    response.status(204).end();
  }));
  router.post("/api/scheduled-tasks/:taskId/runs", asyncRoute(async (request, response) => {
    response.status(202).json({ run: await service.runNow(routeParam(request, "taskId")) });
  }));
  router.get("/api/scheduled-tasks/:taskId/runs", asyncRoute((request, response) => {
    const limit = request.query.limit === undefined ? 25 : Number(request.query.limit);
    if (!Number.isInteger(limit) || limit < 1) fail("invalid_limit", "Run limit must be a positive integer.");
    response.json(service.listRuns(
      routeParam(request, "taskId"),
      typeof request.query.cursor === "string" ? request.query.cursor : undefined,
      limit,
    ));
  }));
  router.get("/api/scheduled-tasks/:taskId/runs/:runId", asyncRoute((request, response) => {
    response.json({ run: service.getRun(routeParam(request, "taskId"), routeParam(request, "runId")) });
  }));
  router.post("/api/scheduled-tasks/:taskId/runs/:runId/read", asyncRoute((request, response) => {
    service.markRunRead(routeParam(request, "taskId"), routeParam(request, "runId"));
    response.status(204).end();
  }));
  router.get("/api/scheduled-tasks/:taskId/runs/:runId/files/:fileId", asyncRoute((request, response) => {
    const resolved = service.resolveRunFile(
      routeParam(request, "taskId"),
      routeParam(request, "runId"),
      routeParam(request, "fileId"),
    );
    const name = path.basename(resolved.file.name).replace(/["\\\r\n]/g, "_") || "generated-file";
    response.status(200);
    response.setHeader("Content-Type", resolved.file.mediaType);
    response.setHeader("Content-Length", String(fs.statSync(resolved.path).size));
    response.setHeader("Content-Disposition", `attachment; filename="${name}"`);
    fs.createReadStream(resolved.path).pipe(response);
  }));

  router.use((
    error: unknown,
    _request: Request,
    response: Response,
    _next: (error?: unknown) => void,
  ) => {
    if (error instanceof SchedulerError) {
      response.status(error.status).json({
        error: { code: error.code, message: error.message, retryable: error.retryable },
      });
      return;
    }
    console.error("[scheduled-tasks] unhandled route error", error);
    response.status(500).json({
      error: { code: "internal_error", message: "Scheduled Tasks request failed.", retryable: true },
    });
  });
  return router;
}
