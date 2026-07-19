import { useEffect, useState } from "react";
import { Blueprint } from "../../components/Blueprint.js";
import { API_BASE } from "../../state/apiBase.js";

interface PublicSearchSettings { enabled: boolean; provider: "brave"; keyPresent: boolean; maxResults: number }

export function SearchSettingsView() {
  const [settings, setSettings] = useState<PublicSearchSettings | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch(`${API_BASE}/api/settings/search`)
      .then(async (response) => {
        if (!response.ok) throw new Error(`Could not load web search (${response.status})`);
        setSettings(await response.json() as PublicSearchSettings);
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Could not load web search"));
  }, []);

  async function save() {
    if (!settings) return;
    setSaving(true); setError(undefined);
    try {
      const response = await fetch(`${API_BASE}/api/settings/search`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: settings.enabled, provider: "brave", maxResults: settings.maxResults, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) }),
      });
      if (!response.ok) throw new Error(`Could not save web search (${response.status})`);
      setSettings(await response.json() as PublicSearchSettings); setApiKey("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save web search"); }
    finally { setSaving(false); }
  }

  if (!settings) return <div role="status" className="text-sm text-muted">{error ?? "Loading web search settings…"}</div>;
  return (
    <div className="max-w-[760px] space-y-ds-4">
      <div><h2 className="font-heading text-xl font-semibold">Web search</h2><p className="mt-ds-1 text-sm text-muted">Provider-neutral search is available to the agent automatically. Brave is the first built-in provider.</p></div>
      <Blueprint className="bg-surface p-ds-4">
        <div className="grid gap-ds-4 md:grid-cols-[1fr_180px]">
          <label className="flex items-center justify-between gap-ds-4 text-sm"><span><strong>Automatic search</strong><span className="mt-1 block text-xs text-muted">Let the agent search when current public evidence is needed.</span></span><input aria-label="Enable automatic web search" type="checkbox" checked={settings.enabled} onChange={(event) => setSettings({ ...settings, enabled: event.target.checked })} /></label>
          <label className="text-xs font-semibold uppercase tracking-wide">Result limit<input aria-label="Maximum search results" className="mt-ds-1 w-full border border-divider bg-bg p-ds-2 font-body text-sm" type="number" min={1} max={10} value={settings.maxResults} onChange={(event) => setSettings({ ...settings, maxResults: Math.max(1, Math.min(10, Number(event.target.value))) })} /></label>
          <label className="md:col-span-2 text-xs font-semibold uppercase tracking-wide">Brave Search API key<input aria-label="Brave Search API key" className="mt-ds-1 w-full border border-divider bg-bg p-ds-2 font-body text-sm" type="password" autoComplete="off" value={apiKey} placeholder={settings.keyPresent ? "Configured — enter a new key to replace" : "Enter API key"} onChange={(event) => setApiKey(event.target.value)} /><span className="mt-1 block font-body font-normal normal-case text-muted">The key is stored server-side and is never returned to this window.</span></label>
        </div>
        <div className="mt-ds-4 flex items-center justify-between border-t border-divider pt-ds-3"><span role="status" className="text-xs text-muted">{error ?? (settings.keyPresent ? "Brave credentials configured" : "No Brave key configured")}</span><button type="button" className="btn btn-primary" disabled={saving} onClick={() => void save()}>{saving ? "Saving…" : "Save search settings"}</button></div>
      </Blueprint>
    </div>
  );
}
