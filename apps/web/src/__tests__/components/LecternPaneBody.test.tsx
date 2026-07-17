import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import LecternPaneBody from "@/app/(authenticated)/lectern/LecternPaneBody";
import { LecternProvider } from "@/lib/lectern/LecternProvider";
import { GlobalPlayerProvider } from "@/lib/player/globalPlayer";
import { resolvePaneRouteIdentity } from "@/lib/panes/paneIdentity";
import { PaneRuntimeProvider } from "@/lib/panes/paneRuntime";

const MEDIA_A = "11111111-0000-4000-8000-000000000001";
const MEDIA_B = "22222222-0000-4000-8000-000000000002";
const ITEM_A = "aaaaaaaa-0000-4000-8000-000000000001";
const ITEM_B = "bbbbbbbb-0000-4000-8000-000000000002";

interface WireItem {
  itemId: string;
  mediaId: string;
  title: string;
  subtitle: { kind: "Absent" };
  href: string;
  consumption: { state: "Unread"; progress: { kind: "Absent" } };
  activation:
    | { kind: "Readable" }
    | {
        kind: "FooterAudio";
        streamUrl: string;
        sourceUrl: string;
        positionMs: number;
        writeRevision: number;
        resetEpoch: number;
        playbackSpeed: number;
        durationMs: { kind: "Absent" };
        artworkUrl: { kind: "Absent" };
        chapters: [];
      };
}

function wireItem(itemId: string, mediaId: string, title: string, audio = false): WireItem {
  return {
    itemId,
    mediaId,
    title,
    subtitle: { kind: "Absent" },
    href: `/media/${mediaId}`,
    consumption: { state: "Unread", progress: { kind: "Absent" } },
    activation: audio
      ? {
          kind: "FooterAudio",
          streamUrl: `https://cdn.example.com/${mediaId}.mp3`,
          sourceUrl: `https://example.com/${mediaId}`,
          positionMs: 0,
          writeRevision: 0,
          resetEpoch: 0,
          playbackSpeed: 1,
          durationMs: { kind: "Absent" },
          artworkUrl: { kind: "Absent" },
          chapters: [],
        }
      : { kind: "Readable" },
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

function installLecternMock(initial: WireItem[]) {
  let items = [...initial];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = pathOf(input);
    const method = init?.method ?? "GET";
    if (path === "/api/lectern" && method === "GET") {
      return jsonResponse({ data: { items } });
    }
    if (path === "/api/lectern/commands" && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (body.kind === "RemoveItem") {
        items = items.filter((item) => item.itemId !== body.itemId);
        return jsonResponse({ data: { outcome: { kind: "Removed", itemId: body.itemId }, lectern: { items } } });
      }
      if (body.kind === "SetOrder") {
        const byId = new Map(items.map((item) => [item.itemId, item]));
        items = (body.itemIds as string[])
          .map((id) => byId.get(id))
          .filter((item): item is WireItem => item !== undefined);
        return jsonResponse({ data: { outcome: { kind: "Ordered" }, lectern: { items } } });
      }
      return jsonResponse({ data: { outcome: { kind: "Ordered" }, lectern: { items } } });
    }
    throw new Error(`Unexpected fetch: ${method} ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, getItems: () => items };
}

function withProviders(node: ReactNode) {
  const href = "/lectern";
  return (
    <LecternProvider>
      <GlobalPlayerProvider>
        <PaneRuntimeProvider
          paneId="pane-1"
          isActive={true}
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
      </GlobalPlayerProvider>
    </LecternProvider>
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("LecternPaneBody", () => {
  it("renders lectern items in order with the 'On the lectern' kicker", async () => {
    installLecternMock([
      wireItem(ITEM_A, MEDIA_A, "A Long Read"),
      wireItem(ITEM_B, MEDIA_B, "An Episode", true),
    ]);
    render(withProviders(<LecternPaneBody />));

    expect(await screen.findByText("A Long Read")).toBeInTheDocument();
    expect(screen.getByText("An Episode")).toBeInTheDocument();
    expect(screen.getByText("On the lectern")).toBeInTheDocument();
  });

  it("shows a quiet empty state when the lectern is empty", async () => {
    installLecternMock([]);
    render(withProviders(<LecternPaneBody />));

    expect(await screen.findByText("Nothing on the lectern yet.")).toBeInTheDocument();
    expect(screen.queryByText("On the lectern")).toBeNull();
  });

  it("removes an item via the row action menu", async () => {
    const { getItems } = installLecternMock([
      wireItem(ITEM_A, MEDIA_A, "A Long Read"),
      wireItem(ITEM_B, MEDIA_B, "Another Read"),
    ]);
    render(withProviders(<LecternPaneBody />));

    await screen.findByText("A Long Read");
    const triggers = screen.getAllByRole("button", { name: "Actions" });
    fireEvent.click(triggers[0]);
    const remove = await screen.findByRole("menuitem", { name: "Remove from Lectern" });
    fireEvent.click(remove);

    await waitFor(() => expect(screen.queryByText("A Long Read")).toBeNull());
    expect(getItems().map((item) => item.itemId)).toEqual([ITEM_B]);
    expect(screen.getByText("Another Read")).toBeInTheDocument();
  });
});
