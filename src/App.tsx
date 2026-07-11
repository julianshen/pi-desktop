import { CopilotKit } from "@copilotkit/react-core";
import { CopilotChat } from "@copilotkit/react-ui";
import "@copilotkit/react-ui/styles.css";
import "./App.css";

const RUNTIME_URL = import.meta.env.VITE_COPILOTKIT_RUNTIME_URL ?? "http://127.0.0.1:4319/copilotkit";

function App() {
  return (
    <CopilotKit runtimeUrl={RUNTIME_URL}>
      <main className="app-shell">
        <header className="app-header">
          <span className="app-title">pi desktop</span>
        </header>
        <CopilotChat
          className="app-chat"
          labels={{
            title: "pi",
            initial:
              "Hi! I'm your pi-powered desktop assistant. Ask me anything — I can use tools, skills, MCP servers, and remember things across conversations.",
          }}
        />
      </main>
    </CopilotKit>
  );
}

export default App;
