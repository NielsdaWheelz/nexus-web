import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CommandPalette from "@/components/CommandPalette";
import { OPEN_COMMAND_PALETTE_EVENT } from "@/components/commandPaletteEvents";
import { WorkspaceStoreProvider } from "@/lib/workspace/store";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function setViewportWidth(width: number) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: width,
    writable: true,
  });
  window.dispatchEvent(new Event("resize"));
}

function renderCommandPalette() {
  render(
    <WorkspaceStoreProvider>
      <div data-testid="workspace-ready" />
      <CommandPalette />
    </WorkspaceStoreProvider>
  );
}

function openPalette() {
  act(() => {
    window.dispatchEvent(new CustomEvent(OPEN_COMMAND_PALETTE_EVENT));
  });
}

describe("CommandPalette", () => {
  const originalInnerWidth = window.innerWidth;
  const originalPath = window.location.pathname;

  beforeEach(() => {
    setViewportWidth(640);
    document.body.style.overflow = "";
    localStorage.clear();
    window.history.replaceState({}, "", "/libraries");
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/me/command-palette-recents" && (init?.method ?? "GET") === "GET") {
        return jsonResponse({ data: [] });
      }
      if (url.pathname === "/api/me/command-palette-recents" && init?.method === "POST") {
        return jsonResponse({ data: null });
      }
      if (url.pathname === "/api/search") {
        return jsonResponse({ results: [], page: { has_more: false, next_cursor: null } });
      }
      throw new Error(`Unexpected fetch call: ${url.pathname}`);
    });
  });

  afterEach(() => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: originalInnerWidth,
      writable: true,
    });
    document.body.style.overflow = "";
    localStorage.clear();
    window.history.replaceState({}, "", originalPath);
    vi.restoreAllMocks();
  });

  it("opens from the mobile launcher event and shows the real mobile sheet", async () => {
    renderCommandPalette();

    expect(await screen.findByTestId("workspace-ready")).toBeInTheDocument();

    openPalette();

    expect(await screen.findByRole("dialog", { name: "Search" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Search" })).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Search or run an action...")).toBeInTheDocument();
    expect(screen.getByLabelText(/^Close$/)).toBeInTheDocument();
    expect(screen.getByText("Navigate")).toBeInTheDocument();
    expect(screen.getByText("Browse")).toBeInTheDocument();
    expect(screen.getByText("Chats")).toBeInTheDocument();
  });

  it("shows API-backed recent destinations alongside the static command groups", async () => {
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/me/command-palette-recents" && (init?.method ?? "GET") === "GET") {
        return jsonResponse({
          data: [
            {
              href: "/media/media-1",
              title_snapshot: "Deep Work",
              last_used_at: "2026-04-17T12:00:00Z",
            },
          ],
        });
      }
      if (url.pathname === "/api/me/command-palette-recents" && init?.method === "POST") {
        return jsonResponse({ data: null });
      }
      if (url.pathname === "/api/search") {
        return jsonResponse({ results: [], page: { has_more: false, next_cursor: null } });
      }
      throw new Error(`Unexpected fetch call: ${url.pathname}`);
    });

    renderCommandPalette();

    expect(await screen.findByTestId("workspace-ready")).toBeInTheDocument();

    openPalette();

    expect(await screen.findByText("Recent")).toBeInTheDocument();
    expect(screen.getByText("Deep Work")).toBeInTheDocument();
    expect(screen.getByText("Navigate")).toBeInTheDocument();
    expect(screen.getByText("Browse")).toBeInTheDocument();
  });
});
