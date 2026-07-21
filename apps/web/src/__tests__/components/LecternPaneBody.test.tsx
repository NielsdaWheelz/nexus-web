import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { horizontallyScrollableElements } from "@/__tests__/helpers/horizontalOverflow";
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
  kind: "web_article" | "podcast_episode";
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

interface WireRecentItem {
  mediaId: string;
  kind: "web_article" | "podcast_episode";
  title: string;
  href: string;
  consumption: { state: "Unread" | "InProgress"; progress: { kind: "Absent" } };
  lastEngagedAt: string;
  playerDescriptor:
    | { kind: "Absent" }
    | {
        kind: "Present";
        value: {
          mediaId: string;
          title: string;
          subtitle: { kind: "Absent" };
          activation: Extract<WireItem["activation"], { kind: "FooterAudio" }>;
        };
      };
}

function wireItem(itemId: string, mediaId: string, title: string, audio = false): WireItem {
  return {
    itemId,
    mediaId,
    kind: audio ? "podcast_episode" : "web_article",
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

function wireRecent(mediaId: string, title: string, audio = false): WireRecentItem {
  const queueShape = wireItem(ITEM_A, mediaId, title, audio);
  return {
    mediaId,
    kind: audio ? "podcast_episode" : "web_article",
    title,
    href: `/media/${mediaId}`,
    consumption: {
      state: audio ? "InProgress" : "Unread",
      progress: { kind: "Absent" },
    },
    lastEngagedAt: "2026-07-20T12:00:00Z",
    playerDescriptor:
      queueShape.activation.kind === "FooterAudio"
        ? {
            kind: "Present",
            value: {
              mediaId,
              title,
              subtitle: { kind: "Absent" },
              activation: queueShape.activation,
            },
          }
        : { kind: "Absent" },
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

function installLecternMock(initial: WireItem[], recent: WireRecentItem[] = []) {
  let items = [...initial];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = pathOf(input);
    const method = init?.method ?? "GET";
    if (path === "/api/lectern" && method === "GET") {
      return jsonResponse({ data: { items } });
    }
    if (path === "/api/lectern/recent" && method === "GET") {
      return jsonResponse({ data: { items: recent } });
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
      if (body.kind === "PlaceItems") {
        const placedIds: string[] = [];
        for (const mediaId of body.mediaIds as string[]) {
          const source = recent.find((item) => item.mediaId === mediaId);
          if (!source || items.some((item) => item.mediaId === mediaId)) continue;
          const itemId = `cccccccc-0000-4000-8000-${String(items.length + 1).padStart(12, "0")}`;
          items.push(
            wireItem(itemId, source.mediaId, source.title, source.kind === "podcast_episode"),
          );
          placedIds.push(itemId);
        }
        return jsonResponse({
          data: { outcome: { kind: "Placed", itemIds: placedIds }, lectern: { items } },
        });
      }
      return jsonResponse({ data: { outcome: { kind: "Ordered" }, lectern: { items } } });
    }
    throw new Error(`Unexpected fetch: ${method} ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, getItems: () => items };
}

function withProviders(node: ReactNode, isActive = true) {
  const href = "/lectern";
  return (
    <LecternProvider>
      <GlobalPlayerProvider>
        <PaneRuntimeProvider
          paneId="pane-1"
          isActive={isActive}
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
  it("renders lectern items in order under the queue section", async () => {
    installLecternMock([
      wireItem(ITEM_A, MEDIA_A, "A Long Read"),
      wireItem(ITEM_B, MEDIA_B, "An Episode", true),
    ]);
    render(withProviders(<LecternPaneBody />));

    expect(await screen.findByText("A Long Read")).toBeInTheDocument();
    expect(screen.getByText("An Episode")).toBeInTheDocument();
    expect(screen.getByText("On the lectern")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Play An Episode" })).toBeInTheDocument();
  });

  it("shows independent quiet empty states", async () => {
    installLecternMock([]);
    render(withProviders(<LecternPaneBody />));

    expect(await screen.findByText("Nothing on the lectern yet.")).toBeInTheDocument();
    expect(screen.getByText("On the lectern")).toBeInTheDocument();
    expect(screen.getByText("Nothing read or listened to yet.")).toBeInTheDocument();
  });

  it("shows a Retry on initial-load failure and recovers when Retry succeeds", async () => {
    let getCount = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = pathOf(input);
      const method = init?.method ?? "GET";
      if (path === "/api/lectern" && method === "GET") {
        getCount += 1;
        if (getCount === 1) {
          return new Response(JSON.stringify({ error: { code: "E_UPSTREAM", message: "boom" } }), {
            status: 503,
            headers: { "Content-Type": "application/json" },
          });
        }
        return jsonResponse({ data: { items: [wireItem(ITEM_A, MEDIA_A, "Recovered Read")] } });
      }
      if (path === "/api/lectern/recent" && method === "GET") {
        return jsonResponse({ data: { items: [] } });
      }
      throw new Error(`Unexpected fetch: ${method} ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(withProviders(<LecternPaneBody />));

    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(screen.getByText("Failed to load the Lectern")).toBeInTheDocument();

    fireEvent.click(retry);

    expect(await screen.findByText("Recovered Read")).toBeInTheDocument();
    expect(screen.queryByText("Failed to load the Lectern")).toBeNull();
  });

  it("removes an item via the row action menu", async () => {
    const { getItems } = installLecternMock([
      wireItem(ITEM_A, MEDIA_A, "A Long Read"),
      wireItem(ITEM_B, MEDIA_B, "Another Read"),
    ]);
    render(withProviders(<LecternPaneBody />));

    await screen.findByText("A Long Read");
    fireEvent.click(screen.getByRole("button", { name: "Actions for A Long Read" }));
    const remove = await screen.findByRole("menuitem", { name: "Remove from Lectern" });
    fireEvent.click(remove);

    await waitFor(() => expect(screen.queryByText("A Long Read")).toBeNull());
    expect(getItems().map((item) => item.itemId)).toEqual([ITEM_B]);
    await waitFor(() =>
      expect(screen.getByRole("link", { name: /Another Read/ })).toHaveFocus(),
    );
  });

  it("shows recent activity separately with one-gesture, keyboard-reachable Resume", async () => {
    installLecternMock(
      [wireItem(ITEM_A, MEDIA_A, "Already queued")],
      [
        wireRecent(MEDIA_A, "Already queued"),
        wireRecent(MEDIA_B, "Continue listening", true),
      ],
    );
    render(withProviders(<LecternPaneBody />));

    expect(await screen.findByText("Continue listening")).toBeInTheDocument();
    expect(await screen.findByText("Already queued")).toBeInTheDocument();
    expect(screen.getAllByText("Already queued")).toHaveLength(1);
    const recentList = screen.getByRole("list", { name: "Recently read and listened" });
    const resume = within(recentList).getByRole("button", {
      name: "Resume Continue listening",
    });
    expect(resume).toBeInTheDocument();
    expect(within(recentList).getByText("Listening")).toBeInTheDocument();

    within(recentList).getByRole("link", { name: /Continue listening/ }).focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(resume).toHaveFocus();
  });

  it("adds a recent item to the lectern through the canonical provider", async () => {
    const user = userEvent.setup();
    const { fetchMock } = installLecternMock([], [wireRecent(MEDIA_A, "A recent read")]);
    render(withProviders(<LecternPaneBody />));

    await screen.findByText("Nothing on the lectern yet.");
    await screen.findByText("A recent read");
    await user.click(screen.getByRole("button", { name: "Actions for A recent read" }));
    await user.click(await screen.findByRole("menuitem", { name: "Add to Lectern" }));

    expect(
      await screen.findByText("No other recent items to show."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Add to Lectern" })).toBeNull();
    await waitFor(() =>
      expect(screen.getByRole("link", { name: /A recent read/ })).toHaveFocus(),
    );
    const placeCall = fetchMock.mock.calls.find(([input, init]) => {
      return pathOf(input as RequestInfo | URL) === "/api/lectern/commands" &&
        (init as RequestInit | undefined)?.method === "POST" &&
        JSON.parse(String((init as RequestInit).body)).kind === "PlaceItems";
    });
    expect(placeCall).toBeDefined();
  });

  it("caps the daily recent section at six rows", async () => {
    const recent = Array.from({ length: 7 }, (_, index) =>
      wireRecent(
        `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        `Recent ${index + 1}`,
      ),
    );
    installLecternMock([], recent);
    render(withProviders(<LecternPaneBody />));

    expect(await screen.findByText("Recent 6")).toBeInTheDocument();
    expect(screen.queryByText("Recent 7")).toBeNull();
    expect(
      within(screen.getByRole("list", { name: "Recently read and listened" })).getAllByRole(
        "listitem",
      ),
    ).toHaveLength(6);
  });

  it("fetches past a fully queued top slice and shows the next useful recent item", async () => {
    const queued = Array.from({ length: 13 }, (_, index) => {
      const suffix = String(index + 1).padStart(12, "0");
      return wireItem(
        `aaaaaaaa-0000-4000-8000-${suffix}`,
        `00000000-0000-4000-8000-${suffix}`,
        `Queued ${index + 1}`,
      );
    });
    const recent = [
      ...queued.map((item) => wireRecent(item.mediaId, item.title)),
      wireRecent("99999999-0000-4000-8000-000000000001", "Useful recent read"),
    ];
    const { fetchMock } = installLecternMock(queued, recent);
    render(withProviders(<LecternPaneBody />));

    expect(await screen.findByText("Useful recent read")).toBeInTheDocument();
    const recentRequest = fetchMock.mock.calls.find(([input]) => {
      return pathOf(input as RequestInfo | URL) === "/api/lectern/recent";
    });
    expect(recentRequest).toBeDefined();
    const input = recentRequest?.[0] as RequestInfo | URL;
    const url = input instanceof Request ? new URL(input.url) : new URL(String(input), location.href);
    expect(url.searchParams.get("limit")).toBe("50");
  });

  it("keeps queue and recent actions inside a 320px mobile pane", async () => {
    installLecternMock(
      [wireItem(ITEM_A, MEDIA_A, "A queue episode with a deliberately long title", true)],
      [wireRecent(MEDIA_B, "A recent episode with another deliberately long title", true)],
    );
    render(
      <div data-testid="mobile-lectern-host" style={{ width: "320px", maxWidth: "320px" }}>
        {withProviders(<LecternPaneBody />)}
      </div>,
    );

    const host = await screen.findByTestId("mobile-lectern-host");
    expect(
      await screen.findByRole("button", {
        name: "Resume A recent episode with another deliberately long title",
      }),
    ).toBeInTheDocument();
    expect(host.clientWidth).toBe(320);
    expect(host.scrollWidth).toBeLessThanOrEqual(host.clientWidth + 1);
    expect(horizontallyScrollableElements(host)).toEqual([]);
  });

  it("keeps the queue usable when recent activity fails independently", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = pathOf(input);
      const method = init?.method ?? "GET";
      if (path === "/api/lectern" && method === "GET") {
        return jsonResponse({ data: { items: [wireItem(ITEM_A, MEDIA_A, "Queue survives")] } });
      }
      if (path === "/api/lectern/recent" && method === "GET") {
        return new Response(JSON.stringify({ error: { code: "E_BAD", message: "bad" } }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch: ${method} ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(withProviders(<LecternPaneBody />));

    expect(await screen.findByText("Queue survives")).toBeInTheDocument();
    expect(screen.getByText("Failed to load recent reading and listening")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry recent activity" })).toBeInTheDocument();
  });

  it("revalidates recent activity only when the retained pane becomes active again", async () => {
    let recentReads = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = pathOf(input);
      const method = init?.method ?? "GET";
      if (path === "/api/lectern" && method === "GET") {
        return jsonResponse({ data: { items: [] } });
      }
      if (path === "/api/lectern/recent" && method === "GET") {
        recentReads += 1;
        return jsonResponse({
          data: {
            items: [
              wireRecent(
                MEDIA_A,
                recentReads === 1 ? "Initial recent read" : "Refreshed recent read",
              ),
            ],
          },
        });
      }
      throw new Error(`Unexpected fetch: ${method} ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { rerender } = render(withProviders(<LecternPaneBody />, true));

    expect(await screen.findByText("Initial recent read")).toBeInTheDocument();
    expect(recentReads).toBe(1);

    rerender(withProviders(<LecternPaneBody />, false));
    expect(recentReads).toBe(1);
    rerender(withProviders(<LecternPaneBody />, true));

    expect(await screen.findByText("Refreshed recent read")).toBeInTheDocument();
    expect(recentReads).toBe(2);
  });
});
