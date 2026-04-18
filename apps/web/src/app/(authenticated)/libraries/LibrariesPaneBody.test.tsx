import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import LibrariesPaneBody from "./LibrariesPaneBody";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("LibrariesPaneBody", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the libraries list without duplicating the pane chrome header", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/libraries") {
        return jsonResponse({
          data: [
            {
              id: "default-lib",
              name: "My Library",
              owner_user_id: "user-1",
              is_default: true,
              role: "admin",
              created_at: "2026-03-01T00:00:00Z",
              updated_at: "2026-03-01T00:00:00Z",
            },
            {
              id: "lib-2",
              name: "Systems Library",
              owner_user_id: "user-1",
              is_default: false,
              role: "editor",
              created_at: "2026-03-01T00:00:00Z",
              updated_at: "2026-03-01T00:00:00Z",
            },
          ],
        });
      }
      throw new Error(`Unexpected fetch call: ${url.pathname}${url.search}`);
    });

    render(<LibrariesPaneBody />);

    expect(await screen.findByText("My Library")).toBeInTheDocument();
    expect(screen.getByText("Systems Library")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Libraries" })).not.toBeInTheDocument();
    expect(
      screen.queryByText("Mixed collections for podcasts and media.")
    ).not.toBeInTheDocument();
  });
});
