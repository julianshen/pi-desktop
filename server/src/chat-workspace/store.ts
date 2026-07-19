import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";

export interface ConversationRecord {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  modelId?: string;
  projectId?: string;
  folderId?: string;
  activeBranchId?: string;
  pinnedAt?: string;
  archivedAt?: string;
}

export interface ProjectRecord {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface FolderRecord {
  id: string;
  name: string;
  projectId?: string;
  parentId?: string;
  position: number;
  createdAt: string;
  updatedAt: string;
}

export interface AttachmentRecord {
  id: string;
  conversationId: string;
  branchId?: string;
  messageId?: string;
  localPath: string;
  displayName: string;
  mediaType: string;
  byteSize: number;
  sha256: string;
  ingestionStatus: "staged" | "ready" | "rejected" | "missing";
  providerDisposition: "local_only" | "referenced" | "sent" | "failed";
  createdAt: string;
}

export interface BranchRecord {
  id: string;
  conversationId: string;
  parentBranchId?: string;
  sourceMessageId?: string;
  baseEntryId?: string;
  leafEntryId?: string;
  replacementContent?: string;
  createdAt: string;
  updatedAt: string;
}

export type RunStatus = "queued" | "running" | "completed" | "failed" | "stopped" | "interrupted";

export interface AgentRunRecord {
  id: string;
  conversationId: string;
  branchId?: string;
  status: RunStatus;
  model?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

export interface RunEventRecord {
  id: string;
  runId: string;
  cursor: number;
  type: string;
  data: unknown;
  createdAt: string;
}

export interface PlanStepRecord {
  id: string;
  runId: string;
  position: number;
  title: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  detail?: string;
  updatedAt: string;
}

export interface ChatWorkspaceStoreOptions {
  dataDir: string;
  databasePath?: string;
  legacyPath?: string;
  skipLegacyImport?: boolean;
  /** Deterministic test seam for proving migration rollback. */
  migrationFault?: "after-first-legacy-row";
}

type ConversationRow = {
  id: string;
  title: string;
  model_id: string | null;
  project_id: string | null;
  folder_id: string | null;
  active_branch_id: string | null;
  pinned_at: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

function optional(value: string | null): string | undefined {
  return value ?? undefined;
}

function mapConversation(row: ConversationRow): ConversationRecord {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    modelId: optional(row.model_id),
    projectId: optional(row.project_id),
    folderId: optional(row.folder_id),
    activeBranchId: optional(row.active_branch_id),
    pinnedAt: optional(row.pinned_at),
    archivedAt: optional(row.archived_at),
  };
}

function parseLegacyRegistry(file: string): ConversationRecord[] {
  if (!fs.existsSync(file)) return [];
  const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(value)) throw new Error("Legacy conversation registry must be an array");

  return value.map((item, index) => {
    if (!item || typeof item !== "object") throw new Error(`Invalid legacy conversation at index ${index}`);
    const record = item as Record<string, unknown>;
    if (
      typeof record.id !== "string" ||
      typeof record.title !== "string" ||
      typeof record.createdAt !== "string" ||
      typeof record.updatedAt !== "string"
    ) {
      throw new Error(`Invalid legacy conversation at index ${index}`);
    }
    return {
      id: record.id,
      title: record.title,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      modelId: typeof record.modelId === "string" ? record.modelId : undefined,
    };
  });
}

export class ChatWorkspaceStore {
  readonly databasePath: string;
  private readonly db: Database;

  constructor(options: ChatWorkspaceStoreOptions) {
    this.databasePath = options.databasePath ?? path.join(options.dataDir, "chat-workspace.sqlite3");
    const legacyPath = options.legacyPath ?? path.join(options.dataDir, "conversations", "index.json");
    fs.mkdirSync(path.dirname(this.databasePath), { recursive: true });
    this.db = new Database(this.databasePath, { create: true, strict: true });
    this.db.run("PRAGMA foreign_keys = ON");
    this.db.run("PRAGMA journal_mode = WAL");

    try {
      this.migrate(options.skipLegacyImport ? [] : parseLegacyRegistry(legacyPath), options.migrationFault);
    } catch (error) {
      this.db.close(false);
      throw error;
    }
  }

  private migrate(entries: ConversationRecord[], fault?: ChatWorkspaceStoreOptions["migrationFault"]): void {
    this.db.transaction(() => {
      this.db.run(`
        CREATE TABLE IF NOT EXISTS schema_migrations(
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL
        )
      `);
      this.db.run(`
        CREATE TABLE IF NOT EXISTS projects(
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `);
      this.db.run(`
        CREATE TABLE IF NOT EXISTS folders(
          id TEXT PRIMARY KEY,
          project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
          parent_id TEXT REFERENCES folders(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          position INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `);
      this.db.run(`
        CREATE TABLE IF NOT EXISTS conversations(
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          model_id TEXT,
          project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
          folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
          active_branch_id TEXT,
          pinned_at TEXT,
          archived_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `);
      this.db.run(`
        CREATE TABLE IF NOT EXISTS attachments(
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          branch_id TEXT,
          message_id TEXT,
          local_path TEXT NOT NULL,
          display_name TEXT NOT NULL,
          media_type TEXT NOT NULL,
          byte_size INTEGER NOT NULL,
          sha256 TEXT NOT NULL,
          ingestion_status TEXT NOT NULL,
          provider_disposition TEXT NOT NULL,
          created_at TEXT NOT NULL
        )
      `);
      const attachmentColumns = this.db.query<{ name: string }, []>("PRAGMA table_info(attachments)").all();
      if (!attachmentColumns.some((column) => column.name === "branch_id")) {
        this.db.run("ALTER TABLE attachments ADD COLUMN branch_id TEXT");
      }
      this.db.run(`
        CREATE TABLE IF NOT EXISTS conversation_branches(
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          parent_branch_id TEXT REFERENCES conversation_branches(id) ON DELETE SET NULL,
          source_message_id TEXT,
          base_entry_id TEXT,
          leaf_entry_id TEXT,
          replacement_content TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `);
      this.db.run("CREATE INDEX IF NOT EXISTS branches_conversation_idx ON conversation_branches(conversation_id, created_at)");
      this.db.run(`
        CREATE TABLE IF NOT EXISTS agent_runs(
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          branch_id TEXT REFERENCES conversation_branches(id) ON DELETE SET NULL,
          status TEXT NOT NULL,
          model TEXT,
          created_at TEXT NOT NULL,
          started_at TEXT,
          completed_at TEXT,
          error TEXT
        )
      `);
      this.db.run(`
        CREATE TABLE IF NOT EXISTS run_events(
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
          cursor INTEGER NOT NULL,
          type TEXT NOT NULL,
          data_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE(run_id, cursor)
        )
      `);
      this.db.run(`
        CREATE TABLE IF NOT EXISTS plan_steps(
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
          position INTEGER NOT NULL,
          title TEXT NOT NULL,
          status TEXT NOT NULL,
          detail TEXT,
          updated_at TEXT NOT NULL,
          UNIQUE(run_id, position)
        )
      `);
      this.db.run("CREATE INDEX IF NOT EXISTS runs_conversation_idx ON agent_runs(conversation_id, created_at DESC)");
      this.db.run("CREATE INDEX IF NOT EXISTS run_events_cursor_idx ON run_events(run_id, cursor)");
      this.db.run("CREATE INDEX IF NOT EXISTS attachments_conversation_idx ON attachments(conversation_id, created_at)");
      this.db.run("CREATE INDEX IF NOT EXISTS conversations_updated_idx ON conversations(updated_at DESC)");

      const alreadyApplied = this.db
        .query<{ version: number }, [number]>("SELECT version FROM schema_migrations WHERE version = ?")
        .get(1);
      if (alreadyApplied) return;

      const insert = this.db.query<unknown, [string, string, string | null, string, string]>(`
        INSERT OR IGNORE INTO conversations(id, title, model_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      entries.forEach((entry, index) => {
        insert.run(entry.id, entry.title, entry.modelId ?? null, entry.createdAt, entry.updatedAt);
        if (index === 0 && fault === "after-first-legacy-row") throw new Error("Forced migration failure");
      });
      this.db
        .query<unknown, [number, string]>("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
        .run(1, new Date().toISOString());
    })();
  }

  listConversations(): ConversationRecord[] {
    return this.db
      .query<ConversationRow, []>("SELECT * FROM conversations ORDER BY updated_at DESC, id ASC")
      .all()
      .map(mapConversation);
  }

  getConversation(id: string): ConversationRecord | undefined {
    const row = this.db.query<ConversationRow, [string]>("SELECT * FROM conversations WHERE id = ?").get(id);
    return row ? mapConversation(row) : undefined;
  }

  createConversation(record: ConversationRecord): ConversationRecord {
    this.db
      .query<unknown, [string, string, string | null, string | null, string | null, string | null, string | null, string | null, string, string]>(`
        INSERT INTO conversations(
          id, title, model_id, project_id, folder_id, active_branch_id,
          pinned_at, archived_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        record.id,
        record.title,
        record.modelId ?? null,
        record.projectId ?? null,
        record.folderId ?? null,
        record.activeBranchId ?? null,
        record.pinnedAt ?? null,
        record.archivedAt ?? null,
        record.createdAt,
        record.updatedAt,
      );
    return record;
  }

  ensureConversation(record: ConversationRecord): ConversationRecord {
    return this.getConversation(record.id) ?? this.createConversation(record);
  }

  updateConversation(
    id: string,
    patch: Partial<Omit<ConversationRecord, "id" | "createdAt">>,
  ): ConversationRecord | undefined {
    const existing = this.getConversation(id);
    if (!existing) return undefined;
    const updated = { ...existing, ...patch };
    this.db
      .query<unknown, [string, string | null, string | null, string | null, string | null, string | null, string | null, string, string]>(`
        UPDATE conversations SET
          title = ?, model_id = ?, project_id = ?, folder_id = ?, active_branch_id = ?,
          pinned_at = ?, archived_at = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(
        updated.title,
        updated.modelId ?? null,
        updated.projectId ?? null,
        updated.folderId ?? null,
        updated.activeBranchId ?? null,
        updated.pinnedAt ?? null,
        updated.archivedAt ?? null,
        updated.updatedAt,
        id,
      );
    return updated;
  }

  deleteConversation(id: string): boolean {
    return this.db.query<unknown, [string]>("DELETE FROM conversations WHERE id = ?").run(id).changes > 0;
  }

  createProject(record: ProjectRecord): ProjectRecord {
    this.db
      .query<unknown, [string, string, string, string]>(
        "INSERT INTO projects(id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
      )
      .run(record.id, record.name, record.createdAt, record.updatedAt);
    return record;
  }

  listProjects(): ProjectRecord[] {
    return this.db
      .query<{ id: string; name: string; created_at: string; updated_at: string }, []>(
        "SELECT * FROM projects ORDER BY name COLLATE NOCASE, id",
      )
      .all()
      .map((row) => ({ id: row.id, name: row.name, createdAt: row.created_at, updatedAt: row.updated_at }));
  }

  getProject(id: string): ProjectRecord | undefined {
    const row = this.db
      .query<{ id: string; name: string; created_at: string; updated_at: string }, [string]>(
        "SELECT * FROM projects WHERE id = ?",
      )
      .get(id);
    return row ? { id: row.id, name: row.name, createdAt: row.created_at, updatedAt: row.updated_at } : undefined;
  }

  updateProject(id: string, name: string, updatedAt: string): ProjectRecord | undefined {
    this.db.query<unknown, [string, string, string]>("UPDATE projects SET name = ?, updated_at = ? WHERE id = ?").run(name, updatedAt, id);
    return this.getProject(id);
  }

  deleteProject(id: string): boolean {
    return this.db.query<unknown, [string]>("DELETE FROM projects WHERE id = ?").run(id).changes > 0;
  }

  createFolder(record: FolderRecord): FolderRecord {
    this.db
      .query<unknown, [string, string | null, string | null, string, number, string, string]>(`
        INSERT INTO folders(id, project_id, parent_id, name, position, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        record.id,
        record.projectId ?? null,
        record.parentId ?? null,
        record.name,
        record.position,
        record.createdAt,
        record.updatedAt,
      );
    return record;
  }

  listFolders(): FolderRecord[] {
    return this.db
      .query<{
        id: string; project_id: string | null; parent_id: string | null; name: string;
        position: number; created_at: string; updated_at: string;
      }, []>("SELECT * FROM folders ORDER BY position, name COLLATE NOCASE, id")
      .all()
      .map((row) => ({
        id: row.id,
        name: row.name,
        projectId: optional(row.project_id),
        parentId: optional(row.parent_id),
        position: row.position,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
  }

  getFolder(id: string): FolderRecord | undefined {
    return this.listFolders().find((folder) => folder.id === id);
  }

  updateFolder(
    id: string,
    patch: Partial<Pick<FolderRecord, "name" | "projectId" | "parentId" | "position">> & { updatedAt: string },
  ): FolderRecord | undefined {
    const existing = this.getFolder(id);
    if (!existing) return undefined;
    const updated = { ...existing, ...patch };
    this.db
      .query<unknown, [string, string | null, string | null, number, string, string]>(`
        UPDATE folders SET name = ?, project_id = ?, parent_id = ?, position = ?, updated_at = ? WHERE id = ?
      `)
      .run(updated.name, updated.projectId ?? null, updated.parentId ?? null, updated.position, updated.updatedAt, id);
    return updated;
  }

  deleteFolder(id: string): boolean {
    return this.db.query<unknown, [string]>("DELETE FROM folders WHERE id = ?").run(id).changes > 0;
  }

  createAttachment(record: AttachmentRecord): AttachmentRecord {
    this.db
      .query<unknown, [string, string, string | null, string | null, string, string, string, number, string, string, string, string]>(`
        INSERT INTO attachments(
          id, conversation_id, branch_id, message_id, local_path, display_name, media_type,
          byte_size, sha256, ingestion_status, provider_disposition, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        record.id, record.conversationId, record.branchId ?? null, record.messageId ?? null, record.localPath,
        record.displayName, record.mediaType, record.byteSize, record.sha256,
        record.ingestionStatus, record.providerDisposition, record.createdAt,
      );
    return record;
  }

  listAttachments(conversationId: string): AttachmentRecord[] {
    return this.db
      .query<{
        id: string; conversation_id: string; branch_id: string | null; message_id: string | null; local_path: string;
        display_name: string; media_type: string; byte_size: number; sha256: string;
        ingestion_status: AttachmentRecord["ingestionStatus"];
        provider_disposition: AttachmentRecord["providerDisposition"]; created_at: string;
      }, [string]>("SELECT * FROM attachments WHERE conversation_id = ? ORDER BY created_at, id")
      .all(conversationId)
      .map((row) => ({
        id: row.id, conversationId: row.conversation_id, branchId: optional(row.branch_id), messageId: optional(row.message_id),
        localPath: row.local_path, displayName: row.display_name, mediaType: row.media_type,
        byteSize: row.byte_size, sha256: row.sha256, ingestionStatus: row.ingestion_status,
        providerDisposition: row.provider_disposition, createdAt: row.created_at,
      }));
  }

  getAttachment(conversationId: string, id: string): AttachmentRecord | undefined {
    return this.listAttachments(conversationId).find((record) => record.id === id);
  }

  setAttachmentDisposition(
    conversationId: string,
    id: string,
    disposition: AttachmentRecord["providerDisposition"],
  ): AttachmentRecord | undefined {
    this.db
      .query<unknown, [string, string, string]>(
        "UPDATE attachments SET provider_disposition = ? WHERE conversation_id = ? AND id = ?",
      )
      .run(disposition, conversationId, id);
    return this.getAttachment(conversationId, id);
  }

  deleteAttachment(conversationId: string, id: string): AttachmentRecord | undefined {
    const existing = this.getAttachment(conversationId, id);
    if (!existing) return undefined;
    this.db.query<unknown, [string, string]>("DELETE FROM attachments WHERE conversation_id = ? AND id = ?").run(conversationId, id);
    return existing;
  }

  createBranch(record: BranchRecord): BranchRecord {
    this.db.query<unknown, [string, string, string | null, string | null, string | null, string | null, string | null, string, string]>(`
      INSERT INTO conversation_branches(
        id, conversation_id, parent_branch_id, source_message_id, base_entry_id,
        leaf_entry_id, replacement_content, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id, record.conversationId, record.parentBranchId ?? null,
      record.sourceMessageId ?? null, record.baseEntryId ?? null,
      record.leafEntryId ?? null, record.replacementContent ?? null,
      record.createdAt, record.updatedAt,
    );
    return record;
  }

  listBranches(conversationId: string): BranchRecord[] {
    return this.db.query<{
      id: string; conversation_id: string; parent_branch_id: string | null;
      source_message_id: string | null; base_entry_id: string | null; leaf_entry_id: string | null;
      replacement_content: string | null; created_at: string; updated_at: string;
    }, [string]>("SELECT * FROM conversation_branches WHERE conversation_id = ? ORDER BY created_at, id")
      .all(conversationId)
      .map((row) => ({
        id: row.id,
        conversationId: row.conversation_id,
        parentBranchId: optional(row.parent_branch_id),
        sourceMessageId: optional(row.source_message_id),
        baseEntryId: optional(row.base_entry_id),
        leafEntryId: optional(row.leaf_entry_id),
        replacementContent: optional(row.replacement_content),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
  }

  getBranch(conversationId: string, id: string): BranchRecord | undefined {
    return this.listBranches(conversationId).find((branch) => branch.id === id);
  }

  updateBranch(
    conversationId: string,
    id: string,
    patch: Partial<Pick<BranchRecord, "leafEntryId" | "replacementContent" | "updatedAt">>,
  ): BranchRecord | undefined {
    const existing = this.getBranch(conversationId, id);
    if (!existing) return undefined;
    const updated = { ...existing, ...patch };
    this.db.query<unknown, [string | null, string | null, string, string, string]>(`
      UPDATE conversation_branches SET leaf_entry_id = ?, replacement_content = ?, updated_at = ?
      WHERE conversation_id = ? AND id = ?
    `).run(updated.leafEntryId ?? null, updated.replacementContent ?? null, updated.updatedAt, conversationId, id);
    return updated;
  }

  createRun(record: AgentRunRecord): AgentRunRecord {
    this.db.query<unknown, [string, string, string | null, string, string | null, string, string | null, string | null, string | null]>(`
      INSERT INTO agent_runs(id, conversation_id, branch_id, status, model, created_at, started_at, completed_at, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(record.id, record.conversationId, record.branchId ?? null, record.status, record.model ?? null,
      record.createdAt, record.startedAt ?? null, record.completedAt ?? null, record.error ?? null);
    return record;
  }

  getRun(id: string): AgentRunRecord | undefined {
    const row = this.db.query<{
      id: string; conversation_id: string; branch_id: string | null; status: RunStatus; model: string | null;
      created_at: string; started_at: string | null; completed_at: string | null; error: string | null;
    }, [string]>("SELECT * FROM agent_runs WHERE id = ?").get(id);
    return row ? {
      id: row.id, conversationId: row.conversation_id, branchId: optional(row.branch_id), status: row.status,
      model: optional(row.model), createdAt: row.created_at, startedAt: optional(row.started_at),
      completedAt: optional(row.completed_at), error: optional(row.error),
    } : undefined;
  }

  listRuns(conversationId: string): AgentRunRecord[] {
    return this.db.query<{ id: string }, [string]>("SELECT id FROM agent_runs WHERE conversation_id = ? ORDER BY created_at DESC, id").all(conversationId)
      .map((row) => this.getRun(row.id)!).filter(Boolean);
  }

  appendRunEvent(runId: string, id: string, type: string, data: unknown, createdAt: string): RunEventRecord {
    return this.db.transaction(() => {
      if (!this.getRun(runId)) throw new Error("Run not found");
      const row = this.db.query<{ cursor: number }, [string]>("SELECT COALESCE(MAX(cursor), 0) + 1 AS cursor FROM run_events WHERE run_id = ?").get(runId)!;
      this.db.query<unknown, [string, string, number, string, string, string]>(`
        INSERT INTO run_events(id, run_id, cursor, type, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?)
      `).run(id, runId, row.cursor, type, JSON.stringify(data ?? null), createdAt);
      return { id, runId, cursor: row.cursor, type, data, createdAt };
    })();
  }

  listRunEvents(runId: string, after = 0): RunEventRecord[] {
    return this.db.query<{ id: string; run_id: string; cursor: number; type: string; data_json: string; created_at: string }, [string, number]>(`
      SELECT * FROM run_events WHERE run_id = ? AND cursor > ? ORDER BY cursor
    `).all(runId, after).map((row) => ({
      id: row.id, runId: row.run_id, cursor: row.cursor, type: row.type,
      data: JSON.parse(row.data_json) as unknown, createdAt: row.created_at,
    }));
  }

  transitionRunTerminal(id: string, status: Extract<RunStatus, "completed" | "failed" | "stopped" | "interrupted">, error?: string): AgentRunRecord | undefined {
    const completedAt = new Date().toISOString();
    const changed = this.db.query<unknown, [RunStatus, string, string | null, string]>(`
      UPDATE agent_runs SET status = ?, completed_at = ?, error = ?
      WHERE id = ? AND status IN ('queued', 'running')
    `).run(status, completedAt, error ?? null, id).changes;
    return changed > 0 ? this.getRun(id) : undefined;
  }

  finishRunWithEvent(
    id: string,
    status: Extract<RunStatus, "completed" | "failed" | "stopped" | "interrupted">,
    event: { id: string; type: string; data: unknown; createdAt: string },
    error?: string,
  ): { run: AgentRunRecord; event: RunEventRecord } | undefined {
    return this.db.transaction(() => {
      const changed = this.db.query<unknown, [RunStatus, string, string | null, string]>(`
        UPDATE agent_runs SET status = ?, completed_at = ?, error = ?
        WHERE id = ? AND status IN ('queued', 'running')
      `).run(status, event.createdAt, error ?? null, id).changes;
      if (changed === 0) return undefined;
      const cursor = this.db.query<{ cursor: number }, [string]>("SELECT COALESCE(MAX(cursor), 0) + 1 AS cursor FROM run_events WHERE run_id = ?").get(id)!.cursor;
      this.db.query<unknown, [string, string, number, string, string, string]>(`
        INSERT INTO run_events(id, run_id, cursor, type, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?)
      `).run(event.id, id, cursor, event.type, JSON.stringify(event.data ?? null), event.createdAt);
      return {
        run: this.getRun(id)!,
        event: { id: event.id, runId: id, cursor, type: event.type, data: event.data, createdAt: event.createdAt },
      };
    })();
  }

  interruptActiveRuns(): AgentRunRecord[] {
    const active = this.db.query<{ id: string }, []>("SELECT id FROM agent_runs WHERE status IN ('queued', 'running')").all();
    return active.map(({ id }) => this.finishRunWithEvent(id, "interrupted", {
      id: randomUUID(), type: "run_interrupted", data: { reason: "process_restart" }, createdAt: new Date().toISOString(),
    })?.run).filter((run): run is AgentRunRecord => !!run);
  }

  listPlanSteps(runId: string): PlanStepRecord[] {
    return this.db.query<{
      id: string; run_id: string; position: number; title: string;
      status: PlanStepRecord["status"]; detail: string | null; updated_at: string;
    }, [string]>("SELECT * FROM plan_steps WHERE run_id = ? ORDER BY position").all(runId).map((row) => ({
      id: row.id, runId: row.run_id, position: row.position, title: row.title,
      status: row.status, detail: optional(row.detail), updatedAt: row.updated_at,
    }));
  }

  replacePlanWithEvent(
    runId: string,
    steps: Array<{ id: string; text: string; status: PlanStepRecord["status"] }>,
    event: { id: string; type: string; data: unknown; createdAt: string },
  ): { steps: PlanStepRecord[]; event: RunEventRecord } {
    return this.db.transaction(() => {
      this.db.query("DELETE FROM plan_steps WHERE run_id = ?").run(runId);
      const insert = this.db.query<unknown, [string, string, number, string, string, string]>(`
        INSERT INTO plan_steps(id, run_id, position, title, status, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      `);
      steps.forEach((step, position) => insert.run(step.id, runId, position, step.text, step.status, event.createdAt));
      const cursor = this.db.query<{ cursor: number }, [string]>("SELECT COALESCE(MAX(cursor), 0) + 1 AS cursor FROM run_events WHERE run_id = ?").get(runId)!.cursor;
      this.db.query<unknown, [string, string, number, string, string, string]>(`
        INSERT INTO run_events(id, run_id, cursor, type, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?)
      `).run(event.id, runId, cursor, event.type, JSON.stringify(event.data), event.createdAt);
      return {
        steps: this.listPlanSteps(runId),
        event: { id: event.id, runId, cursor, type: event.type, data: event.data, createdAt: event.createdAt },
      };
    })();
  }

  migrationVersions(): number[] {
    return this.db
      .query<{ version: number }, []>("SELECT version FROM schema_migrations ORDER BY version")
      .all()
      .map((row) => row.version);
  }

  close(): void {
    this.db.close(false);
  }
}
