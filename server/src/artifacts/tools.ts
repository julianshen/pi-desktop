import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { saveArtifact } from "./store.js";

export function createArtifactTools(conversationId: string) {
  const publishArtifact = defineTool({
    name: "publish_artifact",
    label: "Publish artifact",
    description: "Publish a named code/preview block to the user's Artifact Canvas.",
    parameters: Type.Object({
      id: Type.String({ description: "Stable id — re-publishing with the same id overwrites it" }),
      title: Type.String({ description: "Human-readable title shown on the Artifact Canvas" }),
      language: Type.String({ description: 'Syntax-highlighting language, e.g. "tsx", "python"' }),
      code: Type.String({ description: "The full code/content to publish" }),
    }),
    execute: async (_toolCallId, params) => {
      saveArtifact(conversationId, { ...params, publishedAt: new Date().toISOString() });
      return {
        content: [{ type: "text", text: `Published artifact "${params.title}".` }],
        details: { id: params.id },
      };
    },
  });

  return [publishArtifact];
}
