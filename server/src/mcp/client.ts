import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { env } from "../config/env.js";

interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface McpServersFile {
  mcpServers?: Record<string, McpServerConfig>;
}

type PiToolContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

/**
 * Reads the same `{ "mcpServers": { name: { command, args, env } } }` shape used by
 * Claude Desktop and most MCP clients, from `<agentDir>/mcp-servers.json`.
 */
function loadConfig(): Record<string, McpServerConfig> {
  const configPath = path.join(env.agentDir, "mcp-servers.json");
  if (!fs.existsSync(configPath)) return {};
  const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as McpServersFile;
  return parsed.mcpServers ?? {};
}

/**
 * Connects to every configured MCP server and exposes each of its tools as a
 * pi custom tool, namespaced as `mcp_<server>_<tool>` to avoid collisions.
 */
export async function loadMcpTools() {
  const servers = Object.entries(loadConfig());
  if (servers.length === 0) return [];

  const tools: ReturnType<typeof defineTool>[] = [];

  await Promise.all(
    servers.map(async ([serverName, config]) => {
      const client = new Client({ name: "pi-desktop", version: "0.1.0" });
      const transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: { ...(process.env as Record<string, string>), ...config.env },
      });

      try {
        await client.connect(transport);
        const { tools: mcpTools } = await client.listTools();

        for (const mcpTool of mcpTools) {
          tools.push(
            defineTool({
              name: `mcp_${serverName}_${mcpTool.name}`,
              label: mcpTool.name,
              description: mcpTool.description ?? `Tool "${mcpTool.name}" from MCP server "${serverName}".`,
              parameters: Type.Unsafe(mcpTool.inputSchema ?? { type: "object", properties: {} }),
              execute: async (_toolCallId, params) => {
                const result = await client.callTool({
                  name: mcpTool.name,
                  arguments: params as Record<string, unknown>,
                });
                const rawContent = (result.content as Array<Record<string, unknown>> | undefined) ?? [];
                const content: PiToolContent[] = rawContent.map((item): PiToolContent => {
                  if (item.type === "text") return { type: "text", text: String(item.text) };
                  if (item.type === "image") {
                    return { type: "image", data: String(item.data), mimeType: String(item.mimeType) };
                  }
                  return { type: "text", text: JSON.stringify(item) };
                });
                return {
                  content: content.length ? content : [{ type: "text", text: "(empty result)" }],
                  details: result,
                };
              },
            }),
          );
        }
      } catch (error) {
        console.error(`[mcp] Failed to connect to MCP server "${serverName}":`, error);
      }
    }),
  );

  return tools;
}
