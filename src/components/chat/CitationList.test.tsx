import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CitationList } from "./CitationList.js";
afterEach(cleanup);
describe("CitationList", () => {
  test("AC-14.2: shows typed metadata and requires confirmation before external navigation", () => {
    const onOpen = mock(() => {});
    render(<CitationList citations={[{ id: "c1", title: "Primary evidence", url: "https://example.com/report", source: "Brave Search" }]} onOpen={onOpen} />);
    fireEvent.click(screen.getByRole("button", { name: /Primary evidence/ }));
    expect(onOpen).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Open external source" }).textContent).toContain("https://example.com/report");
    fireEvent.click(screen.getByRole("button", { name: "Open source" }));
    expect(onOpen).toHaveBeenCalledWith("https://example.com/report");
  });
});
