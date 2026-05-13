import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import GlobalPlayerFooter from "@/components/GlobalPlayerFooter";
import { GlobalPlayerProvider, useGlobalPlayer } from "@/lib/player/globalPlayer";
import {
  buildPlaybackQueueItem,
  installPlaybackFetchMock,
  setAudioMetrics,
  setViewportWidth,
} from "../helpers/audio";

type MediaSessionHarness = {
  actionHandlers: Map<string, MediaSessionActionHandler | null>;
  setPositionStateSpy: ReturnType<typeof vi.fn>;
  restore: () => void;
};

const MEDIA_SESSION_ACTIONS = [
  "play",
  "pause",
  "seekbackward",
  "seekforward",
  "previoustrack",
  "nexttrack",
  "seekto",
] as const;

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
    setViewportWidth(1280);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("registers metadata and media action handlers; updates playback/position state", async () => {
    const mediaSession = installMediaSessionHarness();
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    installPlaybackFetchMock([
      buildPlaybackQueueItem("item-a", "media-a", "Episode A", 0),
      buildPlaybackQueueItem("item-b", "media-b", "Episode B", 1),
    ]);

    let unmount: (() => void) | null = null;
    try {
      ({ unmount } = render(<App />));
      fireEvent.click(screen.getByRole("button", { name: "Load A" }));

      await waitFor(() => {
        for (const action of MEDIA_SESSION_ACTIONS) {
          expect(mediaSession.actionHandlers.get(action)).toEqual(expect.any(Function));
        }
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
      expect(sessionMetadata?.artwork?.[0]?.src).toBe(
        "/api/media/image?url=https%3A%2F%2Fcdn.example.com%2Fpodcast-cover.jpg"
      );

      const audio = screen.getByLabelText("Global podcast player") as HTMLAudioElement;
      const playSpy = vi.spyOn(audio, "play").mockResolvedValue(undefined);
      const pauseSpy = vi.spyOn(audio, "pause").mockImplementation(() => {});

      fireEvent(audio, new Event("play"));
      expect(window.navigator.mediaSession?.playbackState).toBe("playing");

      fireEvent(audio, new Event("pause"));
      expect(window.navigator.mediaSession?.playbackState).toBe("paused");

      setAudioMetrics(audio, { duration: 120, currentTime: 10 });
      mediaSession.setPositionStateSpy.mockClear();
      now = 1_000;
      fireEvent(audio, new Event("timeupdate"));
      expect(mediaSession.setPositionStateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          duration: 120,
          playbackRate: 1,
          position: 10,
        })
      );

      now = 2_050;
      setAudioMetrics(audio, { duration: 120, currentTime: 12 });
      fireEvent(audio, new Event("timeupdate"));
      expect(mediaSession.setPositionStateSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({
          duration: 120,
          playbackRate: 1,
          position: 12,
        })
      );

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
      unmount?.();
      mediaSession.restore();
    }
  });

  it("cleans up MediaSession handlers and playback state when track is cleared", async () => {
    const mediaSession = installMediaSessionHarness();
    installPlaybackFetchMock([buildPlaybackQueueItem("item-a", "media-a", "Episode A", 0)]);

    let unmount: (() => void) | null = null;
    try {
      ({ unmount } = render(<App />));
      fireEvent.click(screen.getByRole("button", { name: "Load A" }));

      await waitFor(() => {
        expect(mediaSession.actionHandlers.get("play")).toEqual(expect.any(Function));
      });

      fireEvent.click(screen.getByRole("button", { name: "Clear" }));

      await waitFor(() => {
        for (const action of MEDIA_SESSION_ACTIONS) {
          expect(mediaSession.actionHandlers.get(action)).toBeNull();
        }
        expect(window.navigator.mediaSession?.playbackState).toBe("none");
      });
    } finally {
      unmount?.();
      mediaSession.restore();
    }
  });
});
