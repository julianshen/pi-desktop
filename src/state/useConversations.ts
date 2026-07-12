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

  useEffect(() => {
    let cancelled = false;

    fetch(`${API_BASE}/api/conversations`)
      .then((res) => {
        if (!res.ok) throw new Error(`GET /api/conversations failed: ${res.status}`);
        return res.json() as Promise<ConversationMeta[]>;
      })
      .then((data) => {
        if (cancelled) return;
        setConversations(data);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

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

  return { conversations, loading, error, activeId, setActiveId, create, searchQuery, setSearchQuery, filtered };
}
