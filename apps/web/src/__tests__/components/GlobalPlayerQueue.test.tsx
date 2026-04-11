import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import GlobalPlayerFooter from "@/components/GlobalPlayerFooter";
import { GlobalPlayerProvider, useGlobalPlayer } from "@/lib/player/globalPlayer";
import { setAudioMetrics, jsonResponse } from "../helpers/audio";

type QueueItem = {
  item_id: string;
  media_id: string;
  title: string;
  podcast_title: string | null;
  duration_seconds: number | null;
  stream_url: string;
  source_url: string;
  position: number;
  source: "manual" | "auto_subscription" | "auto_playlist";
  added_at: string;
  listening_state: { position_ms: number; playback_speed: number } | null;
  subscription_default_playback_speed?: number | null;
};

function buildQueueItem(
  itemId: string,
  mediaId: string,
  title: string,
  position: number,
  listeningPositionMs = 0,
  options: {
    listeningState?: { position_ms: number; playback_speed: number } | null;
    subscriptionDefaultPlaybackSpeed?: number | null;
  } = {}
): QueueItem {
  const listeningState =
    "listeningState" in options
      ? options.listeningState ?? null
      : ({
          position_ms: listeningPositionMs,
          playback_speed: 1,
        } satisfies { position_ms: number; playback_speed: number });
  return {
    item_id: itemId,
    media_id: mediaId,
    title,
    podcast_title: "Queue Podcast",
    duration_seconds: 120,
    stream_url: `https://cdn.example.com/${mediaId}.mp3`,
    source_url: `https://example.com/${mediaId}`,
    position,
    source: "manual",
    added_at: "2026-03-22T00:00:00Z",
    listening_state: listeningState,
    subscription_default_playback_speed: options.subscriptionDefaultPlaybackSpeed ?? null,
  };
}

function installPlaybackFetchMock(initialQueueItems: QueueItem[]) {
  let queueItems = [...initialQueueItems];
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input), "http://localhost");
    const method = init?.method ?? "GET";

    if (url.pathname === "/api/playback/queue" && method === "GET") {
      return jsonResponse({ data: queueItems });
    }

    if (url.pathname === "/api/playback/queue/next" && method === "GET") {
      const currentMediaId = url.searchParams.get("current_media_id");
      const currentIndex = queueItems.findIndex((item) => item.media_id === currentMediaId);
      const nextItem = currentIndex >= 0 ? queueItems[currentIndex + 1] ?? null : null;
      return jsonResponse({ data: nextItem });
    }

    if (url.pathname === "/api/playback/queue/order" && method === "PUT") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const rawItemIds: unknown[] = Array.isArray(body.item_ids) ? body.item_ids : [];
      const itemIds = rawItemIds.filter((value): value is string => typeof value === "string");
      const byId = new Map(queueItems.map((item) => [item.item_id, item]));
      queueItems = itemIds
        .map((itemId, index) => {
          const existing = byId.get(itemId);
          if (!existing) {
            return null;
          }
          return { ...existing, position: index };
        })
        .filter((item): item is QueueItem => item != null);
      return jsonResponse({ data: queueItems });
    }

    if (url.pathname.startsWith("/api/playback/queue/items/") && method === "DELETE") {
      const itemId = url.pathname.split("/").pop() ?? "";
      queueItems = queueItems
        .filter((item) => item.item_id !== itemId)
        .map((item, index) => ({ ...item, position: index }));
      return jsonResponse({ data: queueItems });
    }

    if (url.pathname === "/api/playback/queue/clear" && method === "POST") {
      queueItems = [];
      return jsonResponse({ data: [] });
    }

    if (url.pathname.startsWith("/api/media/") && url.pathname.endsWith("/listening-state")) {
      return new Response(null, { status: 204 });
    }

    return jsonResponse({ data: {} });
  });

  return {
    fetchMock,
    getQueueItems: () => queueItems,
  };
}

function Harness() {
  const { setTrack } = useGlobalPlayer();
  return (
    <>
      <button
        type="button"
        onClick={() =>
          setTrack(
            {
              media_id: "media-a",
              title: "Episode A",
              stream_url: "https://cdn.example.com/media-a.mp3",
              source_url: "https://example.com/media-a",
            },
            { autoplay: false }
          )
        }
      >
        Load A
      </button>
      <button
        type="button"
        onClick={() =>
          setTrack(
            {
              media_id: "media-b",
              title: "Episode B",
              stream_url: "https://cdn.example.com/media-b.mp3",
              source_url: "https://example.com/media-b",
            },
            { autoplay: false }
          )
        }
      >
        Load B
      </button>
      <GlobalPlayerFooter />
    </>
  );
}

function App() {
  return (
    <GlobalPlayerProvider>
      <Harness />
    </GlobalPlayerProvider>
  );
}

describe("GlobalPlayer queue behavior", () => {
  beforeEach(() => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
    window.dispatchEvent(new Event("resize"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders next/previous controls and disables next without upcoming queue item", async () => {
    const user = userEvent.setup();
    installPlaybackFetchMock([buildQueueItem("item-a", "media-a", "Episode A", 0)]);
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Load A" }));
    await user.click(screen.getByRole("button", { name: "More controls" }));

    expect(screen.getByRole("button", { name: "Previous in queue" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next in queue" })).toBeDisabled();
  });

  it("advances on next button and on ended auto-advance", async () => {
    const user = userEvent.setup();
    installPlaybackFetchMock([
      buildQueueItem("item-a", "media-a", "Episode A", 0),
      buildQueueItem("item-b", "media-b", "Episode B", 1, 8_000),
    ]);
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Load A" }));
    await user.click(screen.getByRole("button", { name: "More controls" }));
    await user.click(screen.getByRole("button", { name: "Next in queue" }));

    await waitFor(() => {
      expect(screen.getByText("Episode B")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "Load A" }));
    const audio = screen.getByLabelText("Global podcast player") as HTMLAudioElement;
    fireEvent(audio, new Event("ended"));
    await waitFor(() => {
      expect(screen.getByText("Episode B")).toBeInTheDocument();
    });
  });

  it("uses subscription default speed when queue item has no per-episode listening state", async () => {
    const user = userEvent.setup();
    installPlaybackFetchMock([
      buildQueueItem("item-a", "media-a", "Episode A", 0),
      buildQueueItem("item-b", "media-b", "Episode B", 1, 0, {
        listeningState: null,
        subscriptionDefaultPlaybackSpeed: 1.75,
      }),
    ]);
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Load A" }));
    await user.click(screen.getByRole("button", { name: "More controls" }));
    await user.click(screen.getByRole("button", { name: "Next in queue" }));

    await waitFor(() => {
      expect(screen.getByText("Episode B")).toBeInTheDocument();
    });

    const audio = screen.getByLabelText("Global podcast player") as HTMLAudioElement;
    await waitFor(() => {
      expect(audio.playbackRate).toBeCloseTo(1.75, 3);
    });
  });

  it("restarts current track when >3s and jumps to previous when near start", async () => {
    const user = userEvent.setup();
    installPlaybackFetchMock([
      buildQueueItem("item-a", "media-a", "Episode A", 0),
      buildQueueItem("item-b", "media-b", "Episode B", 1),
    ]);
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Load B" }));
    const audio = screen.getByLabelText("Global podcast player") as HTMLAudioElement;
    setAudioMetrics(audio, { duration: 120, currentTime: 5 });
    fireEvent(audio, new Event("durationchange"));
    fireEvent(audio, new Event("timeupdate"));

    await user.click(screen.getByRole("button", { name: "More controls" }));
    await user.click(screen.getByRole("button", { name: "Previous in queue" }));
    expect(Math.floor(audio.currentTime)).toBe(0);
    expect(screen.getByText("Episode B")).toBeInTheDocument();

    setAudioMetrics(audio, { duration: 120, currentTime: 2 });
    fireEvent(audio, new Event("timeupdate"));
    await user.click(screen.getByRole("button", { name: "Previous in queue" }));
    await waitFor(() => {
      expect(screen.getByText("Episode A")).toBeInTheDocument();
    });
  });

  it("opens queue panel with count and supports remove and clear", async () => {
    const user = userEvent.setup();
    const { fetchMock, getQueueItems } = installPlaybackFetchMock([
      buildQueueItem("item-a", "media-a", "Episode A", 0),
      buildQueueItem("item-b", "media-b", "Episode B", 1),
      buildQueueItem("item-c", "media-c", "Episode C", 2),
    ]);
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Load A" }));
    await user.click(screen.getByRole("button", { name: "More controls" }));

    expect(screen.getByRole("button", { name: "Open playback queue (2 upcoming)" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Open playback queue (2 upcoming)" }));
    expect(await screen.findByText("Episode B")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Remove Episode B from queue" }));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([input, init]) => {
          const url = new URL(String(input), "http://localhost");
          return url.pathname === "/api/playback/queue/items/item-b" && init?.method === "DELETE";
        })
      ).toBe(true);
    });

    await user.click(screen.getByRole("button", { name: "Clear queue" }));
    await waitFor(() => {
      expect(getQueueItems()).toEqual([]);
    });
  });
});
