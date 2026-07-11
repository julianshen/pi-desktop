import fs from "node:fs";
import path from "node:path";
import { Database } from "bun:sqlite";
import { env } from "../config/env.js";

export interface MemoryRecord {
  id: number;
  text: string;
  createdAt: string;
  distance: number;
}

let db: Database | undefined;

function getDb(): Database {
  if (db) return db;
  fs.mkdirSync(env.dataDir, { recursive: true });
  db = new Database(path.join(env.dataDir, "memory.sqlite3"));
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL,
      embedding BLOB NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

function toBlob(embedding: Float32Array): Uint8Array {
  return new Uint8Array(embedding.buffer, embedding.byteOffset, embedding.byteLength);
}

function fromBlob(blob: Uint8Array): Float32Array {
  return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / Float32Array.BYTES_PER_ELEMENT);
}

function cosineDistance(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 1;
  return 1 - dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function insertMemory(text: string, embedding: Float32Array): number {
  const { lastInsertRowid } = getDb()
    .prepare("INSERT INTO memories (text, embedding) VALUES (?, ?)")
    .run(text, toBlob(embedding));
  return Number(lastInsertRowid);
}

/**
 * Local desktop memory stores are small enough (hundreds to low thousands of
 * entries) that a brute-force in-process cosine scan beats depending on a native
 * SQLite vector-search extension, which Bun's bundled sqlite3 can't dynamically load.
 */
export function searchMemories(embedding: Float32Array, topK: number): MemoryRecord[] {
  const rows = getDb()
    .query("SELECT id, text, embedding, created_at AS createdAt FROM memories")
    .all() as Array<{ id: number; text: string; embedding: Uint8Array; createdAt: string }>;

  return rows
    .map((row) => ({
      id: row.id,
      text: row.text,
      createdAt: row.createdAt,
      distance: cosineDistance(embedding, fromBlob(row.embedding)),
    }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, topK);
}
