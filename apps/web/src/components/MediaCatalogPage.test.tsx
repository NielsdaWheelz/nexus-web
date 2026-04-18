import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import MediaCatalogPage from "./MediaCatalogPage";

vi.mock("@/lib/panes/openInAppPane", () => ({
  requestOpenInAppPane: () => false,
}));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("media catalog item-action cutover", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps library membership in the libraries picker and secondary actions in the row menu", async () => {
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
      if (url.pathname === "/api/media/media-a/libraries" && (init?.method ?? "GET") === "GET") {
        return jsonResponse({
          data: [
            {
              id: "library-sports",
              name: "Sports",
              color: null,
              is_in_library: true,
              can_add: false,
              can_remove: true,
            },
            {
              id: "library-history",
              name: "History",
              color: null,
              is_in_library: false,
              can_add: true,
              can_remove: false,
            },
          ],
        });
      }
      if (url.pathname === "/api/media/media-b/libraries" && (init?.method ?? "GET") === "GET") {
        return jsonResponse({
          data: [
            {
              id: "library-sports",
              name: "Sports",
              color: null,
              is_in_library: false,
              can_add: true,
              can_remove: false,
            },
            {
              id: "library-history",
              name: "History",
              color: null,
              is_in_library: false,
              can_add: true,
              can_remove: false,
            },
          ],
        });
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

    const librariesButtons = screen.getAllByRole("button", { name: "Libraries" });
    expect(librariesButtons).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Actions" })).toHaveLength(1);

    await user.click(librariesButtons[0]);
    const firstLibrariesDialog = await screen.findByRole("dialog", { name: "Libraries" });
    expect(
      await within(firstLibrariesDialog).findByRole("button", { name: /Sports/i })
    ).toBeInTheDocument();
    expect(
      within(firstLibrariesDialog).getByRole("button", { name: /History/i })
    ).toBeInTheDocument();

    await user.click(within(firstLibrariesDialog).getByRole("button", { name: /Sports/i }));
    await waitFor(() => {
      expect(
        fetchSpy.mock.calls.some(([url, init]) => {
          const parsed = new URL(String(url), "http://localhost");
          return parsed.pathname === "/api/libraries/library-sports/media/media-a" && init?.method === "DELETE";
        })
      ).toBe(true);
    });

    await user.click(librariesButtons[1]);
    const secondLibrariesDialog = await screen.findByRole("dialog", { name: "Libraries" });
    await user.click(within(secondLibrariesDialog).getByRole("button", { name: /History/i }));
    await waitFor(() => {
      expect(
        fetchSpy.mock.calls.some(([url, init]) => {
          const parsed = new URL(String(url), "http://localhost");
          return parsed.pathname === "/api/libraries/library-history/media" && init?.method === "POST";
        })
      ).toBe(true);
    });

    await user.click(screen.getByRole("button", { name: "Actions" }));
    expect(await screen.findByRole("menuitem", { name: "Open source" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /Sports/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /History/i })).not.toBeInTheDocument();
  });
});
