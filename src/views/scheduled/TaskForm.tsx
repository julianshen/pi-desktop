import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Blueprint } from "../../components/Blueprint.js";
import type { ScheduledTaskInput, ScheduledTaskSummary } from "./types.js";
import { API_BASE } from "../../state/apiBase.js";

interface ModelSummary { id: string; label: string; provider: string }
type FieldErrors = Partial<Record<"name" | "prompt" | "cron" | "timezone", string>>;
type TaskFormValue = Omit<ScheduledTaskInput, "timezone" | "modelId"> & { timezone: string; modelId: string | null };

function hostTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function timezoneIsValid(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}

function cronLooksValid(cron: string): boolean {
  const fields = cron.trim().split(/\s+/);
  return fields.length === 5 && fields.every((field) => /^[\d*,\-\/]+$/.test(field));
}

function initialValue(task?: ScheduledTaskSummary): TaskFormValue {
  return {
    name: task?.name ?? "",
    prompt: task?.prompt ?? "",
    cron: task?.cron ?? "0 9 * * *",
    timezone: task?.timezone ?? hostTimezone(),
    enabled: task?.enabled ?? true,
    modelId: task?.modelId ?? null,
  };
}

export function TaskForm({
  mode,
  task,
  onSubmit,
  onCancel,
}: {
  mode: "create" | "edit";
  task?: ScheduledTaskSummary;
  onSubmit: (value: ScheduledTaskInput) => Promise<unknown>;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(() => initialValue(task));
  const [models, setModels] = useState<ModelSummary[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [actionError, setActionError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let stopped = false;
    fetch(`${API_BASE}/api/models`)
      .then((response) => {
        if (!response.ok) throw new Error("Models could not be loaded.");
        return response.json() as Promise<ModelSummary[]>;
      })
      .then((next) => { if (!stopped) setModels(next); })
      .catch((cause: unknown) => {
        if (!stopped) setActionError(cause instanceof Error ? cause.message : "Models could not be loaded.");
      })
      .finally(() => { if (!stopped) setModelsLoading(false); });
    return () => { stopped = true; };
  }, []);

  const cronPreview = useMemo(() => {
    if (!cronLooksValid(value.cron)) return "Enter five cron fields: minute hour day month weekday.";
    return `${value.cron.trim().replace(/\s+/g, " ")} · ${value.timezone}`;
  }, [value.cron, value.timezone]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const errors: FieldErrors = {};
    if (!value.name.trim()) errors.name = "Enter a task name.";
    if (!value.prompt.trim()) errors.prompt = "Enter instructions for the agent.";
    if (!cronLooksValid(value.cron)) errors.cron = "Use a valid five-field cron expression.";
    if (!timezoneIsValid(value.timezone.trim())) errors.timezone = "Use a valid IANA timezone.";
    setFieldErrors(errors);
    setActionError(null);
    if (Object.keys(errors).length) return;
    setSaving(true);
    try {
      await onSubmit({
        name: value.name.trim(),
        prompt: value.prompt.trim(),
        cron: value.cron.trim().replace(/\s+/g, " "),
        timezone: value.timezone.trim(),
        enabled: value.enabled,
        modelId: value.modelId || null,
      });
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "The scheduled task could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="scheduled-form-backdrop">
      <section className="scheduled-form" role="dialog" aria-modal="true" aria-labelledby="scheduled-form-title">
        <header>
          <div>
            <div className="scheduled-eyebrow">Automation definition</div>
            <h2 id="scheduled-form-title">{mode === "create" ? "New scheduled task" : "Edit scheduled task"}</h2>
          </div>
          <button type="button" className="scheduled-form-close" aria-label="Close task form" onClick={onCancel}>×</button>
        </header>
        <form onSubmit={(event) => void submit(event)}>
          <Blueprint className="scheduled-form-section">
            <div className="field">
              <label htmlFor="scheduled-name">Task name</label>
              <input id="scheduled-name" className="input" value={value.name} onChange={(event) => setValue((current) => ({ ...current, name: event.target.value }))} aria-invalid={Boolean(fieldErrors.name)} autoFocus />
              {fieldErrors.name && <span className="scheduled-field-error">{fieldErrors.name}</span>}
            </div>
            <div className="field">
              <label htmlFor="scheduled-prompt">Instructions</label>
              <textarea id="scheduled-prompt" className="input" value={value.prompt} onChange={(event) => setValue((current) => ({ ...current, prompt: event.target.value }))} aria-invalid={Boolean(fieldErrors.prompt)} rows={7} />
              {fieldErrors.prompt && <span className="scheduled-field-error">{fieldErrors.prompt}</span>}
            </div>
          </Blueprint>

          <Blueprint className="scheduled-form-section scheduled-form-grid">
            <div className="field">
              <label htmlFor="scheduled-cron">Cron expression</label>
              <input id="scheduled-cron" className="input scheduled-mono" value={value.cron} onChange={(event) => setValue((current) => ({ ...current, cron: event.target.value }))} aria-invalid={Boolean(fieldErrors.cron)} />
              {fieldErrors.cron && <span className="scheduled-field-error">{fieldErrors.cron}</span>}
            </div>
            <div className="field">
              <label htmlFor="scheduled-timezone">Timezone</label>
              <input id="scheduled-timezone" className="input" list="scheduled-timezones" value={value.timezone} onChange={(event) => setValue((current) => ({ ...current, timezone: event.target.value }))} aria-invalid={Boolean(fieldErrors.timezone)} />
              <datalist id="scheduled-timezones"><option value="UTC" /><option value="Asia/Taipei" /><option value="America/New_York" /><option value="Europe/London" /></datalist>
              {fieldErrors.timezone && <span className="scheduled-field-error">{fieldErrors.timezone}</span>}
            </div>
            <div className="scheduled-cron-preview">Schedule: <code>{cronPreview}</code></div>
          </Blueprint>

          <Blueprint className="scheduled-form-section scheduled-form-grid">
            <div className="field">
              <label htmlFor="scheduled-model">Model override</label>
              <select id="scheduled-model" className="input" value={value.modelId ?? ""} disabled={modelsLoading} onChange={(event) => setValue((current) => ({ ...current, modelId: event.target.value || null }))}>
                <option value="">Use app default</option>
                {models.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
              </select>
            </div>
            <label className="scheduled-enabled">
              <input type="checkbox" checked={value.enabled} onChange={(event) => setValue((current) => ({ ...current, enabled: event.target.checked }))} />
              <span><strong>Enabled</strong><small>Register this schedule immediately after saving.</small></span>
            </label>
          </Blueprint>

          {actionError && <div className="scheduled-form-error" role="alert">{actionError}</div>}
          <footer>
            <button type="button" className="btn btn-secondary" onClick={onCancel}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? "Saving…" : mode === "create" ? "Create task" : "Save changes"}</button>
          </footer>
        </form>
      </section>
    </div>
  );
}
