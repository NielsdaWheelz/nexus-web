import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CommandPalette from "@/components/CommandPalette";
import { OPEN_COMMAND_PALETTE_EVENT } from "@/components/commandPaletteEvents";
import { NEXUS_OPEN_PANE_EVENT } from "@/lib/panes/openInAppPane";
import { WORKSPACE_SCHEMA_VERSION } from "@/lib/workspace/schema";
import { WorkspaceStoreProvider } from "@/lib/workspace/store";
import { encodeWorkspaceStateParam } from "@/lib/workspace/urlCodec";

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

function mockApi({
  recents = [],
  searchResults = [],
}: {
  recents?: unknown[];
  searchResults?: unknown[];
} = {}) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/me/command-palette-recents" && (init?.method ?? "GET") === "GET") {
      return jsonResponse({ data: recents });
    }
    if (url.pathname === "/api/me/command-palette-recents" && init?.method === "POST") {
      return jsonResponse({ data: null });
    }
    if (url.pathname === "/api/search") {
      return jsonResponse({ results: searchResults, page: { has_more: false, next_cursor: null } });
    }
    if (url.pathname === "/api/notes/pages" && init?.method === "POST") {
      return jsonResponse({
        data: {
          id: "page-created",
          title: "Untitled",
          description: null,
          blocks: [],
        },
      });
    }
    throw new Error(`Unexpected fetch call: ${url.pathname}`);
  });
}

function openPalette() {
  act(() => {
    window.dispatchEvent(new CustomEvent(OPEN_COMMAND_PALETTE_EVENT));
  });
}

function openPane(href: string, titleHint?: string) {
  act(() => {
    window.dispatchEvent(
      new CustomEvent(NEXUS_OPEN_PANE_EVENT, {
        detail: { href, titleHint },
      })
    );
  });
}

function setMinimizedWorkspaceUrl() {
  const encoded = encodeWorkspaceStateParam({
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    activePaneId: "pane-libraries",
    panes: [
      {
        id: "pane-libraries",
        href: "/libraries",
        widthPx: 480,
        visibility: "visible",
      },
      {
        id: "pane-minimized",
        href: "/media/media-1",
        widthPx: 480,
        visibility: "minimized",
      },
    ],
  });
  expect(encoded.ok).toBe(true);
  window.history.replaceState(
    {},
    "",
    `/libraries?wsv=${WORKSPACE_SCHEMA_VERSION}&ws=${encoded.value}`
  );
}

function sectionHeadings() {
  return screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent);
}

describe("CommandPalette", () => {
  const originalInnerWidth = window.innerWidth;
  const originalPath = window.location.pathname;

  beforeEach(() => {
    setViewportWidth(640);
    document.body.style.overflow = "";
    localStorage.clear();
    window.history.replaceState({}, "", "/libraries");
    mockApi();
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
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Open tabs" })).toBeInTheDocument();
    expect(screen.getByText("Navigate")).toBeInTheDocument();
    expect(screen.getByText("Browse")).toBeInTheDocument();
    expect(screen.getByText("Chats")).toBeInTheDocument();
  });

  it("shows open tabs above deduped API-backed recents", async () => {
    vi.restoreAllMocks();
    mockApi({
      recents: [
        {
          href: "/media/media-1",
          title_snapshot: "Deep Work",
          last_used_at: "2026-04-17T12:00:00Z",
        },
        {
          href: "/search",
          title_snapshot: "Saved search",
          last_used_at: "2026-04-17T11:00:00Z",
        },
      ],
    });

    renderCommandPalette();

    expect(await screen.findByTestId("workspace-ready")).toBeInTheDocument();

    openPane("/media/media-1", "Deep Work");
    openPalette();

    await screen.findByRole("heading", { name: "Recent" });

    expect(sectionHeadings().slice(0, 2)).toEqual(["Open tabs", "Recent"]);
    expect(screen.getByRole("button", { name: /Media Current/ })).toBeInTheDocument();
    expect(screen.getByText("Current")).toBeInTheDocument();
    expect(screen.queryByText("Deep Work")).not.toBeInTheDocument();
    expect(screen.getByText("Saved search")).toBeInTheDocument();
    expect(screen.queryByText("Panes")).not.toBeInTheDocument();
  });

  it("keeps search results above matching recents and command groups while querying", async () => {
    vi.restoreAllMocks();
    mockApi({
      recents: [
        {
          href: "/search",
          title_snapshot: "Saved search",
          last_used_at: "2026-04-17T11:00:00Z",
        },
      ],
      searchResults: [
        {
          type: "media",
          id: "media-search-1",
          score: 0.93,
          snippet: "searchable note",
          title: "Searchable note",
          source_label: "Searchable note - web article",
          media_id: "media-search-1",
          media_kind: "web_article",
          deep_link: "/media/media-search-1",
          context_ref: { type: "media", id: "media-search-1" },
          source: {
            media_id: "media-search-1",
            media_kind: "web_article",
            title: "Searchable note",
            contributors: [],
            published_date: null,
          },
        },
      ],
    });

    renderCommandPalette();

    expect(await screen.findByTestId("workspace-ready")).toBeInTheDocument();

    openPalette();
    fireEvent.change(screen.getByLabelText("Search actions"), {
      target: { value: "search" },
    });

    await screen.findByRole("heading", { name: "Search results" });

    await waitFor(() => {
      expect(screen.getByText("Searchable note")).toBeInTheDocument();
    });

    const headings = sectionHeadings();
    expect(headings.indexOf("Search results")).toBeLessThan(headings.indexOf("Recent"));
    expect(headings.indexOf("Search results")).toBeLessThan(headings.indexOf("Navigate"));
    expect(screen.getByText("Saved search")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Searchable note media/ })).toBeInTheDocument();
  });

  it("closes open tabs from the palette without closing the palette", async () => {
    renderCommandPalette();

    expect(await screen.findByTestId("workspace-ready")).toBeInTheDocument();

    openPane("/media/media-1");
    openPalette();

    expect(await screen.findByRole("button", { name: "Close Media" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close Media" }));

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Close Media" })).not.toBeInTheDocument();
    });
    expect(screen.getByRole("dialog", { name: "Search" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Libraries Current/ })).toBeInTheDocument();
  });

  it("shows minimized open tabs and restores them when selected", async () => {
    setMinimizedWorkspaceUrl();
    renderCommandPalette();

    expect(await screen.findByTestId("workspace-ready")).toBeInTheDocument();

    openPalette();

    const minimizedTab = await screen.findByRole("button", { name: /Media Minimized/ });
    expect(screen.getByText("Minimized")).toBeInTheDocument();

    fireEvent.click(minimizedTab);

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Search" })).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(window.location.pathname).toBe("/media/media-1");
    });
  });

  it("closes minimized open tabs without closing the palette", async () => {
    setMinimizedWorkspaceUrl();
    renderCommandPalette();

    expect(await screen.findByTestId("workspace-ready")).toBeInTheDocument();

    openPalette();

    expect(await screen.findByRole("button", { name: /Media Minimized/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close Media" }));

    expect(screen.getByRole("dialog", { name: "Search" })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Close Media" })).not.toBeInTheDocument();
    });
  });

  it("keeps static command groups below open tabs and recents when there is no query", async () => {
    renderCommandPalette();

    expect(await screen.findByTestId("workspace-ready")).toBeInTheDocument();

    openPalette();

    expect(await screen.findByRole("heading", { name: "Open tabs" })).toBeInTheDocument();

    expect(sectionHeadings()).toEqual(["Open tabs", "Create", "Navigate", "Settings"]);
    expect(screen.getByText("Navigate")).toBeInTheDocument();
    expect(screen.getByText("Browse")).toBeInTheDocument();
  });

  it("exposes note creation and daily capture commands", async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    renderCommandPalette();

    expect(await screen.findByTestId("workspace-ready")).toBeInTheDocument();

    openPalette();

    expect(await screen.findByRole("button", { name: /New page/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Today's note/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Quick note to today/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /New page/ }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/notes/pages",
        expect.objectContaining({ method: "POST" })
      );
    });
  });
});
