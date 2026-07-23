import {
  open,
  save,
  type OpenDialogOptions,
  type SaveDialogOptions,
} from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { mediaCategory, sizeBucket, trackDesktopEvent } from "./analytics.js";

type OpenDialog = (options: OpenDialogOptions & { multiple: true }) => Promise<string | string[] | null>;
type SaveDialog = (options?: SaveDialogOptions) => Promise<string | null>;

const ATTACHMENT_FILTERS = [
  { name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif"] },
  {
    name: "Files",
    extensions: [
      "txt", "md", "markdown", "json", "csv", "tsv",
      "js", "jsx", "ts", "tsx", "css", "py", "rs", "go", "java",
      "c", "h", "cpp", "hpp", "swift", "kt", "kts", "sql", "yaml", "yml", "toml", "xml",
    ],
  },
] satisfies OpenDialogOptions["filters"];

export async function chooseChatAttachments(openDialog: OpenDialog = open): Promise<string[]> {
  const selected = await openDialog({
    title: "Attach files or images",
    multiple: true,
    directory: false,
    filters: ATTACHMENT_FILTERS,
    fileAccessMode: "scoped",
  });
  if (selected === null) return [];
  return Array.isArray(selected) ? selected : [selected];
}

function safeSuggestedName(name: string): string {
  const parts = name.split(/[\\/]/);
  const basename = parts.at(-1)?.trim();
  return basename || "generated-file";
}

export async function chooseGeneratedFileDestination(
  suggestedName: string,
  saveDialog: SaveDialog = save,
): Promise<string | null> {
  return saveDialog({
    title: "Save generated file",
    defaultPath: safeSuggestedName(suggestedName),
    canCreateDirectories: true,
  });
}

export type GeneratedFileSaveResult = { status: "saved" | "cancelled" };
export type GeneratedFileSaveRequest = {
  conversationId: string;
  runId: string;
  fileId: string;
  name: string;
  mediaType?: string;
  byteSize?: number;
};
export type ScheduledRunFileSaveRequest = {
  taskId: string;
  runId: string;
  fileId: string;
  name: string;
  mediaType?: string;
  byteSize?: number;
};

type NativeInvoke = typeof invoke;

/** The webview supplies opaque IDs only; Rust owns source resolution and destination selection. */
export async function saveGeneratedFile(
  request: GeneratedFileSaveRequest,
  nativeInvoke: NativeInvoke = invoke,
): Promise<GeneratedFileSaveResult> {
  try {
    const result = await nativeInvoke<GeneratedFileSaveResult>("save_generated_file", {
      conversationId: request.conversationId,
      runId: request.runId,
      fileId: request.fileId,
      fileName: safeSuggestedName(request.name),
    });
    if (result.status !== "saved" && result.status !== "cancelled") {
      throw new Error("Native save returned an invalid status");
    }
    trackDesktopEvent({ name: "generated_file_save_terminal", properties: { outcome: result.status, media_category: mediaCategory(request.mediaType), size_bucket: sizeBucket(request.byteSize) } });
    return result;
  } catch (error) {
    trackDesktopEvent({ name: "generated_file_save_terminal", properties: { outcome: "failed", media_category: mediaCategory(request.mediaType), size_bucket: sizeBucket(request.byteSize) } });
    const message = error instanceof Error ? error.message : "Generated file save failed";
    throw new Error(message, { cause: error });
  }
}

/** Scheduled output variant: opaque scheduler IDs only; native code owns source resolution. */
export async function saveScheduledRunFile(
  request: ScheduledRunFileSaveRequest,
  nativeInvoke: NativeInvoke = invoke,
): Promise<GeneratedFileSaveResult> {
  try {
    const result = await nativeInvoke<GeneratedFileSaveResult>("save_scheduled_run_file", {
      taskId: request.taskId,
      runId: request.runId,
      fileId: request.fileId,
      fileName: safeSuggestedName(request.name),
    });
    if (result.status !== "saved" && result.status !== "cancelled") throw new Error("Native save returned an invalid status");
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Scheduled run file save failed";
    throw new Error(message, { cause: error });
  }
}
