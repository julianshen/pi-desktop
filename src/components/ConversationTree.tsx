import { useState } from "react";
import type {
  ConversationMeta,
  FolderRecord,
  ProjectRecord,
  UseConversationsResult,
} from "../state/useConversations.js";

interface ConversationRowProps {
  conversation: ConversationMeta;
  active: boolean;
  projects: ProjectRecord[];
  folders: FolderRecord[];
  workspace: UseConversationsResult;
  onSelect: (id: string) => void;
}

function ConversationRow({ conversation, active, projects, folders, workspace, onSelect }: ConversationRowProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(conversation.title);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);

  async function mutate(action: () => Promise<unknown>) {
    setBusy(true);
    try {
      await action();
      setMenuOpen(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div role="treeitem" aria-selected={active} aria-label={conversation.title} style={{ margin: "1px 0" }}>
      <div style={{ display: "flex", alignItems: "center", border: `1px solid ${active ? "var(--color-divider)" : "transparent"}`, background: active ? "var(--color-accent-100)" : "transparent" }}>
        <button
          onClick={() => onSelect(conversation.id)}
          style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 7, padding: "7px 6px", border: 0, background: "transparent", color: "var(--color-text)", textAlign: "left", cursor: "pointer" }}
        >
          <span aria-hidden="true" style={{ width: 6, height: 6, flex: "none", borderRadius: "50%", background: active ? "var(--color-accent)" : "color-mix(in srgb, var(--color-text) 22%, transparent)" }} />
          <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 13 }}>{conversation.title}</span>
          {conversation.pinnedAt && <span style={{ fontSize: 10, color: "var(--color-accent-700)" }}>Pinned</span>}
        </button>
        <button
          aria-label={`Actions for ${conversation.title}`}
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
          style={{ width: 30, height: 30, border: 0, background: "transparent", color: "var(--color-text)", cursor: "pointer" }}
        >
          ···
        </button>
      </div>

      {menuOpen && (
        <div role="menu" aria-label={`Conversation actions for ${conversation.title}`} style={{ margin: "2px 0 4px 13px", padding: 6, border: "1px solid var(--color-divider)", background: "var(--color-surface)", display: "grid", gap: 4 }}>
          {renaming ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (!title.trim()) return;
                void mutate(() => workspace.update(conversation.id, { title: title.trim() })).then(() => setRenaming(false));
              }}
              style={{ display: "flex", gap: 4 }}
            >
              <input aria-label={`New title for ${conversation.title}`} value={title} onChange={(event) => setTitle(event.target.value)} autoFocus style={{ minWidth: 0, flex: 1 }} />
              <button type="submit" disabled={busy}>Save</button>
            </form>
          ) : (
            <button role="menuitem" onClick={() => setRenaming(true)}>Rename {conversation.title}</button>
          )}
          <button role="menuitem" disabled={busy} aria-label={`${conversation.pinnedAt ? "Unpin" : "Pin"} ${conversation.title}`} onClick={() => void mutate(() => workspace.update(conversation.id, { pinned: !conversation.pinnedAt }))}>
            {conversation.pinnedAt ? "Unpin" : "Pin"}
          </button>
          <button role="menuitem" disabled={busy} onClick={() => void mutate(() => workspace.update(conversation.id, { archived: !conversation.archivedAt }))}>
            {conversation.archivedAt ? "Restore" : "Archive"}
          </button>
          <label style={{ display: "grid", gap: 2, fontSize: 11 }}>
            Move
            <select
              aria-label={`Move ${conversation.title}`}
              value={conversation.folderId ? `folder:${conversation.folderId}` : conversation.projectId ? `project:${conversation.projectId}` : ""}
              onChange={(event) => {
                const [kind, id] = event.target.value.split(":");
                void mutate(() => workspace.update(conversation.id, {
                  projectId: kind === "project" || kind === "folder" ? (kind === "folder" ? folders.find((folder) => folder.id === id)?.projectId ?? null : id) : null,
                  folderId: kind === "folder" ? id : null,
                }));
              }}
            >
              <option value="">Unfiled</option>
              {projects.map((project) => <option key={project.id} value={`project:${project.id}`}>{project.name}</option>)}
              {folders.map((folder) => <option key={folder.id} value={`folder:${folder.id}`}>↳ {folder.name}</option>)}
            </select>
          </label>
          {confirmDelete ? (
            <div role="alert" style={{ display: "grid", gap: 4 }}>
              <span>Delete this conversation and its app-owned files?</span>
              <div style={{ display: "flex", gap: 4 }}>
                <button disabled={busy} onClick={() => void mutate(async () => {
                  const replacementId = await workspace.remove(conversation.id);
                  if (active) onSelect(replacementId);
                })}>Confirm delete</button>
                <button onClick={() => setConfirmDelete(false)}>Cancel</button>
              </div>
            </div>
          ) : (
            <button role="menuitem" onClick={() => setConfirmDelete(true)}>Delete</button>
          )}
        </div>
      )}
    </div>
  );
}

export function ConversationTree({
  items,
  projects,
  folders,
  activeId,
  workspace,
  onSelect,
}: {
  items: ConversationMeta[];
  projects: ProjectRecord[];
  folders: FolderRecord[];
  activeId: string;
  workspace: UseConversationsResult;
  onSelect: (id: string) => void;
}) {
  const renderRows = (rows: ConversationMeta[]) => rows.map((conversation) => (
    <ConversationRow
      key={conversation.id}
      conversation={conversation}
      active={conversation.id === activeId}
      projects={projects}
      folders={folders}
      workspace={workspace}
      onSelect={onSelect}
    />
  ));
  const unfiled = items.filter((item) => !item.projectId);

  return (
    <div role="tree" aria-label="Conversation workspace">
      {projects.map((project) => {
        const projectFolders = folders.filter((folder) => folder.projectId === project.id && !folder.parentId);
        const projectRoot = items.filter((item) => item.projectId === project.id && !item.folderId);
        const hasContent = projectRoot.length > 0 || projectFolders.some((folder) => items.some((item) => item.folderId === folder.id));
        if (!hasContent) return null;
        return (
          <div key={project.id} role="treeitem" aria-expanded="true" aria-label={project.name}>
            <div style={{ padding: "10px 6px 4px", fontFamily: "var(--font-heading)", fontSize: 11, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase" }}>{project.name}</div>
            <div role="group" style={{ paddingLeft: 6 }}>
              {renderRows(projectRoot)}
              {projectFolders.map((folder) => {
                const rows = items.filter((item) => item.folderId === folder.id);
                if (rows.length === 0) return null;
                return (
                  <div key={folder.id} role="treeitem" aria-expanded="true" aria-label={folder.name}>
                    <div style={{ padding: "7px 6px 3px", fontSize: 11, color: "color-mix(in srgb, var(--color-text) 62%, transparent)" }}>{folder.name}</div>
                    <div role="group" style={{ paddingLeft: 6 }}>{renderRows(rows)}</div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
      {unfiled.length > 0 && (
        <div role="treeitem" aria-expanded="true" aria-label="Unfiled">
          <div style={{ padding: "10px 6px 4px", fontFamily: "var(--font-heading)", fontSize: 11, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase" }}>Unfiled</div>
          <div role="group">{renderRows(unfiled)}</div>
        </div>
      )}
    </div>
  );
}
