import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import MediaCatalogPage from "./MediaCatalogPage";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("media catalog action menu cutover", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("shows default-library add/remove and source actions without legacy delete", async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/media") {
        return jsonResponse({
          data: [
            {
              id: "media-a",
              kind: "pdf",
              title: "In library with source",
              canonical_source_url: "https://example.com/source-a",
              processing_status: "ready_for_reading",
              created_at: "2026-03-01T00:00:00Z",
              updated_at: "2026-03-01T00:00:00Z",
            },
            {
              id: "media-b",
              kind: "pdf",
              title: "Outside library",
              canonical_source_url: null,
              processing_status: "ready_for_reading",
              created_at: "2026-03-01T00:00:00Z",
              updated_at: "2026-03-01T00:00:00Z",
            },
          ],
          page: { next_cursor: null },
        });
      }
      if (url.pathname === "/api/me") {
        return jsonResponse({
          data: {
            user_id: "user-1",
            default_library_id: "library-1",
          },
        });
      }
      if (url.pathname === "/api/libraries/library-1/media" && (init?.method ?? "GET") === "GET") {
        return jsonResponse({
          data: [{ id: "media-a" }],
        });
      }
      if (url.pathname === "/api/libraries/library-1/media/media-a" && init?.method === "DELETE") {
        return jsonResponse({ data: { ok: true } });
      }
      if (url.pathname === "/api/libraries/library-1/media" && init?.method === "POST") {
        return jsonResponse({ data: { ok: true } });
      }
      throw new Error(`Unexpected fetch call: ${url.pathname}${url.search}`);
    });

    render(
      <MediaCatalogPage
        title="Documents"
        allowedKinds={["pdf"]}
        emptyMessage="No docs"
      />
    );

    const inLibraryRow = (await screen.findByText("In library with source")).closest("li");
    const outsideLibraryRow = screen.getByText("Outside library").closest("li");
    expect(inLibraryRow).not.toBeNull();
    expect(outsideLibraryRow).not.toBeNull();

    await user.click(within(inLibraryRow as HTMLElement).getByRole("button", { name: "Actions" }));
    expect(await screen.findByRole("menuitem", { name: "Remove from library" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Open source" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Delete" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("menuitem", { name: "Remove from library" }));
    await waitFor(() => {
      expect(
        fetchSpy.mock.calls.some(([url, init]) => {
          const parsed = new URL(String(url), "http://localhost");
          return parsed.pathname === "/api/libraries/library-1/media/media-a" && init?.method === "DELETE";
        })
      ).toBe(true);
    });

    await user.click(within(outsideLibraryRow as HTMLElement).getByRole("button", { name: "Actions" }));
    await user.click(await screen.findByRole("menuitem", { name: "Add to library" }));
    await waitFor(() => {
      expect(
        fetchSpy.mock.calls.some(([url, init]) => {
          const parsed = new URL(String(url), "http://localhost");
          return parsed.pathname === "/api/libraries/library-1/media" && init?.method === "POST";
        })
      ).toBe(true);
      expect(
        fetchSpy.mock.calls.some(([url, init]) => {
          const parsed = new URL(String(url), "http://localhost");
          return parsed.pathname.startsWith("/api/media/") && init?.method === "DELETE";
        })
      ).toBe(false);
    });
  });

  it("hides row menus when a row has no meaningful actions", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/media") {
        return jsonResponse({
          data: [
            {
              id: "media-x",
              kind: "pdf",
              title: "No action row",
              canonical_source_url: null,
              processing_status: "ready_for_reading",
              created_at: "2026-03-01T00:00:00Z",
              updated_at: "2026-03-01T00:00:00Z",
            },
          ],
          page: { next_cursor: null },
        });
      }
      if (url.pathname === "/api/me") {
        return jsonResponse({
          data: {
            user_id: "user-1",
            default_library_id: null,
          },
        });
      }
      if (url.pathname === "/api/libraries/library-1/media" && (init?.method ?? "GET") === "GET") {
        return jsonResponse({ data: [] });
      }
      throw new Error(`Unexpected fetch call: ${url.pathname}${url.search}`);
    });

    render(
      <MediaCatalogPage
        title="Documents"
        allowedKinds={["pdf"]}
        emptyMessage="No docs"
      />
    );

    expect(await screen.findByText("No action row")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Actions" })).not.toBeInTheDocument();
  });
});
