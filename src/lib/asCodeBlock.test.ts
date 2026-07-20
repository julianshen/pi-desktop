import { describe, expect, test } from "bun:test";
import { wrapAsFencedCodeBlock } from "./asCodeBlock.js";

/**
 * AC-10.1 (Task 10, assistant-ui-migration): dynamic-fence-length wrapping —
 * the fence must always be strictly longer than any run of consecutive
 * backticks in the content, with a minimum of 3 (CommonMark's own fencing
 * safety rule). Ported verbatim from `markdown-rendering/SPEC.md`'s
 * Architecture point 4.
 */
describe("wrapAsFencedCodeBlock", () => {
  test("code with no backticks fences at the minimum of 3", () => {
    const result = wrapAsFencedCodeBlock("const x = 1;", "ts");
    expect(result).toBe("```ts\nconst x = 1;\n```");
  });

  test("empty string is handled without throwing, fencing at the minimum of 3", () => {
    const result = wrapAsFencedCodeBlock("", "text");
    expect(result).toBe("```text\n\n```");
  });

  test("a single backtick still fences at the minimum of 3 (1 + 1 = 2, clamped up to 3)", () => {
    const result = wrapAsFencedCodeBlock("let s = `hi`;", "js");
    expect(result).toBe("```js\nlet s = `hi`;\n```");
  });

  test("a run of 3 consecutive backticks fences at 4", () => {
    const code = "some code with ``` inside it";
    const result = wrapAsFencedCodeBlock(code, "md");
    expect(result).toBe(`\`\`\`\`md\n${code}\n\`\`\`\``);
    // The fence must not itself appear anywhere inside the wrapped content's code portion
    // in a way that could prematurely close it: the 3-backtick run is strictly shorter
    // than the 4-backtick fence.
    expect(result.startsWith("````")).toBe(true);
    expect(result.endsWith("````")).toBe(true);
  });

  test("a run of 5 consecutive backticks fences at 6", () => {
    const code = "````` five in a row";
    const result = wrapAsFencedCodeBlock(code, "md");
    expect(result).toBe(`\`\`\`\`\`\`md\n${code}\n\`\`\`\`\`\``);
    expect(result.startsWith("``````")).toBe(true);
  });

  test("multiple separate runs of different lengths use the longest run, not the sum", () => {
    // Two separate runs: 2 backticks, then later 4 backticks. Longest is 4, so fence is 5 —
    // NOT 2+4=6, and not the last-seen run (2).
    const code = "first `` run, later ```` run";
    const result = wrapAsFencedCodeBlock(code, "text");
    const fence = "`".repeat(5);
    expect(result).toBe(`${fence}text\n${code}\n${fence}`);
  });

  test("backticks at the very start of the content are detected", () => {
    const code = "```leading fence-like text";
    const result = wrapAsFencedCodeBlock(code, "text");
    expect(result.startsWith("````text")).toBe(true);
  });

  test("backticks at the very end of the content are detected", () => {
    const code = "trailing fence-like text````";
    const result = wrapAsFencedCodeBlock(code, "text");
    const fence = "`".repeat(5);
    expect(result).toBe(`${fence}text\n${code}\n${fence}`);
  });

  test("the fence is always strictly longer than any backtick run inside the content", () => {
    const cases = ["", "`", "``", "```", "````", "`````", "``````"];
    for (const code of cases) {
      const wrapped = wrapAsFencedCodeBlock(code, "text");
      const longestRunInCode = (code.match(/`+/g) ?? []).reduce((m, r) => Math.max(m, r.length), 0);
      const fenceMatch = wrapped.match(/^`+/);
      const fenceLength = fenceMatch ? fenceMatch[0].length : 0;
      expect(fenceLength).toBeGreaterThan(longestRunInCode);
      expect(fenceLength).toBeGreaterThanOrEqual(3);
    }
  });

  test("applies the language tag immediately after the opening fence with no space", () => {
    const result = wrapAsFencedCodeBlock("print(1)", "python");
    expect(result.startsWith("```python\n")).toBe(true);
  });
});
