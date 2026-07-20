import { useSyncExternalStore } from "react";
import { chooseChatAttachments } from "../lib/nativeFiles.js";
import { API_BASE } from "./apiBase.js";

export type AttachmentState = "uploading" | "ready" | "rejected" | "missing";
export type AttachmentDisclosure = "local_only" | "referenced" | "sent";

export interface AttachmentView {
  id: string;
  name: string;
  mediaType: string;
  byteSize: number;
  state: AttachmentState;
  disclosure: AttachmentDisclosure;
  error?: string;
}

interface DraftEntry {
  items: readonly AttachmentView[];
  listeners: Set<() => void>;
}

interface PublicAttachment {
  id: string;
  displayName: string;
  mediaType: string;
  byteSize: number;
  ingestionStatus: "ready" | "rejected" | "missing";
  providerDisposition: AttachmentDisclosure;
}

const drafts = new Map<string, DraftEntry>();
const activeBranches = new Map<string, string>();

function draftKey(conversationId: string): string {
  const branchId = activeBranches.get(conversationId);
  return branchId ? `${conversationId}:${branchId}` : conversationId;
}

function entry(conversationId: string): DraftEntry {
  let value = drafts.get(conversationId);
  if (!value) {
    value = { items: [], listeners: new Set() };
    drafts.set(conversationId, value);
  }
  return value;
}

function publish(conversationId: string, items: readonly AttachmentView[]): void {
  const value = entry(conversationId);
  value.items = items;
  for (const listener of value.listeners) listener();
}

function filenameOnly(localPath: string): string {
  return localPath.split(/[\\/]/).at(-1)?.trim() || "Selected file";
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Could not stage this file";
}

export function useAttachmentDraft(conversationId: string | null): readonly AttachmentView[] {
  const id = conversationId ? draftKey(conversationId) : "__no_conversation__";
  return useSyncExternalStore(
    (listener) => {
      const value = entry(id);
      value.listeners.add(listener);
      return () => value.listeners.delete(listener);
    },
    () => entry(id).items,
    () => entry(id).items,
  );
}

export async function chooseAndStageAttachments(
  conversationId: string,
  deps: { choose?: typeof chooseChatAttachments; fetch?: typeof globalThis.fetch } = {},
): Promise<void> {
  const paths = await (deps.choose ?? chooseChatAttachments)();
  const key = draftKey(conversationId);
  const request = deps.fetch ?? globalThis.fetch;
  await Promise.all(paths.map(async (localPath) => {
    const temporaryId = `staging-${crypto.randomUUID()}`;
    const name = filenameOnly(localPath);
    publish(key, [...entry(key).items, {
      id: temporaryId,
      name,
      mediaType: "application/octet-stream",
      byteSize: 0,
      state: "uploading",
      disclosure: "local_only",
    }]);

    try {
      const response = await request(`${API_BASE}/api/conversations/${encodeURIComponent(conversationId)}/attachments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ localPath }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
        throw new Error(body?.error?.message ?? `Staging failed (${response.status})`);
      }
      const staged = await response.json() as PublicAttachment;
      publish(key, entry(key).items.map((item) => item.id === temporaryId ? {
        id: staged.id,
        name: staged.displayName,
        mediaType: staged.mediaType,
        byteSize: staged.byteSize,
        state: staged.ingestionStatus,
        disclosure: staged.providerDisposition,
      } : item));
    } catch (error) {
      publish(key, entry(key).items.map((item) => item.id === temporaryId ? {
        ...item,
        state: "rejected",
        error: errorMessage(error),
      } : item));
    }
  }));
}

export async function removeAttachmentDraft(conversationId: string, attachmentId: string): Promise<void> {
  const key = draftKey(conversationId);
  const item = entry(key).items.find((candidate) => candidate.id === attachmentId);
  publish(key, entry(key).items.filter((candidate) => candidate.id !== attachmentId));
  if (item?.state === "ready" && !item.id.startsWith("staging-")) {
    await globalThis.fetch(`${API_BASE}/api/conversations/${encodeURIComponent(conversationId)}/attachments/${encodeURIComponent(attachmentId)}`, {
      method: "DELETE",
    }).catch(() => undefined);
  }
}

export function firstBlockingAttachment(conversationId: string): AttachmentView | undefined {
  return entry(draftKey(conversationId)).items.find((item) => item.state !== "ready");
}

export function hasReadyAttachments(conversationId: string): boolean {
  return entry(draftKey(conversationId)).items.some((item) => item.state === "ready");
}

export function prepareAttachmentRequestBody(
  conversationId: string,
  options: {
    id: string;
    messages: unknown[];
    trigger: "submit-message" | "regenerate-message";
    messageId: string | undefined;
    body: Record<string, unknown> | undefined;
    requestMetadata?: unknown;
  },
): object {
  const key = draftKey(conversationId);
  const attachmentIds = entry(key).items.filter((item) => item.state === "ready").map((item) => item.id);
  const body = {
    ...options.body,
    id: options.id,
    messages: options.messages,
    trigger: options.trigger,
    messageId: options.messageId,
    metadata: options.requestMetadata,
    attachmentIds,
  };
  if (options.trigger === "submit-message") publish(key, []);
  return body;
}

export function __replaceAttachmentDraftForTests(conversationId: string, items: readonly AttachmentView[]): void {
  publish(draftKey(conversationId), items);
}

export function setActiveAttachmentBranch(conversationId: string, branchId: string | undefined): void {
  if (branchId) activeBranches.set(conversationId, branchId);
  else activeBranches.delete(conversationId);
}

export function __resetAttachmentDraftsForTests(): void {
  drafts.clear();
  activeBranches.clear();
}
