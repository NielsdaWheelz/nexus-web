import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import LecternPaneBody from "@/app/(authenticated)/lectern/LecternPaneBody";
import { resolvePaneRouteIdentity } from "@/lib/panes/paneIdentity";
import { PaneRuntimeProvider } from "@/lib/panes/paneRuntime";

interface QueueRow {
  item_id: string;
  media_id: string;
  position: number;
  kind: string;
  title: string;
  stream_url: string | null;
  reader_href: string;
  source: string;
  added_at: string;
  listening_state: null;
}

function row(itemId: string, mediaId: string, title: string, position: number, kind = "web_article"): QueueRow {
  return {
    item_id: itemId,
    media_id: mediaId,
    position,
    kind,
    title,
    stream_url: kind === "web_article" ? null : `https://cdn.example.com/${mediaId}.mp3`,
    reader_href: `/media/${mediaId}`,
    source: "manual",
    added_at: "2026-03-22T00:00:00Z",
    listening_state: null,
  };
}

function pathOf(input: RequestInfo | URL): string {
  if (input instanceof Request) return new URL(input.url).pathname;
  return new URL(String(input), "http://localhost").pathname;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function installQueueMock(initial: QueueRow[]) {
  let items = [...initial];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = pathOf(input);
    const method = init?.method ?? "GET";
    if (path === "/api/queue" && method === "GET") {
      return jsonResponse({ data: items });
    }
    if (path.startsWith("/api/queue/items/") && method === "DELETE") {
      const itemId = path.split("/").pop() ?? "";
      items = items
        .filter((item) => item.item_id !== itemId)
        .map((item, index) => ({ ...item, position: index }));
      return jsonResponse({ data: items });
    }
    throw new Error(`Unexpected fetch: ${method} ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, getItems: () => items };
}

function withPaneRuntime(node: ReactNode) {
  const href = "/lectern";
  return (
    <PaneRuntimeProvider
      paneId="pane-1"
      href={href}
      routeId="lectern"
      routeKey={resolvePaneRouteIdentity(href).routeKey}
      canGoBack={false}
      canGoForward={false}
      onGoBackPane={vi.fn()}
      onGoForwardPane={vi.fn()}
      onNavigatePane={vi.fn()}
      onReplacePane={vi.fn()}
      onOpenInNewPane={vi.fn()}
      onSetPaneTitle={vi.fn()}
    >
      {node}
    </PaneRuntimeProvider>
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("LecternPaneBody", () => {
  it("renders queue items in order with the 'On the lectern' kicker on the first row", async () => {
    installQueueMock([
      row("item-a", "media-a", "A Long Read", 0),
      row("item-b", "media-b", "An Episode", 1, "podcast_episode"),
    ]);
    render(withPaneRuntime(<LecternPaneBody />));

    expect(await screen.findByText("A Long Read")).toBeInTheDocument();
    expect(screen.getByText("An Episode")).toBeInTheDocument();
    expect(screen.getByText("On the lectern")).toBeInTheDocument();
  });

  it("shows a quiet empty state when the queue is empty", async () => {
    installQueueMock([]);
    render(withPaneRuntime(<LecternPaneBody />));

    expect(await screen.findByText("Nothing on the lectern yet.")).toBeInTheDocument();
    expect(screen.queryByText("On the lectern")).toBeNull();
  });

  it("removes an item from the queue via the row action menu", async () => {
    const { getItems } = installQueueMock([
      row("item-a", "media-a", "A Long Read", 0),
      row("item-b", "media-b", "Another Read", 1),
    ]);
    render(withPaneRuntime(<LecternPaneBody />));

    await screen.findByText("A Long Read");
    const triggers = screen.getAllByRole("button", { name: "Actions" });
    fireEvent.click(triggers[0]);
    const remove = await screen.findByRole("menuitem", { name: "Remove from Lectern" });
    fireEvent.click(remove);

    await waitFor(() => expect(screen.queryByText("A Long Read")).toBeNull());
    expect(getItems().map((item) => item.item_id)).toEqual(["item-b"]);
    expect(screen.getByText("Another Read")).toBeInTheDocument();
  });
});
