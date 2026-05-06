import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CommandPalette from "@/components/CommandPalette";
import { OPEN_COMMAND_PALETTE_EVENT } from "@/components/commandPaletteEvents";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import { NEXUS_OPEN_PANE_EVENT } from "@/lib/panes/openInAppPane";
import { WorkspaceStoreProvider } from "@/lib/workspace/store";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}

function renderCommandPalette() {
  render(
    <FeedbackProvider>
      <WorkspaceStoreProvider>
        <div data-testid="workspace-ready" />
        <CommandPalette />
      </WorkspaceStoreProvider>
    </FeedbackProvider>,
  );
}

function mockApi({
  recents = [],
  oracleReadings = [],
  searchResults = [],
}: {
  recents?: {
    target_key: string;
    target_href: string;
    title_snapshot: string;
    last_used_at: string;
  }[];
  oracleReadings?: unknown[];
  searchResults?: unknown[];
} = {}) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input), "http://localhost");

    if (url.pathname === "/api/me/palette-history") {
      return jsonResponse({
        data: {
          recent: recents.map((row) => ({
            ...row,
            target_kind: "href",
            source: "recent",
          })),
          frecency_boosts: {},
        },
      });
    }
    if (url.pathname === "/api/me/palette-selections" && init?.method === "POST") {
      return jsonResponse({ data: null });
    }
    if (url.pathname === "/api/oracle/readings") {
      return jsonResponse({ data: oracleReadings });
    }
    if (url.pathname === "/api/search") {
      return jsonResponse({ results: searchResults, page: { has_more: false, next_cursor: null } });
    }
    if (url.pathname === "/api/notes/pages" && init?.method === "POST") {
      return jsonResponse({
        data: { id: "page-created", title: "Untitled", description: null, blocks: [] },
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
      }),
    );
  });
}

describe("CommandPalette", () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState({}, "", "/libraries");
    mockApi();
  });

  afterEach(() => {
    localStorage.clear();
    window.history.replaceState({}, "", "/libraries");
    vi.restoreAllMocks();
  });

  it("opens from the global launcher event with native dialog and combobox semantics", async () => {
    renderCommandPalette();
    expect(await screen.findByTestId("workspace-ready")).toBeInTheDocument();

    openPalette();

    const dialog = await screen.findByRole("dialog", { name: "Command palette" });
    expect(dialog.tagName).toBe("DIALOG");
    expect(screen.getByRole("combobox", { name: "Search commands" })).toHaveAttribute(
      "aria-controls",
      "palette-listbox",
    );
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Navigate" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Oracle/ })).toBeInTheDocument();
  });

  it("keeps focus on the input while arrowing through commands", async () => {
    renderCommandPalette();
    openPalette();

    const input = await screen.findByRole("combobox", { name: "Search commands" });
    input.focus();
    fireEvent.keyDown(input, { key: "ArrowDown" });

    expect(input).toHaveFocus();
    expect(input).toHaveAttribute("aria-activedescendant");
    const activeId = input.getAttribute("aria-activedescendant");
    expect(screen.getByRole("option", { selected: true })).toHaveAttribute("id", activeId);
  });

  it("shows recent destinations, recent Oracle folios, and search results", async () => {
    vi.restoreAllMocks();
    mockApi({
      recents: [
        {
          target_key: "/search",
          target_href: "/search",
          title_snapshot: "Saved search",
          last_used_at: "2026-04-17T11:00:00Z",
        },
      ],
      oracleReadings: [
        {
          id: "r1",
          folio_number: 12,
          folio_motto: "AVDENTES FORTVNA IVVAT",
          folio_theme: "Of Courage",
          status: "complete",
        },
        {
          id: "r2",
          folio_number: 3,
          folio_motto: "PER ASPERA",
          folio_theme: "Of Trials",
          status: "failed",
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
    openPalette();

    expect(await screen.findByRole("option", { name: /Saved search/ })).toBeInTheDocument();
    expect(
      await screen.findByRole("option", {
        name: /Folio XII.*Of Courage.*AVDENTES FORTVNA IVVAT/,
      }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/PER ASPERA/)).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("combobox", { name: "Search commands" }), {
      target: { value: "search" },
    });

    expect(await screen.findByRole("group", { name: "Search results" })).toBeInTheDocument();
    expect(await screen.findByRole("option", { name: /Searchable note/ })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Top result" })).toBeInTheDocument();
  });

  it("represents secondary pane operations as commands", async () => {
    renderCommandPalette();
    expect(await screen.findByTestId("workspace-ready")).toBeInTheDocument();

    openPane("/media/media-1");
    openPalette();

    expect(await screen.findByRole("option", { name: /Media.*Switch to open tab/ })).toBeInTheDocument();
    const closeCommand = screen.getByRole("option", { name: /Close Media/ });

    fireEvent.click(closeCommand);

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Command palette" })).not.toBeInTheDocument();
    });
  });

  it("executes create commands and records the selection first", async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    renderCommandPalette();
    openPalette();

    fireEvent.click(await screen.findByRole("option", { name: /New page/ }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/me/palette-selections",
        expect.objectContaining({ method: "POST" }),
      );
    });
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/notes/pages",
        expect.objectContaining({ method: "POST" }),
      );
    });
  });
});
