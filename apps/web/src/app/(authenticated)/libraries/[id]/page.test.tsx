import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import LibraryDetailPage from "./page";

const mockUsePaneParam = vi.fn<(param: string) => string | null>();
const mockPush = vi.fn<(href: string) => void>();

vi.mock("@/lib/panes/paneRuntime", () => ({
  usePaneParam: (paramName: string) => mockUsePaneParam(paramName),
  usePaneRouter: () => ({ push: mockPush, replace: mockPush }),
  useSetPaneTitle: () => {},
}));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("library detail mixed-entry cutover", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockUsePaneParam.mockReset();
    mockUsePaneParam.mockImplementation((paramName) =>
      paramName === "id" ? "lib-1" : null
    );
    mockPush.mockReset();
  });

  it("renders one mixed list of podcast and media entries and removes a podcast row through the row menu", async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/libraries/lib-1" && (init?.method ?? "GET") === "GET") {
        return jsonResponse({
          data: {
            id: "lib-1",
            name: "Systems Library",
            is_default: false,
            role: "admin",
            owner_user_id: "user-1",
          },
        });
      }
      if (url.pathname === "/api/libraries/lib-1/entries" && (init?.method ?? "GET") === "GET") {
        return jsonResponse({
          data: [
            {
              id: "entry-podcast-1",
              position: 0,
              created_at: "2026-03-01T00:00:00Z",
              kind: "podcast",
              podcast: {
                id: "podcast-1",
                title: "Football Ramble",
                author: "Ramble Team",
                feed_url: "https://feeds.example.com/ramble.xml",
                website_url: "https://example.com/ramble",
                image_url: null,
                updated_at: "2026-03-01T00:00:00Z",
                subscription: {
                  status: "active",
                  sync_status: "complete",
                  unplayed_count: 4,
                },
              },
            },
            {
              id: "entry-media-1",
              position: 1,
              created_at: "2026-03-01T00:00:00Z",
              kind: "media",
              media: {
                id: "media-1",
                kind: "pdf",
                title: "Intro to systems",
                canonical_source_url: "https://example.com/systems.pdf",
                processing_status: "ready_for_reading",
                created_at: "2026-03-01T00:00:00Z",
                updated_at: "2026-03-01T00:00:00Z",
              },
            },
          ],
        });
      }
      if (url.pathname === "/api/libraries/lib-1/podcasts/podcast-1" && init?.method === "DELETE") {
        return jsonResponse({ data: { ok: true } });
      }
      throw new Error(`Unexpected fetch call: ${url.pathname}${url.search}`);
    });

    render(createElement(LibraryDetailPage));

    expect(await screen.findByText("Football Ramble")).toBeInTheDocument();
    expect(screen.getByText("Intro to systems")).toBeInTheDocument();
    expect(screen.queryByText("Podcasts")).not.toBeInTheDocument();
    expect(screen.queryByText("Items")).not.toBeInTheDocument();

    await user.click(screen.getAllByRole("button", { name: "Actions" })[0]);
    await user.click(await screen.findByRole("menuitem", { name: "Remove from library" }));

    await waitFor(() => {
      expect(confirmSpy).toHaveBeenCalledWith('Remove "Football Ramble" from the library?');
      expect(
        fetchSpy.mock.calls.some(([url, init]) => {
          const parsed = new URL(String(url), "http://localhost");
          return parsed.pathname === "/api/libraries/lib-1/podcasts/podcast-1" && init?.method === "DELETE";
        })
      ).toBe(true);
    });
  });
});
