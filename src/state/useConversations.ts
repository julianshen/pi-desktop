import { useCallback, useEffect, useMemo, useState } from "react";
import { API_BASE } from "./apiBase.js";

/** Mirrors server/src/agent/conversations.ts's ConversationMeta exactly (Task 9). */
export interface ConversationMeta {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  modelId?: string;
}

export interface UseConversationsResult {
  conversations: ConversationMeta[];
  loading: boolean;
  error: Error | null;
  activeId: string | null;
  setActiveId: (id: string) => void;
  create: () => Promise<ConversationMeta>;
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

  // Re-fetches the list without resetting `loading` to true — used to pick up
  // server-side bookkeeping (e.g. auto-derived conversation titles, bumped
  // `updatedAt`) after a chat turn completes, mirroring how ArtifactCanvas's
  // `refreshSignal` re-fetches artifacts on the same onTurnComplete signal.
  const refetch = useCallback(async (): Promise<void> => {
    await fetchConversations();
  }, [fetchConversations]);

  const create = useCallback(async (): Promise<ConversationMeta> => {
    const res = await fetch(`${API_BASE}/api/conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (!res.ok) throw new Error(`POST /api/conversations failed: ${res.status}`);
    const created = (await res.json()) as ConversationMeta;
    setConversations((prev) => [created, ...prev]);
    setActiveId(created.id);
    return created;
  }, []);

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return conversations;
    return conversations.filter((c) => c.title.toLowerCase().includes(q));
  }, [conversations, searchQuery]);

  return { conversations, loading, error, activeId, setActiveId, create, searchQuery, setSearchQuery, filtered, refetch };
}
