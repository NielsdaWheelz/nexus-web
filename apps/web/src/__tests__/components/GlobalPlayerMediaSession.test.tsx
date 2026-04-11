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
};

type MediaSessionHarness = {
  actionHandlers: Map<string, MediaSessionActionHandler | null>;
  setPositionStateSpy: ReturnType<typeof vi.fn>;
  restore: () => void;
};

function buildQueueItem(
  itemId: string,
  mediaId: string,
  title: string,
  position: number
): QueueItem {
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
    listening_state: {
      position_ms: 0,
      playback_speed: 1,
    },
  };
}

function installPlaybackFetchMock(queueItems: QueueItem[]) {
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(String(input), "http://localhost");

    if (url.pathname === "/api/playback/queue") {
      return jsonResponse({ data: queueItems });
    }
    if (url.pathname === "/api/playback/queue/next") {
      const currentMediaId = url.searchParams.get("current_media_id");
      const currentIndex = queueItems.findIndex((item) => item.media_id === currentMediaId);
      const nextItem = currentIndex >= 0 ? queueItems[currentIndex + 1] ?? null : null;
      return jsonResponse({ data: nextItem });
    }
    if (url.pathname.startsWith("/api/media/") && url.pathname.endsWith("/listening-state")) {
      return new Response(null, { status: 204 });
    }
    return jsonResponse({ data: [] });
  });
  return fetchMock;
}

function installMediaSessionHarness(): MediaSessionHarness {
  const actionHandlers = new Map<string, MediaSessionActionHandler | null>();
  const setPositionStateSpy = vi.fn();
  const originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(window.navigator, "mediaSession");
  const originalMediaMetadata = (window as Window & { MediaMetadata?: typeof MediaMetadata })
    .MediaMetadata;

  const mediaSession = {
    metadata: null,
    playbackState: "none" as MediaSessionPlaybackState,
    setActionHandler(action: string, handler: MediaSessionActionHandler | null) {
      actionHandlers.set(action, handler);
    },
    setPositionState(state: MediaPositionState) {
      setPositionStateSpy(state);
    },
  } as unknown as MediaSession;

  Object.defineProperty(window.navigator, "mediaSession", {
    configurable: true,
    value: mediaSession,
  });

  class MediaMetadataMock {
    title = "";
    artist = "";
    album = "";
    artwork: MediaImage[] = [];

    constructor(init: MediaMetadataInit = {}) {
      this.title = init.title ?? "";
      this.artist = init.artist ?? "";
      this.album = init.album ?? "";
      this.artwork = init.artwork ?? [];
    }
  }

  Object.defineProperty(window, "MediaMetadata", {
    configurable: true,
    value: MediaMetadataMock,
  });

  return {
    actionHandlers,
    setPositionStateSpy,
    restore: () => {
      if (originalNavigatorDescriptor) {
        Object.defineProperty(window.navigator, "mediaSession", originalNavigatorDescriptor);
      } else {
        Reflect.deleteProperty(window.navigator, "mediaSession");
      }
      if (originalMediaMetadata) {
        Object.defineProperty(window, "MediaMetadata", {
          configurable: true,
          value: originalMediaMetadata,
        });
      } else {
        Reflect.deleteProperty(window, "MediaMetadata");
      }
    },
  };
}

function Harness() {
  const { setTrack, clearTrack } = useGlobalPlayer();
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
              podcast_title: "Queue Podcast",
              image_url: "https://cdn.example.com/podcast-cover.jpg",
            },
            { autoplay: false }
          )
        }
      >
        Load A
      </button>
      <button type="button" onClick={() => clearTrack()}>
        Clear
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

describe("GlobalPlayer MediaSession integration", () => {
  beforeEach(() => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
    window.dispatchEvent(new Event("resize"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers metadata and media action handlers; updates playback/position state", async () => {
    const user = userEvent.setup();
    const mediaSession = installMediaSessionHarness();
    installPlaybackFetchMock([
      buildQueueItem("item-a", "media-a", "Episode A", 0),
      buildQueueItem("item-b", "media-b", "Episode B", 1),
    ]);

    try {
      render(<App />);
      await user.click(screen.getByRole("button", { name: "Load A" }));

      await waitFor(() => {
        expect(mediaSession.actionHandlers.get("play")).toEqual(expect.any(Function));
        expect(mediaSession.actionHandlers.get("pause")).toEqual(expect.any(Function));
        expect(mediaSession.actionHandlers.get("seekbackward")).toEqual(expect.any(Function));
        expect(mediaSession.actionHandlers.get("seekforward")).toEqual(expect.any(Function));
        expect(mediaSession.actionHandlers.get("previoustrack")).toEqual(expect.any(Function));
        expect(mediaSession.actionHandlers.get("nexttrack")).toEqual(expect.any(Function));
        expect(mediaSession.actionHandlers.get("seekto")).toEqual(expect.any(Function));
      });

      const sessionMetadata = window.navigator.mediaSession?.metadata as
        | {
            title?: string;
            artist?: string;
            album?: string;
            artwork?: Array<{ src: string }>;
          }
        | undefined;
      expect(sessionMetadata?.title).toBe("Episode A");
      expect(sessionMetadata?.artist).toBe("Queue Podcast");
      expect(sessionMetadata?.album).toBe("Queue Podcast");
      expect(sessionMetadata?.artwork?.[0]?.src).toBe("https://cdn.example.com/podcast-cover.jpg");

      const audio = screen.getByLabelText("Global podcast player") as HTMLAudioElement;
      const playSpy = vi.spyOn(audio, "play").mockResolvedValue(undefined);
      const pauseSpy = vi.spyOn(audio, "pause").mockImplementation(() => {});

      fireEvent(audio, new Event("play"));
      expect(window.navigator.mediaSession?.playbackState).toBe("playing");

      fireEvent(audio, new Event("pause"));
      expect(window.navigator.mediaSession?.playbackState).toBe("paused");

      setAudioMetrics(audio, { duration: 120, currentTime: 10 });
      mediaSession.setPositionStateSpy.mockClear();
      fireEvent(audio, new Event("timeupdate"));
      fireEvent(audio, new Event("timeupdate"));
      expect(mediaSession.setPositionStateSpy).toHaveBeenCalledTimes(1);

      await new Promise((resolve) => setTimeout(resolve, 1_050));
      setAudioMetrics(audio, { duration: 120, currentTime: 12 });
      fireEvent(audio, new Event("timeupdate"));
      expect(mediaSession.setPositionStateSpy).toHaveBeenCalledTimes(2);
      expect(mediaSession.setPositionStateSpy.mock.calls[1]?.[0]).toMatchObject({
        duration: 120,
        playbackRate: 1,
        position: 12,
      });

      const playHandler = mediaSession.actionHandlers.get("play");
      const pauseHandler = mediaSession.actionHandlers.get("pause");
      const seekBackwardHandler = mediaSession.actionHandlers.get("seekbackward");
      const seekForwardHandler = mediaSession.actionHandlers.get("seekforward");
      const seekToHandler = mediaSession.actionHandlers.get("seekto");
      const nextTrackHandler = mediaSession.actionHandlers.get("nexttrack");

      playHandler?.({ action: "play" } as MediaSessionActionDetails);
      expect(playSpy).toHaveBeenCalledTimes(1);

      pauseHandler?.({ action: "pause" } as MediaSessionActionDetails);
      expect(pauseSpy).toHaveBeenCalledTimes(1);

      setAudioMetrics(audio, { duration: 120, currentTime: 45 });
      seekBackwardHandler?.({ action: "seekbackward" } as MediaSessionActionDetails);
      expect(Math.floor(audio.currentTime)).toBe(30);

      seekForwardHandler?.({ action: "seekforward" } as MediaSessionActionDetails);
      expect(Math.floor(audio.currentTime)).toBe(60);

      seekToHandler?.({ action: "seekto", seekTime: 72 } as MediaSessionActionDetails);
      expect(Math.floor(audio.currentTime)).toBe(72);

      await nextTrackHandler?.({ action: "nexttrack" } as MediaSessionActionDetails);
      await waitFor(() => {
        expect(screen.getByText("Episode B")).toBeInTheDocument();
      });

      setAudioMetrics(audio, { duration: 120, currentTime: 8 });
      fireEvent(audio, new Event("timeupdate"));
      const previousTrackHandler = mediaSession.actionHandlers.get("previoustrack");
      await previousTrackHandler?.({ action: "previoustrack" } as MediaSessionActionDetails);
      await waitFor(() => {
        expect(Math.floor(audio.currentTime)).toBe(0);
      });
    } finally {
      mediaSession.restore();
    }
  });

  it("cleans up MediaSession handlers and playback state when track is cleared", async () => {
    const user = userEvent.setup();
    const mediaSession = installMediaSessionHarness();
    installPlaybackFetchMock([buildQueueItem("item-a", "media-a", "Episode A", 0)]);

    try {
      render(<App />);
      await user.click(screen.getByRole("button", { name: "Load A" }));

      await waitFor(() => {
        expect(mediaSession.actionHandlers.get("play")).toEqual(expect.any(Function));
      });

      await user.click(screen.getByRole("button", { name: "Clear" }));

      await waitFor(() => {
        expect(mediaSession.actionHandlers.get("play")).toBeNull();
        expect(mediaSession.actionHandlers.get("pause")).toBeNull();
        expect(mediaSession.actionHandlers.get("seekbackward")).toBeNull();
        expect(mediaSession.actionHandlers.get("seekforward")).toBeNull();
        expect(mediaSession.actionHandlers.get("previoustrack")).toBeNull();
        expect(mediaSession.actionHandlers.get("nexttrack")).toBeNull();
        expect(mediaSession.actionHandlers.get("seekto")).toBeNull();
        expect(window.navigator.mediaSession?.playbackState).toBe("none");
      });
    } finally {
      mediaSession.restore();
    }
  });
});
