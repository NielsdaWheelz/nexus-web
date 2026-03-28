import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

describe("library detail action menu cutover", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockUsePaneParam.mockReset();
    mockUsePaneParam.mockImplementation((paramName) =>
      paramName === "id" ? "lib-1" : null
    );
    mockPush.mockReset();
  });

  it("uses a row action menu for remove-from-library and drops the lone remove button", async () => {
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
      if (url.pathname === "/api/libraries/lib-1/media" && (init?.method ?? "GET") === "GET") {
        return jsonResponse({
          data: [
            {
              id: "media-1",
              kind: "pdf",
              title: "Intro to systems",
              canonical_source_url: "https://example.com/systems.pdf",
              processing_status: "ready_for_reading",
              created_at: "2026-03-01T00:00:00Z",
              updated_at: "2026-03-01T00:00:00Z",
            },
          ],
        });
      }
      if (url.pathname === "/api/libraries/lib-1/media/media-1" && init?.method === "DELETE") {
        return jsonResponse({ data: { ok: true } });
      }
      throw new Error(`Unexpected fetch call: ${url.pathname}${url.search}`);
    });

    render(<LibraryDetailPage />);

    expect(await screen.findByText("Intro to systems")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Actions" }));
    await user.click(await screen.findByRole("menuitem", { name: "Remove from library" }));

    await waitFor(() => {
      expect(confirmSpy).toHaveBeenCalledWith("Remove this media from the library?");
      expect(
        fetchSpy.mock.calls.some(([url, init]) => {
          const parsed = new URL(String(url), "http://localhost");
          return parsed.pathname === "/api/libraries/lib-1/media/media-1" && init?.method === "DELETE";
        })
      ).toBe(true);
    });
  });
});
