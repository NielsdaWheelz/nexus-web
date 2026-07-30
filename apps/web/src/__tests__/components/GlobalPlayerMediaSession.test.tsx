import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import GlobalPlayerFooter from "@/components/GlobalPlayerFooter";
import { MobileViewportProvider } from "@/lib/mobileViewport/MobileViewportProvider";
import { WorkspaceTestProvider } from "@/__tests__/helpers/WorkspaceTestProvider";
import { buildMediaImageProxySrc } from "@/lib/media/imageProxy";
import { LecternProvider, useLectern } from "@/lib/lectern/LecternProvider";
import { GlobalPlayerProvider, useGlobalPlayer } from "@/lib/player/globalPlayer";
import {
  assumeDiscoveryTargetHandle,
  browsePreviewHref,
} from "@/lib/browse/contract";
import { absent, present } from "@/lib/api/presence";
import { withRenderEnvironment } from "../helpers/renderEnvironment";
import {
  FOOTER_AUDIO_LABEL,
  buildFooterDescriptor,
  installLecternPlayerFetchMock,
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
const PREVIEW_TARGET = assumeDiscoveryTargetHandle(
  "ndt1.e30.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
);

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
  const {
    state,
    playAudio,
    playPreviewAudio,
    stopPreviewAudio,
  } = useGlobalPlayer();
  const { resource } = useLectern();
  return (
    <>
      <span data-testid="lectern-status">{resource.status}</span>
      <button
        type="button"
        onClick={() =>
          playAudio(
            buildFooterDescriptor("11111111-1111-4111-8111-111111111111", "Episode A", {
              subtitle: "Queue Podcast",
              artworkUrl: "https://cdn.example.com/podcast-cover.jpg",
            })
          )
        }
      >
        Play episode
      </button>
      <button
        type="button"
        onClick={() =>
          playPreviewAudio({
            target: PREVIEW_TARGET,
            previewHref: browsePreviewHref(PREVIEW_TARGET),
            title: "External episode",
            source: "Podcast Index",
            sourceHref: "https://example.com/episode",
            audioUrl: "https://cdn.example.com/external.mp3",
            imageUrl: absent(),
            durationMs: present(120_000),
          })
        }
      >
        Play preview
      </button>
      <button type="button" onClick={() => stopPreviewAudio(PREVIEW_TARGET)}>
        Stop preview
      </button>
      <span data-testid="player-state">{state.kind}</span>
      <MobileViewportProvider>
        <GlobalPlayerFooter />
      </MobileViewportProvider>
    </>
  );
}

// playAudio defects before the Lectern snapshot is Ready (spec §6); wait for the
// mount GET to resolve before the explicit Play.
async function play() {
  await screen.findByText("ready", { selector: '[data-testid="lectern-status"]' });
  fireEvent.click(screen.getByRole("button", { name: "Play episode" }));
}

function App() {
  // GlobalPlayerProvider consumes useLectern(), so it must be wrapped in a
  // LecternProvider; `installLecternPlayerFetchMock` serves the mount fetches.
  return (
    <WorkspaceTestProvider>
      <LecternProvider>
        <GlobalPlayerProvider>
        <Harness />
        </GlobalPlayerProvider>
      </LecternProvider>
    </WorkspaceTestProvider>
  );
}

describe("GlobalPlayer MediaSession integration", () => {
  beforeEach(() => {
    setViewportWidth(1280);
    installLecternPlayerFetchMock();
    // `playAudio` autoplays; stub transport so the bogus stream never hits the
    // network and never flips the session to PlaybackFailed mid-test.
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("registers metadata and media action handlers; updates playback/position state; previous restarts", async () => {
    const mediaSession = installMediaSessionHarness();
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);

    let unmount: (() => void) | null = null;
    try {
      ({ unmount } = render(withRenderEnvironment(<App />)));
      await play();

      await waitFor(() => {
        for (const action of MEDIA_SESSION_ACTIONS) {
          expect(mediaSession.actionHandlers.get(action)).toEqual(expect.any(Function));
        }
      });

      // Metadata now derives from the descriptor: title, subtitle -> artist/album,
      // artworkUrl -> artwork.
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
        buildMediaImageProxySrc("https://cdn.example.com/podcast-cover.jpg"),
      );

      const audio = screen.getByLabelText(FOOTER_AUDIO_LABEL) as HTMLAudioElement;
      // Spy after autoplay so the play/pause handler assertions count only their
      // own invocations.
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

      // Isolate each handler's own transport call from autoplay/effect churn.
      playSpy.mockClear();
      playHandler?.({ action: "play" } as MediaSessionActionDetails);
      expect(playSpy).toHaveBeenCalledTimes(1);

      pauseSpy.mockClear();
      pauseHandler?.({ action: "pause" } as MediaSessionActionDetails);
      expect(pauseSpy).toHaveBeenCalledTimes(1);

      setAudioMetrics(audio, { duration: 120, currentTime: 45 });
      seekBackwardHandler?.({ action: "seekbackward" } as MediaSessionActionDetails);
      expect(Math.floor(audio.currentTime)).toBe(30);

      seekForwardHandler?.({ action: "seekforward" } as MediaSessionActionDetails);
      expect(Math.floor(audio.currentTime)).toBe(60);

      seekToHandler?.({ action: "seekto", seekTime: 72 } as MediaSessionActionDetails);
      expect(Math.floor(audio.currentTime)).toBe(72);

      // previous() is now history/lectern-aware, not queue-order: past the 3s
      // threshold with an empty device history it restarts the current audio.
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

  it("keeps Preview audio ephemeral and clears OS position state on stop", async () => {
    const mediaSession = installMediaSessionHarness();
    let unmount: (() => void) | null = null;
    try {
      ({ unmount } = render(withRenderEnvironment(<App />)));
      fireEvent.click(screen.getByRole("button", { name: "Play preview" }));

      await waitFor(() => {
        expect(screen.getByTestId("player-state")).toHaveTextContent(
          "PreviewAudio",
        );
        expect(mediaSession.actionHandlers.get("previoustrack")).toBeNull();
        expect(mediaSession.actionHandlers.get("nexttrack")).toBeNull();
      });
      expect(
        screen.getByRole("link", { name: "External episode" }),
      ).toHaveAttribute(
        "href",
        `/browse/preview?target=${PREVIEW_TARGET}`,
      );
      expect(
        screen.getByRole("link", { name: "Open source" }),
      ).toHaveAttribute("href", "https://example.com/episode");

      const audio = screen.getByLabelText(FOOTER_AUDIO_LABEL) as HTMLAudioElement;
      setAudioMetrics(audio, { duration: 120, currentTime: 40 });
      fireEvent(audio, new Event("timeupdate"));
      mediaSession.setPositionStateSpy.mockClear();
      fireEvent(audio, new Event("ended"));
      expect(screen.getByTestId("player-state")).toHaveTextContent(
        "PreviewAudioAtEnd",
      );
      await waitFor(() => {
        expect(mediaSession.setPositionStateSpy).toHaveBeenCalledWith(undefined);
      });

      mediaSession.setPositionStateSpy.mockClear();
      fireEvent.click(screen.getByRole("button", { name: "Stop preview" }));
      await waitFor(() => {
        expect(screen.getByTestId("player-state")).toHaveTextContent("Absent");
        expect(mediaSession.setPositionStateSpy).toHaveBeenCalledWith(undefined);
      });

      const writes = vi.mocked(globalThis.fetch).mock.calls.filter(([, init]) => {
        const method = init?.method ?? "GET";
        return method !== "GET" && method !== "HEAD";
      });
      expect(writes).toHaveLength(0);
    } finally {
      unmount?.();
      mediaSession.restore();
    }
  });
});
