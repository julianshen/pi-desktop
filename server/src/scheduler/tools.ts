import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { createMemoryTools } from "../memory/tools.js";
import { createSearchTools } from "../search/tools.js";
import { createWebFetchTools } from "../web-fetch/tools.js";
import { resolveWorkspaceFile } from "../chat-workspace/generated-files.js";
import type { RunStore } from "./run-store.js";
import type { ScheduledRunFile } from "./types.js";

export const SCHEDULED_ALLOWED_TOOL_NAMES = [
  "read",
  "bash",
  "edit",
  "write",
  "remember",
  "recall",
  "web_fetch",
  "web_search",
  "publish_generated_file",
] as const;

const SCHEDULED_CUSTOM_TOOL_NAMES = SCHEDULED_ALLOWED_TOOL_NAMES.slice(4);
const mediaTypes: Record<string, string> = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".zip": "application/zip",
  ".html": "text/html",
};

export function scheduledCustomToolNames(): string[] {
  return [...SCHEDULED_CUSTOM_TOOL_NAMES];
}

export interface ScheduledToolContext {
  taskId: string;
  runId: string;
  cwd: string;
  runStore: RunStore;
  publishFile(file: ScheduledRunFile): void;
}

function createScheduledGeneratedFileTool(context: ScheduledToolContext) {
  return defineTool({
    name: "publish_generated_file",
    label: "Publish generated file",
    description: "Copy a file created in this scheduled task workspace into the durable run result.",
    parameters: Type.Object({
      path: Type.String(),
      name: Type.Optional(Type.String()),
      mediaType: Type.Optional(Type.String()),
    }),
    execute: async (_toolCallId, params) => {
      const source = resolveWorkspaceFile(context.cwd, params.path);
      const stat = fs.statSync(source);
      const id = randomUUID();
      const destinationRoot = context.runStore.filesDir(context.taskId, context.runId);
      fs.mkdirSync(destinationRoot, { recursive: true });
      const destination = path.join(destinationRoot, id);
      try {
        await pipeline(
          fs.createReadStream(source),
          fs.createWriteStream(destination, { flags: "wx", mode: 0o600 }),
        );
      } catch (error) {
        fs.rmSync(destination, { force: true });
        throw error;
      }
      const name = path.basename(params.name?.trim() || source);
      const file: ScheduledRunFile = {
        id,
        name,
        mediaType: params.mediaType?.trim()
          || mediaTypes[path.extname(name).toLowerCase()]
          || "application/octet-stream",
        byteSize: stat.size,
        state: "available",
      };
      context.publishFile(file);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ generatedFile: file }) }],
        details: { generatedFile: file },
      };
    },
  });
}

export function createScheduledTools(context: ScheduledToolContext) {
  return [
    ...createMemoryTools(),
    ...createWebFetchTools(context.taskId, "scheduled"),
    ...createSearchTools(context.taskId),
    createScheduledGeneratedFileTool(context),
  ];
}
