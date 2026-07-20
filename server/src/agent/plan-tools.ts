import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { RunManager } from "../chat-workspace/runs.js";

const activeRuns = new Map<string, { manager: RunManager; runId: string }>();
export function getActiveRunContext(conversationId: string) { return activeRuns.get(conversationId); }

export function setActivePlanRun(conversationId: string, context: { manager: RunManager; runId: string } | undefined): void {
  if (context) activeRuns.set(conversationId, context);
  else activeRuns.delete(conversationId);
}

export function emitActiveRunEvent(conversationId: string, type: string, data: unknown): void {
  const context = activeRuns.get(conversationId);
  if (context) context.manager.emit(context.runId, type, data);
}

export function createPlanTools(conversationId: string) {
  return [defineTool({
    name: "update_plan",
    label: "Update plan",
    description: "Publish or update the visible execution plan. Keep step IDs and order stable across updates.",
    parameters: Type.Object({
      explanation: Type.Optional(Type.String()),
      steps: Type.Array(Type.Object({
        id: Type.String(), text: Type.String(), status: Type.Union([
          Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed"),
        ]),
      }), { minItems: 1 }),
    }),
    execute: async (_toolCallId, params) => {
      const context = activeRuns.get(conversationId);
      if (!context) throw new Error("No active durable run for update_plan");
      const steps = context.manager.updatePlan(context.runId, params);
      return {
        content: [{ type: "text", text: `Updated plan with ${steps.length} steps.` }],
        details: { runId: context.runId, steps },
      };
    },
  })];
}
