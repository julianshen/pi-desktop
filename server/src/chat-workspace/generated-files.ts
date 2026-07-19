import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { env } from "../config/env.js";
import { getActiveRunContext } from "../agent/plan-tools.js";

const MAX_GENERATED_FILE_BYTES = 100 * 1024 * 1024;
const mediaTypes: Record<string, string> = {
  ".txt": "text/plain", ".md": "text/markdown", ".csv": "text/csv", ".json": "application/json",
  ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".zip": "application/zip", ".html": "text/html",
};

export interface GeneratedFileMetadata {
  id: string; runId: string; name: string; mediaType: string; byteSize: number; state: "available";
}

function resolveWorkspaceFile(cwd: string, requested: string): string {
  const root = path.resolve(cwd);
  const source = path.resolve(root, requested);
  if (source !== root && !source.startsWith(`${root}${path.sep}`)) throw new Error("Generated file must be inside the conversation workspace");
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Generated file must be a regular non-symlink file");
  if (stat.size > MAX_GENERATED_FILE_BYTES) throw new Error("Generated file exceeds the 100 MiB limit");
  return source;
}

export function createGeneratedFileTools(conversationId: string, cwd: string, dataDir = env.dataDir) {
  return [defineTool({
    name: "publish_generated_file",
    label: "Publish generated file",
    description: "Make a file you created in the conversation workspace available as a downloadable chat result.",
    parameters: Type.Object({ path: Type.String(), name: Type.Optional(Type.String()), mediaType: Type.Optional(Type.String()) }),
    execute: async (_id, params) => {
      const context = getActiveRunContext(conversationId);
      if (!context) throw new Error("No active durable run for generated file publishing");
      const source = resolveWorkspaceFile(cwd, params.path);
      const stat = fs.statSync(source);
      const fileId = randomUUID();
      const ownedRoot = path.join(dataDir, "generated-files", conversationId, context.runId);
      fs.mkdirSync(ownedRoot, { recursive: true });
      const destination = path.join(ownedRoot, fileId);
      try { await pipeline(fs.createReadStream(source), fs.createWriteStream(destination, { flags: "wx", mode: 0o600 })); }
      catch (error) { fs.rmSync(destination, { force: true }); throw error; }
      const name = path.basename(params.name?.trim() || source);
      const generatedFile: GeneratedFileMetadata = {
        id: fileId, runId: context.runId, name,
        mediaType: params.mediaType?.trim() || mediaTypes[path.extname(name).toLowerCase()] || "application/octet-stream",
        byteSize: stat.size, state: "available",
      };
      context.manager.emit(context.runId, "file_created", generatedFile);
      return { content: [{ type: "text", text: JSON.stringify({ generatedFile }) }], details: { generatedFile } };
    },
  })];
}
