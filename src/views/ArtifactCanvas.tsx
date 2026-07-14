import { useCallback, useEffect, useRef, useState } from "react";
import { CloseIcon } from "../components/icons";
import type { CanvasTab } from "../state/useShellState";
import { API_BASE } from "../state/apiBase.js";

/** Mirrors server/src/artifacts/store.ts's Artifact exactly (Task 13). */
export interface Artifact {
  id: string;
  title: string;
  language: string;
  code: string;
  publishedAt: string;
}

type Status = "loading" | "empty" | "populated" | "updating";

/**
 * Real usage (checked against ~/.pi-desktop/data/conversations/*\/artifacts.json
 * from live testing) only ever produces two rich-previewable languages: standalone
 * HTML documents (charts/animations built with inline <style>/<script>, e.g. the
 * canvas-based typhoon visualizations) and standalone SVG markup (static/animated
 * diagrams). Everything else (source snippets, "text", etc.) has no meaningful
 * visual rendering, so the honest "no rich preview" fallback stays for those.
 */
const PREVIEWABLE_LANGUAGES = new Set(["html", "svg"]);

/**
 * Builds the sandboxed iframe document for the Preview tab, or null if this
 * artifact's language has no rich preview. Both html and svg go through an
 * `<iframe sandbox="allow-scripts">` (srcDoc, not dangerouslySetInnerHTML) —
 * artifact code is agent-generated content, and SVG (like HTML) can carry
 * <script> tags, so it gets the same untrusted-content treatment. `allow-scripts`
 * is included because real animated artifacts (canvas-driven typhoon animations,
 * confirmed live) depend on it; `allow-same-origin` is deliberately omitted so a
 * srcDoc frame gets a unique opaque origin instead of inheriting the app's,
 * closing off DOM/storage access back into the host page.
 */
function buildPreviewDoc(artifact: Artifact): string | null {
  const language = artifact.language.trim().toLowerCase();
  if (!PREVIEWABLE_LANGUAGES.has(language)) return null;

  if (language === "html") return artifact.code;

  // SVG artifacts are just the <svg>...</svg> fragment, not a full document —
  // wrap it in a minimal shell so it centers and scales instead of rendering
  // top-left at its raw intrinsic size against the iframe's default white canvas.
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    html, body { margin: 0; height: 100%; display: flex; align-items: center; justify-content: center; background: #fff; }
    svg { max-width: 100%; max-height: 100%; }
  </style></head><body>${artifact.code}</body></html>`;
}

/**
 * `artifactId` pins the fetch to one specific artifact (GET .../artifacts/:id) —
 * used when a chat attachment chip was clicked. Null falls back to the
 * pre-existing "latest published artifact" behavior (GET .../artifacts/latest).
 */
async function fetchArtifact(conversationId: string, artifactId: string | null): Promise<Artifact | null> {
  const path = artifactId ? `artifacts/${encodeURIComponent(artifactId)}` : "artifacts/latest";
  const res = await fetch(`${API_BASE}/api/conversations/${conversationId}/${path}`);
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
  return (await res.json()) as Artifact | null;
}

export function ArtifactCanvas({
  tab,
  onSetTab,
  onClose,
  conversationId,
  refreshSignal,
  pinnedArtifactId,
}: {
  tab: CanvasTab;
  onSetTab: (tab: CanvasTab) => void;
  onClose: () => void;
  /** Active conversation to fetch the latest artifact for. */
  conversationId: string | null;
  /**
   * Any value that changes to signal "a chat turn just completed, re-check for a new
   * artifact" (Task 13 / TASKS.md: "when ChatView's isLoading transitions true -> false").
   * Wired in App.tsx: an incrementing counter, bumped from ChatView's
   * `onTurnComplete` callback (fired on the true -> false edge of its own
   * `isLoading`), is passed straight through here.
   */
  refreshSignal?: unknown;
  /**
   * Artifacts-as-chat-attachments: when set (from clicking a `publish_artifact`
   * chip in ChatView), fetches that exact artifact by id instead of the
   * conversation's latest one. Null/undefined preserves the pre-existing
   * "always show latest" behavior.
   */
  pinnedArtifactId?: string | null;
}) {
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const isFirstRefreshRender = useRef(true);

  const load = useCallback((id: string, mode: "loading" | "updating", artifactId: string | null) => {
    let cancelled = false;
    setStatus(mode);
    fetchArtifact(id, artifactId)
      .then((data) => {
        if (cancelled) return;
        setArtifact(data);
        setStatus(data ? "populated" : "empty");
      })
      .catch(() => {
        if (cancelled) return;
        // Honest fallback: don't invent content on a failed fetch, just fall back to
        // whatever we already had (or empty, on a failed initial load).
        setStatus((prev) => (prev === "loading" ? "empty" : prev === "updating" ? "populated" : prev));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Initial mount + conversation switch + pinned-artifact change: reset and fetch fresh.
  useEffect(() => {
    if (!conversationId) {
      setArtifact(null);
      setStatus("empty");
      return;
    }
    setArtifact(null);
    return load(conversationId, "loading", pinnedArtifactId ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, pinnedArtifactId]);

  // Turn-completion refresh signal: keep existing content visible, dim it, refetch.
  // Skips the mount render so it doesn't double-fetch alongside the effect above.
  // Re-fetches by the same pinned id if one is set, so a pinned view still picks up
  // a same-id republish rather than only ever refreshing "latest".
  useEffect(() => {
    if (isFirstRefreshRender.current) {
      isFirstRefreshRender.current = false;
      return;
    }
    if (!conversationId) return;
    return load(conversationId, "updating", pinnedArtifactId ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshSignal]);

  const isUpdating = status === "updating";
  const isEmpty = status === "empty";
  const isLoading = status === "loading";

  return (
    <div
      style={{
        width: 466,
        flex: "none",
        display: "flex",
        flexDirection: "column",
        borderLeft: "1px solid var(--color-divider)",
        background: "var(--color-surface)",
        minHeight: 0,
      }}
    >
      <style>{"@keyframes artifactCanvasSpin { to { transform: rotate(360deg); } }"}</style>

      <div style={{ height: 52, flex: "none", display: "flex", alignItems: "center", gap: 10, padding: "0 14px", borderBottom: "1px solid var(--color-divider)" }}>
        <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="var(--color-accent)" strokeWidth={1.6}>
          <path d="M3 3h18v18H3z" />
          <path d="M8 17v-5M12 17V8M16 17v-3" />
        </svg>
        <span style={{ fontFamily: "ui-monospace,Menlo,monospace", fontSize: 13 }}>
          {artifact ? artifact.title : "No artifact yet"}
        </span>
        {artifact && (
          <span className="tag tag-accent" style={{ padding: "1px 6px" }}>
            {artifact.language}
          </span>
        )}
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 2 }}>
          <button
            onClick={onClose}
            style={{ width: 28, height: 28, display: "grid", placeItems: "center", border: "none", background: "transparent", color: "color-mix(in srgb, var(--color-text) 55%, transparent)", cursor: "pointer" }}
          >
            <CloseIcon size={16} />
          </button>
        </div>
      </div>

      {!isEmpty && !isLoading && (
        <div style={{ flex: "none", display: "flex", gap: 2, padding: "8px 12px", borderBottom: "1px solid var(--color-divider)" }}>
          <button
            onClick={() => onSetTab("code")}
            style={{
              padding: "6px 14px",
              border: "none",
              cursor: "pointer",
              fontFamily: "var(--font-heading)",
              fontWeight: 600,
              fontSize: 13,
              background: tab === "code" ? "var(--color-accent)" : "transparent",
              color: tab === "code" ? "var(--color-bg)" : "color-mix(in srgb, var(--color-text) 55%, transparent)",
            }}
          >
            Code
          </button>
          <button
            onClick={() => onSetTab("preview")}
            style={{
              padding: "6px 14px",
              border: "none",
              cursor: "pointer",
              fontFamily: "var(--font-heading)",
              fontWeight: 600,
              fontSize: 13,
              background: tab === "preview" ? "var(--color-accent)" : "transparent",
              color: tab === "preview" ? "var(--color-bg)" : "color-mix(in srgb, var(--color-text) 55%, transparent)",
            }}
          >
            Preview
          </button>
        </div>
      )}

      <div style={{ flex: 1, overflow: "auto", padding: 22, position: "relative" }}>
        {isUpdating && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              background: "color-mix(in srgb, var(--color-surface) 55%, transparent)",
              backdropFilter: "blur(1px)",
              zIndex: 1,
            }}
          />
        )}
        {isUpdating && (
          <div
            role="status"
            style={{
              position: "absolute",
              top: 10,
              right: 10,
              display: "flex",
              alignItems: "center",
              gap: 6,
              fontSize: 11,
              color: "var(--color-accent-700)",
              background: "var(--color-bg)",
              border: "1px solid var(--color-divider)",
              padding: "4px 10px",
              zIndex: 2,
            }}
          >
            <span
              style={{
                width: 11,
                height: 11,
                border: "2px solid var(--color-accent-300)",
                borderTopColor: "var(--color-accent-700)",
                borderRadius: "50%",
                animation: "artifactCanvasSpin 0.7s linear infinite",
              }}
            />
            updating
          </div>
        )}

        {isLoading && (
          <div style={{ padding: "40px 20px", textAlign: "center", fontSize: 13, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>
            Loading artifact…
          </div>
        )}

        {isEmpty && !isLoading && (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", gap: 10, padding: "46px 20px" }}>
            <div
              style={{
                width: 44,
                height: 44,
                borderRadius: "50%",
                background: "var(--color-accent-100)",
                display: "grid",
                placeItems: "center",
                color: "var(--color-accent-700)",
              }}
            >
              <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6}>
                <path d="M14 3v18M3 5h18M3 19h18" />
              </svg>
            </div>
            <div style={{ fontSize: 13, color: "color-mix(in srgb, var(--color-text) 60%, transparent)", maxWidth: 230 }}>
              Nothing published to the canvas yet in this conversation.
            </div>
            <div style={{ fontSize: 11, color: "color-mix(in srgb, var(--color-text) 45%, transparent)" }}>
              Ask pi to build something — code, a chart, a doc — and it'll appear here.
            </div>
          </div>
        )}

        {artifact && !isEmpty && !isLoading && tab === "code" && (
          <pre
            style={{
              margin: 0,
              fontFamily: "ui-monospace,'SF Mono',Menlo,monospace",
              fontSize: 12,
              lineHeight: 1.7,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {artifact.code}
          </pre>
        )}

        {artifact && !isEmpty && !isLoading && tab === "preview" && (() => {
          const previewDoc = buildPreviewDoc(artifact);
          return previewDoc ? (
            <iframe
              key={artifact.id + artifact.publishedAt}
              title={`Preview: ${artifact.title}`}
              srcDoc={previewDoc}
              sandbox="allow-scripts"
              style={{ width: "100%", height: "60vh", border: "1px solid var(--color-divider)", background: "#fff" }}
            />
          ) : (
            <div style={{ fontSize: 13, color: "color-mix(in srgb, var(--color-text) 55%, transparent)", padding: "20px 0" }}>
              No rich preview available for this artifact type — showing code only.
            </div>
          );
        })()}
      </div>
    </div>
  );
}
