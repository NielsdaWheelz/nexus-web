import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import MediaCatalogPage from "./MediaCatalogPage";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("media catalog library actions", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("offers explicit add/remove actions for each non-default library", async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/media") {
        return jsonResponse({
          data: [
            {
              id: "media-a",
              kind: "pdf",
              title: "In sports library",
              canonical_source_url: "https://example.com/source-a",
              processing_status: "ready_for_reading",
              created_at: "2026-03-01T00:00:00Z",
              updated_at: "2026-03-01T00:00:00Z",
            },
            {
              id: "media-b",
              kind: "pdf",
              title: "Outside every library",
              canonical_source_url: null,
              processing_status: "ready_for_reading",
              created_at: "2026-03-01T00:00:00Z",
              updated_at: "2026-03-01T00:00:00Z",
            },
          ],
          page: { next_cursor: null },
        });
      }
      if (url.pathname === "/api/libraries" && (init?.method ?? "GET") === "GET") {
        return jsonResponse({
          data: [
            { id: "library-default", name: "Default", is_default: true },
            { id: "library-sports", name: "Sports", is_default: false },
            { id: "library-history", name: "History", is_default: false },
          ],
        });
      }
      if (url.pathname === "/api/libraries/library-sports/entries" && (init?.method ?? "GET") === "GET") {
        return jsonResponse({
          data: [{ kind: "media", media: { id: "media-a" } }],
        });
      }
      if (url.pathname === "/api/libraries/library-history/entries" && (init?.method ?? "GET") === "GET") {
        return jsonResponse({ data: [] });
      }
      if (url.pathname === "/api/libraries/library-sports/media/media-a" && init?.method === "DELETE") {
        return jsonResponse({ data: { ok: true } });
      }
      if (url.pathname === "/api/libraries/library-history/media" && init?.method === "POST") {
        return jsonResponse({ data: { ok: true } });
      }
      throw new Error(`Unexpected fetch call: ${url.pathname}${url.search}`);
    });

    render(
      createElement(MediaCatalogPage, {
        title: "Documents",
        allowedKinds: ["pdf"],
        emptyMessage: "No docs",
      })
    );

    expect(await screen.findByText("In sports library")).toBeInTheDocument();
    expect(screen.getByText("Outside every library")).toBeInTheDocument();

    const actionButtons = screen.getAllByRole("button", { name: "Actions" });
    expect(actionButtons).toHaveLength(2);

    await user.click(actionButtons[0]);
    expect(await screen.findByRole("menuitem", { name: "Remove from Sports" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Add to History" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Open source" })).toBeInTheDocument();

    await user.click(screen.getByRole("menuitem", { name: "Remove from Sports" }));
    await waitFor(() => {
      expect(
        fetchSpy.mock.calls.some(([url, init]) => {
          const parsed = new URL(String(url), "http://localhost");
          return parsed.pathname === "/api/libraries/library-sports/media/media-a" && init?.method === "DELETE";
        })
      ).toBe(true);
    });

    await user.click(actionButtons[1]);
    await user.click(await screen.findByRole("menuitem", { name: "Add to History" }));
    await waitFor(() => {
      expect(
        fetchSpy.mock.calls.some(([url, init]) => {
          const parsed = new URL(String(url), "http://localhost");
          return parsed.pathname === "/api/libraries/library-history/media" && init?.method === "POST";
        })
      ).toBe(true);
    });
  });
});
