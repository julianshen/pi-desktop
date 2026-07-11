import os from "node:os";
import path from "node:path";

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const env = {
  port: int("PI_DESKTOP_PORT", 4319),
  host: process.env.PI_DESKTOP_HOST ?? "127.0.0.1",
  agentDir: process.env.PI_DESKTOP_AGENT_DIR ?? path.join(os.homedir(), ".pi-desktop"),
  dataDir: process.env.PI_DESKTOP_DATA_DIR ?? path.join(os.homedir(), ".pi-desktop", "data"),
  workspaceDir: process.env.PI_DESKTOP_WORKSPACE_DIR ?? path.join(os.homedir(), ".pi-desktop", "workspace"),
  /** e.g. "anthropic/claude-opus-4-5" — parsed by resolveCliModel(), same as pi's --model flag. */
  modelSpec: process.env.PI_DESKTOP_MODEL,
};
