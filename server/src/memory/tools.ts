import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { embed } from "./embed.js";
import { insertMemory, searchMemories } from "./store.js";

export function createMemoryTools() {
  const remember = defineTool({
    name: "remember",
    label: "Remember",
    description: "Save a fact, preference, or note to long-term local memory (a local vector store) for later semantic recall.",
    parameters: Type.Object({
      text: Type.String({ description: "The fact or note to remember" }),
    }),
    execute: async (_toolCallId, params) => {
      const vector = await embed(params.text);
      const id = insertMemory(params.text, vector);
      return {
        content: [{ type: "text", text: `Saved memory #${id}.` }],
        details: { id },
      };
    },
  });

  const recall = defineTool({
    name: "recall",
    label: "Recall",
    description: "Semantically search long-term local memory for facts and notes relevant to a query.",
    parameters: Type.Object({
      query: Type.String({ description: "What to search for" }),
      limit: Type.Optional(Type.Number({ description: "Max results to return", default: 5 })),
    }),
    execute: async (_toolCallId, params) => {
      const vector = await embed(params.query);
      const results = searchMemories(vector, params.limit ?? 5);
      const text = results.length
        ? results.map((r) => `#${r.id} (distance ${r.distance.toFixed(3)}): ${r.text}`).join("\n")
        : "No matching memories found.";
      return { content: [{ type: "text", text }], details: { results } };
    },
  });

  return [remember, recall];
}
