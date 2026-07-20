import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { GeneratedFile } from "./GeneratedFile.js";
afterEach(cleanup);
describe("GeneratedFile", () => {
  test("AC-14.3: available saves through opaque ID and exposes saved state without paths", async () => {
    const onSave = mock(() => Promise.resolve());
    const { container } = render(<GeneratedFile file={{ id: "opaque-file", name: "report.csv", mediaType: "text/csv", byteSize: 12, state: "available" }} onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: "Save report.csv" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("saved"));
    expect(onSave).toHaveBeenCalledWith("opaque-file");
    expect(container.textContent).not.toMatch(/[/\\](Users|tmp|home)[/\\]/);
  });
  test("missing has no save action; failure exposes retry", async () => {
    const missing = render(<GeneratedFile file={{ id: "missing", name: "gone.zip", mediaType: "application/zip", byteSize: 0, state: "missing" }} onSave={() => Promise.resolve()} />);
    expect(screen.queryByRole("button", { name: /Save gone/ })).toBeNull(); missing.unmount();
    render(<GeneratedFile file={{ id: "failed", name: "retry.txt", mediaType: "text/plain", byteSize: 2, state: "available" }} onSave={() => Promise.reject(new Error("disk"))} />);
    fireEvent.click(screen.getByRole("button", { name: "Save retry.txt" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Retry saving retry.txt" })).toBeTruthy());
  });
  test("native cancellation returns to available instead of claiming the file was saved", async () => {
    render(<GeneratedFile file={{ id: "cancel", name: "report.txt", mediaType: "text/plain", byteSize: 2, state: "available" }} onSave={() => Promise.resolve("cancelled")} />);
    fireEvent.click(screen.getByRole("button", { name: "Save report.txt" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("available"));
  });
  test("external file state updates replace stale local state", () => {
    const file = { id: "sync", name: "sync.txt", mediaType: "text/plain", byteSize: 2, state: "available" as const };
    const { rerender } = render(<GeneratedFile file={file} onSave={() => Promise.resolve()} />);
    expect(screen.getByRole("status").textContent).toBe("available");

    rerender(<GeneratedFile file={{ ...file, state: "missing" }} onSave={() => Promise.resolve()} />);

    expect(screen.getByRole("status").textContent).toBe("missing");
    expect(screen.queryByRole("button", { name: "Save sync.txt" })).toBeNull();
  });
});
