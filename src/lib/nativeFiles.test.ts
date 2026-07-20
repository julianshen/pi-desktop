import { afterEach, describe, expect, test } from "bun:test";
import { chooseChatAttachments, chooseGeneratedFileDestination, saveGeneratedFile } from "./nativeFiles.js";
import { setDesktopAnalyticsSink, type DispatchedDesktopAnalyticsEvent } from "./analytics.js";

afterEach(() => setDesktopAnalyticsSink());

describe("native file dialogs", () => {
  test("AC-4.1: attachment cancellation returns an empty list and file/image filters are present", async () => {
    let captured: Record<string, unknown> | undefined;
    const selected = await chooseChatAttachments(async (options) => {
      captured = options as unknown as Record<string, unknown>;
      return null;
    });

    expect(selected).toEqual([]);
    expect(captured).toMatchObject({ multiple: true, directory: false });
    expect(captured?.filters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Images" }),
      expect.objectContaining({ name: "Files" }),
    ]));
    expect(JSON.stringify(captured?.filters)).not.toContain("pdf");
  });

  test("AC-4.1: a single selection is normalized to an array", async () => {
    const selected = await chooseChatAttachments(async () => "/tmp/example.png");
    expect(selected).toEqual(["/tmp/example.png"]);
  });

  test("AC-4.2: save cancellation returns null and strips path components from the suggestion", async () => {
    let defaultPath: string | undefined;
    const selected = await chooseGeneratedFileDestination("../../report.md", async (options) => {
      defaultPath = options?.defaultPath;
      return null;
    });

    expect(selected).toBeNull();
    expect(defaultPath).toBe("report.md");
  });
});

describe("saveGeneratedFile", () => {
  test("AC-15.1: invokes the scoped bridge with opaque IDs and no path", async () => {
    let captured: unknown;
    const result = await saveGeneratedFile(
      { conversationId: "conversation", runId: "run", fileId: "file", name: "report.csv" },
      (async (_command: string, args?: Record<string, unknown>) => { captured = args; return { status: "saved" }; }) as never,
    );
    expect(result).toEqual({ status: "saved" });
    expect(captured).toEqual({ conversationId: "conversation", runId: "run", fileId: "file", fileName: "report.csv" });
    expect(JSON.stringify(captured)).not.toContain("path");
  });

  test("AC-15.3: preserves cancellation and converts bridge failures to typed rejection", async () => {
    const events: DispatchedDesktopAnalyticsEvent[] = [];
    setDesktopAnalyticsSink((event) => events.push(event));
    expect(await saveGeneratedFile(
      { conversationId: "c", runId: "r", fileId: "f", name: "report.txt", mediaType: "text/plain", byteSize: 12 },
      (async () => ({ status: "cancelled" })) as never,
    )).toEqual({ status: "cancelled" });
    await expect(saveGeneratedFile(
      { conversationId: "c", runId: "r", fileId: "f", name: "report.txt" },
      (async () => { throw { code: "write_failed" }; }) as never,
    )).rejects.toThrow("Generated file save failed");
    expect(events.map((event) => event.properties.outcome)).toEqual(["cancelled", "failed"]);
    expect(JSON.stringify(events)).not.toMatch(/filename|path|content/i);
  });
});
