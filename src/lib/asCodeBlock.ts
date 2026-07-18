/**
 * Task 10 (assistant-ui-migration): dynamic-fence-length code wrapping, ported
 * verbatim from `markdown-rendering/SPEC.md`'s Architecture point 4 (this
 * feature's original design, before it was folded into the assistant-ui
 * migration). Used by `ArtifactCanvas.tsx`'s Code tab so that `artifact.code`
 * is always rendered as exactly one syntax-highlighted code block, never
 * reinterpreted as markdown prose (a Python `#` comment or a markdown
 * artifact's own `#` heading must never become an `<h1>`).
 *
 * Mechanism: find the longest run of consecutive backticks anywhere in the
 * source, then fence with one more backtick than that (minimum 3 — standard
 * CommonMark fencing-safety rule: a fence must be at least 3 characters and
 * strictly longer than any backtick run in the content, or the content could
 * prematurely close it). This is the primary safety mechanism; `ArtifactCanvas.tsx`
 * additionally passes `allowedElements={["pre", "code"]}` to Streamdown as
 * defense-in-depth, not as a substitute for this.
 */
export function wrapAsFencedCodeBlock(code: string, language: string): string {
  const backtickRuns = code.match(/`+/g) ?? [];
  const longestRun = backtickRuns.reduce((longest, run) => Math.max(longest, run.length), 0);
  const fenceLength = Math.max(longestRun + 1, 3);
  const fence = "`".repeat(fenceLength);
  return `${fence}${language}\n${code}\n${fence}`;
}
