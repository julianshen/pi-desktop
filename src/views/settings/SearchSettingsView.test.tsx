import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SearchSettingsView } from "./SearchSettingsView.js";

const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; cleanup(); });

test("Brave-first search is configurable without displaying the stored key", async () => {
  const requests: Array<Record<string, unknown>> = [];
  global.fetch = mock((_url: string, init?: RequestInit) => {
    if (!init) return Promise.resolve(new Response(JSON.stringify({ enabled: false, provider: "brave", keyPresent: true, maxResults: 5 })));
    requests.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    return Promise.resolve(new Response(JSON.stringify({ enabled: true, provider: "brave", keyPresent: true, maxResults: 5 })));
  }) as unknown as typeof fetch;
  render(<SearchSettingsView />);
  await waitFor(() => expect(screen.getByText("Brave credentials configured")).toBeTruthy());
  expect(document.body.textContent).not.toContain("stored-secret");
  fireEvent.click(screen.getByLabelText("Enable automatic web search"));
  fireEvent.change(screen.getByLabelText("Brave Search API key"), { target: { value: "replacement-secret" } });
  fireEvent.click(screen.getByRole("button", { name: "Save search settings" }));
  await waitFor(() => expect(requests).toHaveLength(1));
  expect(requests[0]).toEqual({ enabled: true, provider: "brave", maxResults: 5, apiKey: "replacement-secret" });
  expect(screen.getByLabelText("Brave Search API key").getAttribute("type")).toBe("password");
});
