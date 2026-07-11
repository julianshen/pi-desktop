import { Blueprint } from "../../components/Blueprint";
import { StatusTag } from "../../components/StatusTag";
import { providersList } from "../../data/mockData";

export function ProvidersView() {
  return (
    <div style={{ maxWidth: 920 }}>
      <div style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 21, marginBottom: 3 }}>Providers</div>
      <p style={{ fontSize: 13, color: "color-mix(in srgb, var(--color-text) 55%, transparent)", margin: "0 0 18px" }}>
        Connect model providers with your own keys. pi routes each request to the selected provider and normalizes
        streaming, tools and cost.
      </p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(282px, 1fr))", gap: 16 }}>
        {providersList.map((p) => {
          const connected = p.status === "Connected";
          return (
            <Blueprint key={p.name} style={{ padding: 15, display: "flex", flexDirection: "column", gap: 12, background: "transparent", minHeight: 150 }}>
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
                <span>
                  <span style={{ display: "block", fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 17, lineHeight: 1.1 }}>
                    {p.name}
                  </span>
                  {p.note && (
                    <span style={{ display: "block", fontSize: 11, color: "color-mix(in srgb, var(--color-text) 45%, transparent)" }}>
                      {p.note}
                    </span>
                  )}
                </span>
                <StatusTag status={p.status} />
              </div>
              <div style={{ display: "flex", gap: 22, fontSize: 12 }}>
                <div>
                  <div style={{ color: "color-mix(in srgb, var(--color-text) 45%, transparent)", fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase" }}>
                    Endpoint
                  </div>
                  <div style={{ fontFamily: "ui-monospace,Menlo,monospace" }}>{p.url}</div>
                </div>
                <div>
                  <div style={{ color: "color-mix(in srgb, var(--color-text) 45%, transparent)", fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase" }}>
                    Models
                  </div>
                  <div style={{ fontFamily: "ui-monospace,Menlo,monospace" }}>{p.models}</div>
                </div>
              </div>
              <button className={connected ? "btn btn-secondary" : "btn btn-primary"} style={{ marginTop: "auto", alignSelf: "flex-start", height: 30 }}>
                {connected ? "Manage" : "Connect"}
              </button>
            </Blueprint>
          );
        })}
      </div>
    </div>
  );
}
