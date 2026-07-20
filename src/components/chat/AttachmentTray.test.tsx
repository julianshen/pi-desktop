import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AttachmentTray } from "./AttachmentTray.js";
import type { AttachmentView } from "../../state/attachmentDrafts.js";

afterEach(cleanup);

describe("AttachmentTray", () => {
  test("AC-6.1: renders accessible metadata, status, local-only disclosure, preview, and remove", () => {
    const onRemove = mock(() => {});
    const attachment: AttachmentView = {
      id: "opaque-1",
      name: "diagram.png",
      mediaType: "image/png",
      byteSize: 1536,
      state: "ready",
      disclosure: "local_only",
    };

    render(<AttachmentTray attachments={[attachment]} onRemove={onRemove} />);

    expect(screen.getByRole("list", { name: "Staged attachments" })).toBeTruthy();
    expect(screen.getByText("diagram.png")).toBeTruthy();
    expect(screen.getByText("image/png · 1.5 KiB")).toBeTruthy();
    expect(screen.getByText("Ready")).toBeTruthy();
    expect(screen.getByText("Local only until sent")).toBeTruthy();
    expect(screen.getByLabelText("Image attachment")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Remove diagram.png" }));
    expect(onRemove).toHaveBeenCalledWith("opaque-1");
  });

  test("renders filename-specific failure and recovery action", () => {
    const onRetry = mock(() => {});
    render(
      <AttachmentTray
        attachments={[{
          id: "pending-1",
          name: "broken.pdf",
          mediaType: "application/pdf",
          byteSize: 0,
          state: "rejected",
          disclosure: "local_only",
          error: "Unsupported or invalid file",
        }]}
        onRemove={() => {}}
        onRetry={onRetry}
      />,
    );

    expect(screen.getByText("broken.pdf: Unsupported or invalid file")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Choose files again" }));
    expect(onRetry).toHaveBeenCalled();
  });
});
