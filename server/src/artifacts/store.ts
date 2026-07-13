import fs from "node:fs";
import path from "node:path";
import { conversationCwd } from "../agent/conversations.js";

export interface Artifact {
  id: string;
  title: string;
  language: string;
  code: string;
  publishedAt: string;
}

function artifactsPath(conversationId: string): string {
  return path.join(conversationCwd(conversationId), "artifacts.json");
}

function readArtifacts(conversationId: string): Artifact[] {
  const file = artifactsPath(conversationId);
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, "utf8")) as Artifact[];
}

function writeArtifacts(conversationId: string, entries: Artifact[]): void {
  const file = artifactsPath(conversationId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(entries, null, 2));
}

/**
 * Id-keyed upsert, no versioning (PRD non-goal): re-publishing an artifact whose id
 * already exists overwrites that entry in place. It never appends a duplicate and
 * never keeps prior revisions around.
 */
export function saveArtifact(conversationId: string, artifact: Artifact): void {
  const entries = readArtifacts(conversationId);
  const index = entries.findIndex((entry) => entry.id === artifact.id);
  if (index === -1) {
    entries.push(artifact);
  } else {
    entries[index] = artifact;
  }
  writeArtifacts(conversationId, entries);
}

/**
 * "Latest" means most recently published (max publishedAt), not array-insertion
 * order — saveArtifact() overwrites a re-published id in place rather than moving
 * it to the end of the array, so insertion order alone wouldn't reflect recency.
 */
export function getLatestArtifact(conversationId: string): Artifact | undefined {
  const entries = readArtifacts(conversationId);
  if (entries.length === 0) return undefined;
  return entries.reduce((latest, entry) => (entry.publishedAt > latest.publishedAt ? entry : latest));
}
