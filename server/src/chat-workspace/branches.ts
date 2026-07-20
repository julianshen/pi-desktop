import { randomUUID } from "node:crypto";
import { ChatWorkspaceStore, type BranchRecord } from "./store.js";

interface SessionEntryLike {
  type: string;
  id: string;
  parentId: string | null;
  message?: { role: string; content?: unknown };
}

export interface BranchSession {
  getLeafId(): string | null;
  getEntry(id: string): SessionEntryLike | undefined;
  getBranch(fromId?: string): SessionEntryLike[];
  branch(fromId: string): void;
  resetLeaf(): void;
  navigateTree?(targetId: string): Promise<{ cancelled: boolean }>;
  appendMessage(message: { role: "user"; content: string; timestamp: number }): string;
}

const mutexes = new Map<string, Promise<void>>();

async function exclusive<T>(key: string, operation: () => Promise<T> | T): Promise<T> {
  const previous = mutexes.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => current);
  mutexes.set(key, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (mutexes.get(key) === tail) mutexes.delete(key);
  }
}

function isUserEntry(entry: SessionEntryLike | undefined): entry is SessionEntryLike & { message: { role: "user"; content?: unknown } } {
  return entry?.type === "message" && entry.message?.role === "user";
}

export interface BranchMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  content: unknown;
  pending?: boolean;
}

function entryMessage(entry: SessionEntryLike): BranchMessage | undefined {
  if (entry.type !== "message" || !entry.message) return undefined;
  const message = entry.message;
  if (message.role === "user" || message.role === "assistant") {
    return { id: entry.id, role: message.role, content: message.content };
  }
  if (message.role === "toolResult") {
    return { id: entry.id, role: "tool", content: message.content };
  }
  return undefined;
}

export class BranchWorkspace {
  constructor(private readonly store: ChatWorkspaceStore) {}

  ensureRoot(conversationId: string, session: BranchSession): BranchRecord {
    const existing = this.store.listBranches(conversationId)[0];
    if (existing) return existing;
    const now = new Date().toISOString();
    const root = this.store.createBranch({
      id: randomUUID(), conversationId, leafEntryId: session.getLeafId() ?? undefined,
      createdAt: now, updatedAt: now,
    });
    this.store.updateConversation(conversationId, { activeBranchId: root.id, updatedAt: now });
    return root;
  }

  list(conversationId: string, session: BranchSession): BranchRecord[] {
    this.ensureRoot(conversationId, session);
    return this.store.listBranches(conversationId);
  }

  async create(
    conversationId: string,
    input: { sourceMessageId: string; replacementContent: string },
    session: BranchSession,
  ): Promise<BranchRecord> {
    return exclusive(conversationId, async () => {
      if (!input.replacementContent.trim()) throw new Error("replacementContent is required");
      const source = session.getEntry(input.sourceMessageId);
      if (!isUserEntry(source)) throw new Error("sourceMessageId must identify a user message");
      const root = this.ensureRoot(conversationId, session);
      const conversation = this.store.getConversation(conversationId);
      const parentId = conversation?.activeBranchId ?? root.id;
      const now = new Date().toISOString();
      this.store.updateBranch(conversationId, parentId, { leafEntryId: session.getLeafId() ?? undefined, updatedAt: now });

      if (session.navigateTree) {
        if (source.parentId === null) {
          session.resetLeaf();
        } else {
          const navigation = await session.navigateTree(source.parentId);
          if (navigation.cancelled) throw new Error("Branch navigation was cancelled");
        }
      } else if (source.parentId === null) session.resetLeaf();
      else session.branch(source.parentId);

      const branch = this.store.createBranch({
        id: randomUUID(), conversationId, parentBranchId: parentId,
        sourceMessageId: source.id, baseEntryId: source.parentId ?? undefined,
        leafEntryId: session.getLeafId() ?? undefined,
        replacementContent: input.replacementContent.trim(), createdAt: now, updatedAt: now,
      });
      this.store.updateConversation(conversationId, { activeBranchId: branch.id, updatedAt: now });
      return branch;
    });
  }

  async select(conversationId: string, branchId: string, session: BranchSession): Promise<BranchRecord> {
    return exclusive(conversationId, async () => {
      const target = this.store.getBranch(conversationId, branchId);
      if (!target) throw new Error("Branch not found");
      const conversation = this.store.getConversation(conversationId);
      const now = new Date().toISOString();
      if (conversation?.activeBranchId) {
        this.store.updateBranch(conversationId, conversation.activeBranchId, {
          leafEntryId: session.getLeafId() ?? undefined,
          updatedAt: now,
        });
      }
      if (target.leafEntryId && session.navigateTree) {
        const navigation = await session.navigateTree(target.leafEntryId);
        if (navigation.cancelled) throw new Error("Branch navigation was cancelled");
      } else if (target.leafEntryId) session.branch(target.leafEntryId);
      else session.resetLeaf();
      this.store.updateConversation(conversationId, { activeBranchId: branchId, updatedAt: now });
      return target;
    });
  }

  async materializePendingReplacement(
    conversationId: string,
    branchId: string,
    session: Pick<BranchSession, "appendMessage" | "getLeafId">,
  ): Promise<string | undefined> {
    return exclusive(conversationId, () => {
      const branch = this.store.getBranch(conversationId, branchId);
      if (!branch) throw new Error("Branch not found");
      if (!branch.replacementContent) return undefined;
      const entryId = session.appendMessage({
        role: "user",
        content: branch.replacementContent,
        timestamp: Date.now(),
      });
      this.store.updateBranch(conversationId, branchId, {
        leafEntryId: session.getLeafId() ?? entryId,
        replacementContent: undefined,
        updatedAt: new Date().toISOString(),
      });
      return entryId;
    });
  }

  messages(conversationId: string, branchId: string, session: BranchSession): BranchMessage[] {
    const branch = this.store.getBranch(conversationId, branchId);
    if (!branch) throw new Error("Branch not found");
    const entries = branch.leafEntryId ? session.getBranch(branch.leafEntryId) : [];
    const messages = entries.map(entryMessage).filter((message): message is BranchMessage => !!message);
    if (branch.replacementContent) {
      messages.push({ id: `pending-${branch.id}`, role: "user", content: branch.replacementContent, pending: true });
    }
    return messages;
  }

  commitLeaf(conversationId: string, branchId: string, leafEntryId: string | undefined): BranchRecord | undefined {
    return this.store.updateBranch(conversationId, branchId, {
      leafEntryId,
      replacementContent: undefined,
      updatedAt: new Date().toISOString(),
    });
  }
}
