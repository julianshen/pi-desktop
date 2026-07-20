import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ImageContent } from "@earendil-works/pi-ai/compat";
import { ChatWorkspaceStore, type AttachmentRecord } from "./store.js";
import { mediaCategory, sizeBucket, trackServerEvent } from "../analytics/events.js";

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_TURN = 10;

export type AttachmentErrorCode =
  | "NOT_FOUND"
  | "NOT_A_FILE"
  | "SYMLINK_NOT_ALLOWED"
  | "TOO_LARGE"
  | "UNSUPPORTED_TYPE"
  | "SIGNATURE_MISMATCH"
  | "INVALID_TEXT"
  | "TOO_MANY_ATTACHMENTS"
  | "ATTACHMENT_NOT_READY";

export class AttachmentError extends Error {
  constructor(readonly code: AttachmentErrorCode, message: string) {
    super(message);
    this.name = "AttachmentError";
  }
}

const TEXT_TYPES: Record<string, string> = {
  ".txt": "text/plain", ".md": "text/markdown", ".markdown": "text/markdown",
  ".json": "application/json", ".csv": "text/csv", ".tsv": "text/tab-separated-values",
  ".js": "text/javascript", ".jsx": "text/javascript", ".ts": "text/typescript", ".tsx": "text/typescript",
  ".css": "text/css", ".py": "text/x-python", ".rs": "text/x-rust", ".go": "text/x-go",
  ".java": "text/x-java", ".c": "text/x-c", ".h": "text/x-c", ".cpp": "text/x-c++", ".hpp": "text/x-c++",
  ".swift": "text/x-swift", ".kt": "text/x-kotlin", ".kts": "text/x-kotlin", ".sql": "text/x-sql",
  ".yaml": "application/yaml", ".yml": "application/yaml", ".toml": "application/toml", ".xml": "application/xml",
};
const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".gif": "image/gif",
};

function signatureMatches(mediaType: string, bytes: Buffer): boolean {
  if (mediaType === "image/png") return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mediaType === "image/jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mediaType === "image/gif") return bytes.subarray(0, 6).toString("ascii") === "GIF87a" || bytes.subarray(0, 6).toString("ascii") === "GIF89a";
  if (mediaType === "image/webp") return bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
  return true;
}

function inspectSource(sourcePath: string): { mediaType: string; size: number; isText: boolean } {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(sourcePath);
  } catch {
    throw new AttachmentError("NOT_FOUND", "Selected file no longer exists");
  }
  if (stat.isSymbolicLink()) throw new AttachmentError("SYMLINK_NOT_ALLOWED", "Symbolic links cannot be attached");
  if (!stat.isFile()) throw new AttachmentError("NOT_A_FILE", "Selection must be a regular file");
  if (stat.size > MAX_ATTACHMENT_BYTES) throw new AttachmentError("TOO_LARGE", "File exceeds the 25 MiB limit");

  const extension = path.extname(sourcePath).toLowerCase();
  const isText = extension in TEXT_TYPES;
  const mediaType = TEXT_TYPES[extension] ?? IMAGE_TYPES[extension];
  if (!mediaType) throw new AttachmentError("UNSUPPORTED_TYPE", "This file type is not supported");
  const handle = fs.openSync(sourcePath, "r");
  const header = Buffer.alloc(16);
  try { fs.readSync(handle, header, 0, header.length, 0); } finally { fs.closeSync(handle); }
  if (!signatureMatches(mediaType, header)) throw new AttachmentError("SIGNATURE_MISMATCH", "File contents do not match its extension");
  return { mediaType, size: stat.size, isText };
}

export interface MaterializedAttachments {
  textReferences: Array<{ id: string; name: string; text: string }>;
  images: ImageContent[];
}

export class AttachmentWorkspace {
  constructor(
    private readonly store: ChatWorkspaceStore,
    private readonly dataDir: string,
  ) {}

  async stage(conversationId: string, sourcePath: string, branchId?: string): Promise<AttachmentRecord> {
    if (!this.store.getConversation(conversationId)) throw new AttachmentError("NOT_FOUND", "Conversation not found");
    const inspected = inspectSource(sourcePath);
    const id = randomUUID();
    const ownedRoot = path.resolve(this.dataDir, "attachments", conversationId);
    fs.mkdirSync(ownedRoot, { recursive: true });
    const destination = path.join(ownedRoot, `${id}.bin`);
    const hash = createHash("sha256");
    const decoder = inspected.isText ? new TextDecoder("utf-8", { fatal: true }) : undefined;
    const validatingHash = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        try {
          hash.update(chunk);
          if (decoder) {
            const text = decoder.decode(chunk, { stream: true });
            if (text.includes("\0")) throw new AttachmentError("INVALID_TEXT", "Text files cannot contain NUL bytes");
          }
          callback(null, chunk);
        } catch (error) { callback(error as Error); }
      },
      flush(callback) {
        try { decoder?.decode(); callback(); } catch { callback(new AttachmentError("INVALID_TEXT", "Text file is not valid UTF-8")); }
      },
    });

    try {
      await pipeline(fs.createReadStream(sourcePath), validatingHash, fs.createWriteStream(destination, { flags: "wx" }));
      const record: AttachmentRecord = {
        id,
        conversationId,
        branchId,
        localPath: destination,
        displayName: path.basename(sourcePath),
        mediaType: inspected.mediaType,
        byteSize: inspected.size,
        sha256: hash.digest("hex"),
        ingestionStatus: "ready",
        providerDisposition: "local_only",
        createdAt: new Date().toISOString(),
      };
      const created = this.store.createAttachment(record);
      trackServerEvent({ name: "chat_attachment_dispositioned", properties: { outcome: "local_only", media_category: mediaCategory(record.mediaType), size_bucket: sizeBucket(record.byteSize) } });
      return created;
    } catch (error) {
      fs.rmSync(destination, { force: true });
      if (error instanceof AttachmentError) throw error;
      throw new AttachmentError("INVALID_TEXT", error instanceof Error ? error.message : "Attachment copy failed");
    }
  }

  get(conversationId: string, id: string): AttachmentRecord | undefined {
    return this.store.getAttachment(conversationId, id);
  }

  delete(conversationId: string, id: string): boolean {
    const record = this.store.deleteAttachment(conversationId, id);
    if (!record) return false;
    fs.rmSync(record.localPath, { force: true });
    return true;
  }

  async materialize(conversationId: string, attachmentIds: string[], branchId?: string): Promise<MaterializedAttachments> {
    const uniqueIds = [...new Set(attachmentIds)];
    if (uniqueIds.length > MAX_ATTACHMENTS_PER_TURN) throw new AttachmentError("TOO_MANY_ATTACHMENTS", "At most 10 attachments may be referenced per turn");
    const records = uniqueIds.map((id) => {
      const record = this.store.getAttachment(conversationId, id);
      if (!record) {
        trackServerEvent({ name: "chat_attachment_dispositioned", properties: { outcome: "missing", media_category: "unknown", size_bucket: "unknown", reason_code: "not_found" } });
        throw new AttachmentError("NOT_FOUND", `Attachment ${id} was not found`);
      }
      if (record.branchId && record.branchId !== branchId) {
        trackServerEvent({ name: "chat_attachment_dispositioned", properties: { outcome: "rejected", media_category: mediaCategory(record.mediaType), size_bucket: sizeBucket(record.byteSize), reason_code: "branch_mismatch" } });
        throw new AttachmentError("NOT_FOUND", `Attachment ${id} was not found on the active branch`);
      }
      if (record.ingestionStatus !== "ready" || !fs.existsSync(record.localPath)) {
        trackServerEvent({ name: "chat_attachment_dispositioned", properties: { outcome: "missing", media_category: mediaCategory(record.mediaType), size_bucket: sizeBucket(record.byteSize), reason_code: "not_ready" } });
        throw new AttachmentError("ATTACHMENT_NOT_READY", `${record.displayName} is not ready`);
      }
      return record;
    });

    const result: MaterializedAttachments = { textReferences: [], images: [] };
    for (const record of records) {
      if (record.mediaType.startsWith("image/")) {
        const data = await fs.promises.readFile(record.localPath);
        result.images.push({ type: "image", data: data.toString("base64"), mimeType: record.mediaType });
      } else if (record.mediaType === "application/pdf") {
        throw new AttachmentError("UNSUPPORTED_TYPE", "PDF attachments are not supported yet");
      } else {
        const text = await fs.promises.readFile(record.localPath, "utf8");
        result.textReferences.push({ id: record.id, name: record.displayName, text });
      }
      this.store.setAttachmentDisposition(conversationId, record.id, "referenced");
      trackServerEvent({ name: "chat_attachment_dispositioned", properties: { outcome: "sent", media_category: mediaCategory(record.mediaType), size_bucket: sizeBucket(record.byteSize) } });
    }
    return result;
  }
}
