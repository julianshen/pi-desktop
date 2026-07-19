import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  ChatWorkspaceStore,
  type ConversationRecord,
  type FolderRecord,
  type ProjectRecord,
} from "./store.js";

export interface ConversationListQuery {
  q?: string;
  projectId?: string;
  folderId?: string;
  status?: "active" | "archived";
  pinned?: boolean;
}

export interface ConversationListItem extends ConversationRecord {
  searchSnippet?: string;
}

export interface ConversationPatch {
  title?: string;
  projectId?: string | null;
  folderId?: string | null;
  pinned?: boolean;
  archived?: boolean;
  modelId?: string | null;
  activeBranchId?: string;
}

function requiredName(name: string): string {
  const value = name.trim();
  if (!value) throw new Error("Name is required");
  if (value.length > 120) throw new Error("Name must be 120 characters or fewer");
  return value;
}

function snippet(title: string, query: string): string | undefined {
  const index = title.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  if (index < 0) return undefined;
  const start = Math.max(0, index - 24);
  const end = Math.min(title.length, index + query.length + 40);
  return `${start > 0 ? "…" : ""}${title.slice(start, end)}${end < title.length ? "…" : ""}`;
}

export class ConversationWorkspace {
  constructor(
    private readonly store: ChatWorkspaceStore,
    private readonly dataDir: string,
  ) {}

  listConversations(query: ConversationListQuery = {}): ConversationListItem[] {
    const q = query.q?.trim();
    return this.store
      .listConversations()
      .filter((item) => !query.projectId || item.projectId === query.projectId)
      .filter((item) => !query.folderId || item.folderId === query.folderId)
      .filter((item) => query.status !== "archived" ? !item.archivedAt : Boolean(item.archivedAt))
      .filter((item) => query.pinned === undefined || Boolean(item.pinnedAt) === query.pinned)
      .map((item) => ({ ...item, searchSnippet: q ? snippet(item.title, q) : undefined }))
      .filter((item) => !q || item.searchSnippet !== undefined)
      .sort((a, b) => {
        const pinOrder = Number(Boolean(b.pinnedAt)) - Number(Boolean(a.pinnedAt));
        return pinOrder || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);
      });
  }

  getConversation(id: string): ConversationRecord | undefined { return this.store.getConversation(id); }

  createConversation(input: { title?: string; projectId?: string; folderId?: string } = {}): ConversationRecord {
    const now = new Date().toISOString();
    return this.store.createConversation({
      id: randomUUID(),
      title: input.title === undefined ? "New conversation" : requiredName(input.title),
      projectId: input.projectId,
      folderId: input.folderId,
      createdAt: now,
      updatedAt: now,
    });
  }

  updateConversation(id: string, patch: ConversationPatch): ConversationRecord | undefined {
    const current = this.store.getConversation(id);
    if (!current) return undefined;
    if (patch.projectId && !this.store.getProject(patch.projectId)) throw new Error("Unknown project");
    if (patch.folderId && !this.store.getFolder(patch.folderId)) throw new Error("Unknown folder");
    const now = new Date().toISOString();
    return this.store.updateConversation(id, {
      ...(patch.title !== undefined ? { title: requiredName(patch.title) } : {}),
      ...(patch.projectId !== undefined ? { projectId: patch.projectId ?? undefined } : {}),
      ...(patch.folderId !== undefined ? { folderId: patch.folderId ?? undefined } : {}),
      ...(patch.modelId !== undefined ? { modelId: patch.modelId ?? undefined } : {}),
      ...(patch.activeBranchId !== undefined ? { activeBranchId: patch.activeBranchId } : {}),
      ...(patch.pinned !== undefined ? { pinnedAt: patch.pinned ? current.pinnedAt ?? now : undefined } : {}),
      ...(patch.archived !== undefined ? { archivedAt: patch.archived ? current.archivedAt ?? now : undefined } : {}),
      updatedAt: now,
    });
  }

  deleteConversation(id: string, options: { deleteOwnedFiles: true }): boolean {
    const removed = this.store.deleteConversation(id);
    if (!removed) return false;
    if (options.deleteOwnedFiles) {
      for (const directory of ["conversations", "generated-files"]) {
        const root = path.resolve(this.dataDir, directory);
        const owned = path.resolve(root, id);
        if (owned.startsWith(`${root}${path.sep}`)) fs.rmSync(owned, { recursive: true, force: true });
      }
    }
    return true;
  }

  createProject(input: { name: string }): ProjectRecord {
    const now = new Date().toISOString();
    return this.store.createProject({ id: randomUUID(), name: requiredName(input.name), createdAt: now, updatedAt: now });
  }

  listProjects(): ProjectRecord[] { return this.store.listProjects(); }

  updateProject(id: string, input: { name: string }): ProjectRecord | undefined {
    return this.store.updateProject(id, requiredName(input.name), new Date().toISOString());
  }

  deleteProject(id: string): boolean { return this.store.deleteProject(id); }

  createFolder(input: { name: string; projectId?: string; parentId?: string; position?: number }): FolderRecord {
    if (input.projectId && !this.store.getProject(input.projectId)) throw new Error("Unknown project");
    if (input.parentId && !this.store.getFolder(input.parentId)) throw new Error("Unknown parent folder");
    const now = new Date().toISOString();
    return this.store.createFolder({
      id: randomUUID(),
      name: requiredName(input.name),
      projectId: input.projectId,
      parentId: input.parentId,
      position: input.position ?? 0,
      createdAt: now,
      updatedAt: now,
    });
  }

  listFolders(): FolderRecord[] { return this.store.listFolders(); }

  updateFolder(id: string, patch: Partial<Pick<FolderRecord, "name" | "projectId" | "parentId" | "position">>): FolderRecord | undefined {
    return this.store.updateFolder(id, {
      ...patch,
      ...(patch.name !== undefined ? { name: requiredName(patch.name) } : {}),
      updatedAt: new Date().toISOString(),
    });
  }

  deleteFolder(id: string): boolean { return this.store.deleteFolder(id); }
}
