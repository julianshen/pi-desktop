import type { SettingsSection } from "../state/useShellState";
import { ProvidersView } from "./settings/ProvidersView";
import { ModelDefaultsView } from "./settings/ModelDefaultsView";
import { SearchSettingsView } from "./settings/SearchSettingsView";

export function SettingsView({ section }: { section: SettingsSection }) {
  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "22px 24px" }}>
      {section === "providers" ? <ProvidersView /> : section === "models" ? <ModelDefaultsView /> : <SearchSettingsView />}
    </div>
  );
}
