import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { BranchPicker } from "./BranchPicker.js";

afterEach(cleanup);

describe("BranchPicker", () => {
  test("AC-8.2: exposes sibling branches and selects the requested stable id", () => {
    const onSelect = mock(() => {});
    render(<BranchPicker branches={[
      { id: "branch-a", createdAt: "2026-01-01" },
      { id: "branch-b", parentBranchId: "branch-a", sourceMessageId: "message-1", createdAt: "2026-01-02" },
    ]} activeBranchId="branch-a" onSelect={onSelect} />);

    fireEvent.change(screen.getByRole("combobox", { name: "Conversation branch" }), { target: { value: "branch-b" } });
    expect(onSelect).toHaveBeenCalledWith("branch-b");
    expect(screen.getByRole("option", { name: "Original" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Branch 2" })).toBeTruthy();
  });
});
