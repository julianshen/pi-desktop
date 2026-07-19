import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { API_BASE } from "./apiBase.js";

/** Mirrors server/src/agent/conversations.ts's ConversationMeta exactly (Task 9). */
export interface ConversationMeta {
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
  searchSnippet?: string;
}

export interface ProjectRecord { id: string; name: string; createdAt: string; updatedAt: string }
export interface FolderRecord {
  id: string; name: string; projectId?: string; parentId?: string; position: number;
  createdAt: string; updatedAt: string;
}
export interface ConversationPatch {
  title?: string; projectId?: string | null; folderId?: string | null;
  pinned?: boolean; archived?: boolean; modelId?: string | null; activeBranchId?: string;
}

export interface UseConversationsResult {
  conversations: ConversationMeta[];
  loading: boolean;
  error: Error | null;
  activeId: string | null;
  setActiveId: (id: string) => void;
  create: (input?: { title?: string; projectId?: string; folderId?: string }) => Promise<ConversationMeta>;
  update: (id: string, patch: ConversationPatch) => Promise<ConversationMeta>;
  remove: (id: string) => Promise<void>;
  projects: ProjectRecord[];
  folders: FolderRecord[];
  createProject: (name: string) => Promise<ProjectRecord>;
  createFolder: (input: { name: string; projectId?: string; parentId?: string }) => Promise<FolderRecord>;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  filtered: ConversationMeta[];
  refetch: () => Promise<void>;
}

/**
 * Task 9 (US-01, US-02, US-04): the single data-fetching hook every wired-up chat
 * chrome component depends on. Plain `fetch`, no data-fetching library — SPEC.md is
 * explicit that this feature adds none.
 */
export function useConversations(): UseConversationsResult {
  const [conversations, setConversations] = useState<ConversationMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [remoteSearchResults, setRemoteSearchResults] = useState<ConversationMeta[] | null>(null);
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [folders, setFolders] = useState<FolderRecord[]>([]);
  const searchRequestRef = useRef(0);

  const fetchConversations = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch(`${API_BASE}/api/conversations`);
      if (!res.ok) throw new Error(`GET /api/conversations failed: ${res.status}`);
      const data = (await res.json()) as ConversationMeta[];
      setConversations(data);
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchConversations();
  }, [fetchConversations]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch(`${API_BASE}/api/projects`).then((res) => res.ok ? res.json() as Promise<ProjectRecord[]> : []),
      fetch(`${API_BASE}/api/folders`).then((res) => res.ok ? res.json() as Promise<FolderRecord[]> : []),
    ]).then(([nextProjects, nextFolders]) => {
      if (cancelled) return;
      setProjects(nextProjects);
      setFolders(nextFolders);
    }).catch(() => {
      // Conversation loading remains usable when optional organization metadata fails.
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const query = searchQuery.trim();
    const requestId = ++searchRequestRef.current;
    if (!query) {
      setRemoteSearchResults(null);
      return;
    }
    fetch(`${API_BASE}/api/conversations?q=${encodeURIComponent(query)}`)
      .then((res) => {
        if (!res.ok) throw new Error(`GET /api/conversations search failed: ${res.status}`);
        return res.json() as Promise<ConversationMeta[]>;
      })
      .then((results) => {
        if (requestId === searchRequestRef.current) setRemoteSearchResults(results);
      })
      .catch(() => {
        if (requestId === searchRequestRef.current) setRemoteSearchResults(null);
      });
  }, [searchQuery]);

  // Re-fetches the list without resetting `loading` to true — used to pick up
  // server-side bookkeeping (e.g. auto-derived conversation titles, bumped
  // `updatedAt`) after a chat turn completes, mirroring how ArtifactCanvas's
  // `refreshSignal` re-fetches artifacts on the same onTurnComplete signal.
  const refetch = useCallback(async (): Promise<void> => {
    await fetchConversations();
  }, [fetchConversations]);

  const create = useCallback(async (input: { title?: string; projectId?: string; folderId?: string } = {}): Promise<ConversationMeta> => {
    const res = await fetch(`${API_BASE}/api/conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!res.ok) throw new Error(`POST /api/conversations failed: ${res.status}`);
    const created = (await res.json()) as ConversationMeta;
    setConversations((prev) => [created, ...prev]);
    setActiveId(created.id);
    return created;
  }, []);

  const update = useCallback(async (id: string, patch: ConversationPatch): Promise<ConversationMeta> => {
    const res = await fetch(`${API_BASE}/api/conversations/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error(`PATCH /api/conversations/${id} failed: ${res.status}`);
    const updated = (await res.json()) as ConversationMeta;
    setConversations((prev) => prev.map((item) => item.id === id ? updated : item));
    setRemoteSearchResults((prev) => prev?.map((item) => item.id === id ? updated : item) ?? null);
    return updated;
  }, []);

  const remove = useCallback(async (id: string): Promise<void> => {
    const res = await fetch(`${API_BASE}/api/conversations/${id}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deleteOwnedFiles: true }),
    });
    if (!res.ok) throw new Error(`DELETE /api/conversations/${id} failed: ${res.status}`);
    setConversations((prev) => {
      const next = prev.filter((item) => item.id !== id);
      setActiveId((active) => active === id ? next[0]?.id ?? "default" : active);
      return next;
    });
    setRemoteSearchResults((prev) => prev?.filter((item) => item.id !== id) ?? null);
  }, []);

  const createProject = useCallback(async (name: string): Promise<ProjectRecord> => {
    const res = await fetch(`${API_BASE}/api/projects`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }),
    });
    if (!res.ok) throw new Error(`POST /api/projects failed: ${res.status}`);
    const project = (await res.json()) as ProjectRecord;
    setProjects((prev) => [...prev, project].sort((a, b) => a.name.localeCompare(b.name)));
    return project;
  }, []);

  const createFolder = useCallback(async (input: { name: string; projectId?: string; parentId?: string }): Promise<FolderRecord> => {
    const res = await fetch(`${API_BASE}/api/folders`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
    });
    if (!res.ok) throw new Error(`POST /api/folders failed: ${res.status}`);
    const folder = (await res.json()) as FolderRecord;
    setFolders((prev) => [...prev, folder]);
    return folder;
  }, []);

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const source = remoteSearchResults ?? conversations;
    if (!q) return source;
    return source.filter((c) => c.title.toLowerCase().includes(q));
  }, [conversations, remoteSearchResults, searchQuery]);

  return {
    conversations, loading, error, activeId, setActiveId, create, update, remove,
    projects, folders, createProject, createFolder,
    searchQuery, setSearchQuery, filtered, refetch,
  };
}
