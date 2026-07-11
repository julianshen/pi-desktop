import { CopilotRuntime, copilotRuntimeNodeExpressEndpoint } from "@copilotkit/runtime";
import { HttpAgent } from "@ag-ui/client";

/**
 * Registers the pi-backed AG-UI endpoint as the (only, "default") remote agent, so the
 * frontend's <CopilotChat>/<CopilotSidebar> need no per-component agent selection.
 */
export function createCopilotEndpoint(baseUrl: string) {
  const runtime = new CopilotRuntime({
    agents: {
      default: new HttpAgent({ url: `${baseUrl}/agui` }),
    },
  });

  return copilotRuntimeNodeExpressEndpoint({
    runtime,
    endpoint: "/copilotkit",
  });
}
