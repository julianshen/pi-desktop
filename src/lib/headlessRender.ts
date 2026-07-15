import { invoke } from "@tauri-apps/api/core";

/**
 * Task 10 (SPEC.md's "Headless render bridge (Rust + frontend)" section):
 * thin wrapper around the `render_url_headless` Tauri command
 * (`src-tauri/src/web_fetch.rs`), which renders `url` in a hidden webview and
 * returns the fully-settled `document.documentElement.outerHTML`, or an
 * `Err` if it never signals completion within `timeoutMs`.
 *
 * The command's signature (`invoke("render_url_headless", { url, timeoutMs })`)
 * is all this file depends on — the Rust module's internal per-call-unique
 * completion-event naming (see that file's own doc comments) is fully
 * encapsulated behind the command's `Promise<string>` and irrelevant here.
 *
 * Per SPEC.md's "honest fallback" principle (and AC-10.2): this function must
 * NEVER throw out to its caller. A failed or timed-out render is an expected,
 * ordinary outcome here — App.tsx's watcher effect needs a definite
 * `string | null` back either way so it can always resolve the waiting
 * pending interaction (POSTing `{ html: null }` on failure) rather than
 * leaving the waiting `web_fetch` tool call to hang until its own internal
 * timeout.
 */
export async function renderUrlHeadless(url: string, timeoutMs: number): Promise<string | null> {
  try {
    return await invoke<string>("render_url_headless", { url, timeoutMs });
  } catch (error: unknown) {
    console.error("[headlessRender] render_url_headless failed, falling back to null", error);
    return null;
  }
}
