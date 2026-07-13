import { useEffect, useState } from "react";
import { Blueprint } from "../../components/Blueprint";
import { SERVER_ORIGIN } from "../../lib/serverOrigin";
import { mutedText } from "../../lib/styles";

interface ModelOption {
  provider: string;
  id: string;
  name: string;
  contextWindow?: number;
}

interface DefaultModel {
  provider: string | null;
  model: string | null;
}

export function ModelDefaultsView() {
  const [models, setModels] = useState<ModelOption[]>([]);
  const [current, setCurrent] = useState<DefaultModel>({ provider: null, model: null });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const searchInputId = "model-defaults-search";

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [modelsRes, defaultRes] = await Promise.all([
          fetch(`${SERVER_ORIGIN}/api/settings/models`),
          fetch(`${SERVER_ORIGIN}/api/settings/default-model`),
        ]);
        if (!modelsRes.ok || !defaultRes.ok) throw new Error("request_failed");
        const modelsBody = (await modelsRes.json()) as { models: ModelOption[] };
        const defaultBody = (await defaultRes.json()) as DefaultModel;
        if (cancelled) return;
        setModels(modelsBody.models);
        setCurrent(defaultBody);
      } catch {
        if (!cancelled) setLoadError("Couldn't load model settings — is the server running?");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const query = search.trim().toLowerCase();
  // Mirrors the conservative sketch's renderModels() filter exactly:
  // m.name.toLowerCase().includes(q) || m.provider.toLowerCase().includes(q)
  const filtered = models.filter((m) => m.name.toLowerCase().includes(query) || m.provider.toLowerCase().includes(query));

  const currentModelOption = models.find((m) => m.provider === current.provider && m.id === current.model);

  async function pickModel(m: ModelOption) {
    const key = `${m.provider}/${m.id}`;
    setSavingKey(key);
    setSaveError(null);
    try {
      const res = await fetch(`${SERVER_ORIGIN}/api/settings/default-model`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: m.provider, model: m.id }),
      });
      const body = (await res.json()) as { provider?: string; model?: string; error?: string };
      if (!res.ok) {
        setSaveError(body.error ?? "Could not set this as the default model.");
        return;
      }
      setCurrent({ provider: body.provider ?? m.provider, model: body.model ?? m.id });
    } catch {
      setSaveError("Could not reach the server. Check that it's running and try again.");
    } finally {
      setSavingKey(null);
    }
  }

  return (
    <div style={{ maxWidth: 780 }}>
      <div style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 21, marginBottom: 3 }}>Model defaults</div>
      <p style={{ fontSize: 13, margin: "0 0 18px", ...mutedText }}>
        Applied to new conversations. Any chat can override this from the model picker.
      </p>

      <Blueprint style={{ padding: 20, background: "transparent" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: 12,
            background: "var(--color-accent-100)",
            border: "1px solid var(--color-accent-300)",
            marginBottom: 14,
          }}
        >
          {loading ? (
            <span style={{ fontSize: 13 }}>Loading current default…</span>
          ) : current.provider && current.model ? (
            <div>
              <div style={{ fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", ...mutedText }}>
                Current default
              </div>
              <div style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 15 }}>
                {currentModelOption?.name ?? current.model}{" "}
                <span style={{ fontSize: 11, fontWeight: 400, fontFamily: "var(--font-body)", ...mutedText }}>
                  · {current.provider}
                </span>
              </div>
            </div>
          ) : (
            <span style={{ fontSize: 13 }}>No default model set yet — pick one below.</span>
          )}
        </div>

        {loadError && <p style={{ fontSize: 13, color: "var(--color-danger)", margin: "0 0 14px" }}>{loadError}</p>}

        <div className="field" style={{ marginBottom: 10 }}>
          <label htmlFor={searchInputId}>Search models</label>
          <input
            id={searchInputId}
            className="input"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search available models…"
          />
        </div>

        {saveError && <p style={{ fontSize: 13, color: "var(--color-danger)", margin: "0 0 10px" }}>{saveError}</p>}

        <div role="listbox" aria-label="Available models" style={{ border: "1px solid var(--color-divider)", maxHeight: 320, overflowY: "auto" }}>
          {loading ? (
            <div style={{ padding: 14, fontSize: 13, ...mutedText }}>Loading models…</div>
          ) : loadError ? null : models.length === 0 ? (
            <div style={{ padding: 14, fontSize: 13, ...mutedText }}>
              No available models match your connected providers.
            </div>
          ) : filtered.length === 0 ? (
            <div style={{ padding: 14, fontSize: 13, ...mutedText }}>No models match your search.</div>
          ) : (
            filtered.map((m) => {
              const key = `${m.provider}/${m.id}`;
              const isSelected = m.provider === current.provider && m.id === current.model;
              const isHovered = hoveredKey === key;
              const isSaving = savingKey === key;
              return (
                <div
                  key={key}
                  role="option"
                  aria-selected={isSelected}
                  tabIndex={0}
                  onClick={() => {
                    if (!savingKey) void pickModel(m);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      if (!savingKey) void pickModel(m);
                    }
                  }}
                  onMouseEnter={() => setHoveredKey(key)}
                  onMouseLeave={() => setHoveredKey((k) => (k === key ? null : k))}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    padding: "10px 12px",
                    fontSize: 13,
                    cursor: savingKey ? "default" : "pointer",
                    borderBottom: "1px solid color-mix(in srgb, var(--color-text) 8%, transparent)",
                    background: isSelected
                      ? "var(--color-accent-100)"
                      : isHovered
                        ? "color-mix(in srgb, var(--color-text) 4%, transparent)"
                        : "transparent",
                    opacity: savingKey && !isSaving ? 0.6 : 1,
                  }}
                >
                  <span>
                    {m.name}{" "}
                    <span style={{ fontSize: 11, ...mutedText }}>
                      {m.provider}
                      {m.contextWindow ? ` · ${Math.round(m.contextWindow / 1000)}k ctx` : ""}
                    </span>
                  </span>
                  {isSaving ? <span style={{ fontSize: 11, ...mutedText }}>Saving…</span> : isSelected ? <span aria-hidden>✓</span> : null}
                </div>
              );
            })
          )}
        </div>
      </Blueprint>
    </div>
  );
}
