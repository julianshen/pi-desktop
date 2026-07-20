import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChatWorkspaceStore } from "./store.js";

const roots: string[] = [];

function fixture(entries: unknown[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-workspace-store-"));
  roots.push(root);
  const dataDir = path.join(root, "data");
  const legacyPath = path.join(dataDir, "conversations", "index.json");
  fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
  fs.writeFileSync(legacyPath, JSON.stringify(entries, null, 2));
  return { dataDir, legacyPath, databasePath: path.join(dataDir, "chat-workspace.sqlite3") };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("ChatWorkspaceStore migration", () => {
  test("AC-1.1: opening twice imports default and UUID metadata exactly once", () => {
    const entries = [
      {
        id: "default",
        title: "Existing default",
        modelId: "anthropic/one",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-03T00:00:00.000Z",
      },
      {
        id: "2a1ed3fc-92eb-4bad-a613-933239cebb6f",
        title: "Older UUID",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
    ];
    const paths = fixture(entries);

    const first = new ChatWorkspaceStore(paths);
    expect(first.listConversations()).toEqual(entries);
    first.close();

    const second = new ChatWorkspaceStore(paths);
    expect(second.listConversations()).toEqual(entries);
    expect(second.migrationVersions()).toEqual([1]);
    second.close();
  });

  test("AC-1.3: a failed import rolls back rows and migration marker without changing legacy JSON", () => {
    const entries = [
      {
        id: "default",
        title: "Existing default",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-03T00:00:00.000Z",
      },
      {
        id: "duplicate",
        title: "One",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
    ];
    const paths = fixture(entries);
    const original = fs.readFileSync(paths.legacyPath, "utf8");

    expect(
      () => new ChatWorkspaceStore({ ...paths, migrationFault: "after-first-legacy-row" }),
    ).toThrow("Forced migration failure");

    expect(fs.readFileSync(paths.legacyPath, "utf8")).toBe(original);
    const store = new ChatWorkspaceStore({ ...paths, skipLegacyImport: true });
    expect(store.listConversations()).toEqual([]);
    expect(store.migrationVersions()).toEqual([1]);
    store.close();
  });
});
