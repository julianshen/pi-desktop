import { useCallback, useEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import { Blueprint } from "../../components/Blueprint";
import { StatusTag } from "../../components/StatusTag";

// Same env var (and same fallback host/port) App.tsx's RUNTIME_URL uses for the
// CopilotKit endpoint — derived independently here since RUNTIME_URL isn't exported.
// Do not hardcode a second, divergent default port/host; keep this in sync with
// App.tsx's `RUNTIME_URL` if that ever changes.
const COPILOTKIT_RUNTIME_URL = import.meta.env.VITE_COPILOTKIT_RUNTIME_URL ?? "http://127.0.0.1:4319/copilotkit";
const SERVER_ORIGIN = new URL(COPILOTKIT_RUNTIME_URL).origin;

/** Mirrors SPEC.md's `ProviderStatus` response shape (server/src/settings/routes.ts). */
interface ProviderStatus {
  id: string;
  displayName: string;
  configured: boolean;
  source: "api_key" | "oauth" | "env" | "none";
  modelCount: number;
  maskedKey?: string;
}

/**
 * Per-provider one-line guidance shown above the API key field in the connect/manage
 * modal (DESIGN.md's `GuidanceCallout`, content adapted from the divergent sketch's
 * `providerGuidance` map). Keyed by the REAL backend provider ids
 * (`BUILT_IN_PROVIDER_DISPLAY_NAMES` in server/src/settings/routes.ts), not the old
 * mock list's ids — "pi-cloud" and "ollama" from `mockData.ts`'s sample list aren't
 * real pi SDK provider ids and never appear in the live `GET /providers` response, so
 * they have no entry here. Providers without an authored entry simply render no
 * callout (never a broken/empty string) — see `GuidanceCallout` below.
 */
const PROVIDER_GUIDANCE: Record<string, string> = {
  openai: "Create a key at platform.openai.com/api-keys. Billing must be enabled on your account.",
  anthropic: "Create a key at console.anthropic.com/settings/keys.",
  "google-vertex": "Requires a GCP service account with the Vertex AI User role.",
  mistral: "Create a key at console.mistral.ai/api-keys.",
  openrouter: "Create a key at openrouter.ai/keys — routes to 100+ underlying models.",
};

const mutedText: CSSProperties = { color: "color-mix(in srgb, var(--color-text) 55%, transparent)" };

export function ProvidersView() {
  const [providers, setProviders] = useState<ProviderStatus[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [activeProviderId, setActiveProviderId] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [modalError, setModalError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const keyInputRef = useRef<HTMLInputElement | null>(null);
  const modalRef = useRef<HTMLDivElement | null>(null);

  const loadProviders = useCallback(async () => {
    try {
      const res = await fetch(`${SERVER_ORIGIN}/api/settings/providers`);
      if (!res.ok) throw new Error(`Server returned ${res.status}`);
      const data = (await res.json()) as { providers: ProviderStatus[] };
      setProviders(data.providers);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not load providers.");
    }
  }, []);

  useEffect(() => {
    void loadProviders();
  }, [loadProviders]);

  const activeProvider = providers?.find((p) => p.id === activeProviderId) ?? null;

  const patchProvider = (updated: ProviderStatus) => {
    setProviders((prev) => (prev ? prev.map((p) => (p.id === updated.id ? updated : p)) : prev));
  };

  const closeModal = useCallback(() => {
    setActiveProviderId(null);
    setApiKey("");
    setModalError(null);
    setSubmitting(false);
    triggerRef.current?.focus();
    triggerRef.current = null;
  }, []);

  const openModal = (id: string, trigger: HTMLButtonElement) => {
    triggerRef.current = trigger;
    setApiKey("");
    setModalError(null);
    setSubmitting(false);
    setActiveProviderId(id);
  };

  // Escape-to-close, click-outside-to-close (handled inline on the scrim), and a
  // lightweight focus trap while the modal is open (DESIGN.md's Accessibility section).
  useEffect(() => {
    if (!activeProviderId) return;
    keyInputRef.current?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeModal();
        return;
      }
      if (e.key === "Tab" && modalRef.current) {
        const focusable = modalRef.current.querySelectorAll<HTMLElement>(
          'button:not(:disabled), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeProviderId, closeModal]);

  const submitConnect = async () => {
    if (!activeProviderId) return;
    const trimmed = apiKey.trim();
    if (!trimmed) {
      setModalError("Enter an API key first.");
      return;
    }

    setSubmitting(true);
    setModalError(null);
    try {
      const res = await fetch(`${SERVER_ORIGIN}/api/settings/providers/${encodeURIComponent(activeProviderId)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey: trimmed }),
      });
      const data = (await res.json()) as { provider?: ProviderStatus; error?: string };

      // Per SPEC.md's revised POST /providers/:id contract, 200 is the only success
      // path and it's optimistic — any syntactically-valid key is accepted. 404
      // (unknown provider) and 422 (missing apiKey) are edge cases, not a "bad key
      // was rejected" result (that codepath no longer exists server-side). 500 is an
      // unexpected server fault. All three land here as a simple inline error,
      // without closing the modal, per the task's revised instructions.
      if (!res.ok || !data.provider) {
        setModalError(data.error ?? "Something went wrong. Try again.");
        setSubmitting(false);
        return;
      }

      patchProvider(data.provider);
      closeModal();
    } catch {
      setModalError("Could not reach the server. Check that it's running and try again.");
      setSubmitting(false);
    }
  };

  const disconnect = async () => {
    if (!activeProviderId) return;
    setSubmitting(true);
    setModalError(null);
    try {
      const res = await fetch(`${SERVER_ORIGIN}/api/settings/providers/${encodeURIComponent(activeProviderId)}`, {
        method: "DELETE",
      });
      const data = (await res.json()) as { provider?: ProviderStatus; error?: string };
      if (!res.ok || !data.provider) {
        setModalError(data.error ?? "Something went wrong. Try again.");
        setSubmitting(false);
        return;
      }
      patchProvider(data.provider);
      closeModal();
    } catch {
      setModalError("Could not reach the server. Check that it's running and try again.");
      setSubmitting(false);
    }
  };

  return (
    <div style={{ maxWidth: 920 }}>
      <div style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 21, marginBottom: 3 }}>Providers</div>
      <p style={{ fontSize: 13, margin: "0 0 18px", ...mutedText }}>
        Connect model providers with your own keys. pi routes each request to the selected provider and normalizes
        streaming, tools and cost.
      </p>

      {loadError && (
        <div
          style={{
            fontSize: 13,
            padding: "10px 14px",
            marginBottom: 16,
            background: "var(--color-danger-bg)",
            color: "var(--color-danger)",
            border: "1px solid var(--color-danger)",
          }}
        >
          Could not load providers: {loadError}
        </div>
      )}

      {providers === null && !loadError && <p style={{ fontSize: 13, ...mutedText }}>Loading providers…</p>}

      {providers !== null && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(282px, 1fr))", gap: 16 }}>
          {providers.map((p) => (
            <ProviderCard key={p.id} provider={p} onOpen={openModal} />
          ))}
        </div>
      )}

      {activeProviderId && activeProvider && (
        <ConnectModal
          provider={activeProvider}
          apiKey={apiKey}
          onApiKeyChange={setApiKey}
          error={modalError}
          submitting={submitting}
          modalRef={modalRef}
          keyInputRef={keyInputRef}
          onClose={closeModal}
          onSubmit={() => void submitConnect()}
          onDisconnect={() => void disconnect()}
        />
      )}
    </div>
  );
}

function ProviderCard({
  provider,
  onOpen,
}: {
  provider: ProviderStatus;
  onOpen: (id: string, trigger: HTMLButtonElement) => void;
}) {
  return (
    <Blueprint style={{ padding: 15, display: "flex", flexDirection: "column", gap: 12, background: "transparent", minHeight: 150 }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
        <span style={{ display: "block", fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 17, lineHeight: 1.1 }}>
          {provider.displayName}
        </span>
        <StatusTag status={provider.configured ? "Connected" : "Not connected"} />
      </div>
      <div style={{ display: "flex", gap: 22, fontSize: 12 }}>
        <div>
          <div style={{ fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", ...mutedText }}>Models</div>
          <div style={{ fontFamily: "ui-monospace,Menlo,monospace" }}>{provider.modelCount}</div>
        </div>
        {provider.maskedKey && (
          <div>
            <div style={{ fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", ...mutedText }}>Key</div>
            <div style={{ fontFamily: "ui-monospace,Menlo,monospace" }}>{provider.maskedKey}</div>
          </div>
        )}
      </div>
      <button
        className={provider.configured ? "btn btn-secondary" : "btn btn-primary"}
        style={{ marginTop: "auto", alignSelf: "flex-start", height: 30 }}
        onClick={(e) => onOpen(provider.id, e.currentTarget)}
      >
        {provider.configured ? "Manage" : "Connect"}
      </button>
    </Blueprint>
  );
}

function ConnectModal({
  provider,
  apiKey,
  onApiKeyChange,
  error,
  submitting,
  modalRef,
  keyInputRef,
  onClose,
  onSubmit,
  onDisconnect,
}: {
  provider: ProviderStatus;
  apiKey: string;
  onApiKeyChange: (value: string) => void;
  error: string | null;
  submitting: boolean;
  modalRef: RefObject<HTMLDivElement | null>;
  keyInputRef: RefObject<HTMLInputElement | null>;
  onClose: () => void;
  onSubmit: () => void;
  onDisconnect: () => void;
}) {
  const isManaging = provider.configured;
  const guidance = PROVIDER_GUIDANCE[provider.id];
  const titleId = "connect-provider-modal-title";
  const keyInputId = "connect-provider-modal-key";

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "color-mix(in srgb, #000 45%, transparent)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 20,
      }}
      onMouseDown={(e) => {
        // Click-outside-to-close: only when the mousedown target is the scrim itself,
        // not a descendant of the modal (DESIGN.md Interactions).
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div ref={modalRef} role="dialog" aria-modal="true" aria-labelledby={titleId} style={{ animation: "modal-in 0.2s ease" }}>
        <Blueprint style={{ width: 420, background: "var(--color-bg)", padding: "var(--space-6)", boxShadow: "var(--shadow-lg)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "var(--space-4)" }}>
            <div>
              <div id={titleId} style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 19 }}>
                {isManaging ? "Manage" : "Connect"} {provider.displayName}
              </div>
              <div style={{ fontSize: 12, marginTop: 2, ...mutedText }}>
                {isManaging ? "Replace the saved key, or disconnect below." : "Enter your API key to connect this provider."}
              </div>
            </div>
            <button
              aria-label="Close"
              onClick={onClose}
              style={{ cursor: "pointer", fontSize: 18, lineHeight: 1, background: "none", border: "none", ...mutedText }}
            >
              ✕
            </button>
          </div>

          {guidance && (
            <div
              style={{
                fontSize: 12,
                background: "var(--color-accent-100)",
                border: "1px solid var(--color-accent-300)",
                color: "var(--color-accent-900)",
                padding: "10px 12px",
                marginBottom: "var(--space-4)",
              }}
            >
              {guidance}
            </div>
          )}

          <div className="field">
            <label htmlFor={keyInputId}>API key</label>
            <input
              ref={keyInputRef}
              id={keyInputId}
              className="input"
              type="password"
              autoComplete="off"
              placeholder="Paste your API key"
              value={apiKey}
              onChange={(e) => onApiKeyChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  onSubmit();
                }
              }}
            />
          </div>

          {error && (
            <div style={{ fontSize: 12, color: "var(--color-danger)", marginTop: 6 }} role="alert">
              {error}
            </div>
          )}

          <div style={{ fontSize: 11, marginTop: 8, ...mutedText }}>
            Stored locally in <code>~/.pi-desktop/auth.json</code>. Applies immediately, no restart needed.
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: "var(--space-4)" }}>
            {isManaging && (
              <button
                className="btn btn-secondary"
                disabled={submitting}
                onClick={onDisconnect}
                style={{ marginRight: "auto", color: "var(--color-danger)", borderColor: "var(--color-danger)" }}
                onMouseDown={(e) => e.stopPropagation()}
              >
                Disconnect
              </button>
            )}
            <button className="btn btn-secondary" onClick={onClose} disabled={submitting}>
              Cancel
            </button>
            <button className="btn btn-primary" onClick={onSubmit} disabled={submitting}>
              {isManaging ? "Save" : "Connect"}
            </button>
          </div>
        </Blueprint>
      </div>
    </div>
  );
}
