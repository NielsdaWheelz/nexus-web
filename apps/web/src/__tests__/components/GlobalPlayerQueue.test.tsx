import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import GlobalPlayerFooter from "@/components/GlobalPlayerFooter";
import { GlobalPlayerProvider, useGlobalPlayer } from "@/lib/player/globalPlayer";
import {
  buildPlaybackQueueItem,
  installPlaybackFetchMock,
  setViewportWidth,
} from "../helpers/audio";

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
    setViewportWidth(1280);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("renders next/previous controls and disables next without upcoming queue item", async () => {
    installPlaybackFetchMock([buildPlaybackQueueItem("item-a", "media-a", "Episode A", 0)]);
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Load A" }));
    fireEvent.click(screen.getByRole("button", { name: "More controls" }));

    expect(screen.getByRole("button", { name: "Previous in queue" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next in queue" })).toBeDisabled();
  });

  it("auto-advances to the next queued item when playback ends", async () => {
    installPlaybackFetchMock([
      buildPlaybackQueueItem("item-a", "media-a", "Episode A", 0),
      buildPlaybackQueueItem("item-b", "media-b", "Episode B", 1, {
        listeningPositionMs: 8_000,
      }),
    ]);
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Load A" }));
    fireEvent.click(screen.getByRole("button", { name: "More controls" }));
    expect(await screen.findByRole("button", { name: "Open playback queue (1 upcoming)" })).toBeVisible();
    const audio = screen.getByLabelText("Global podcast player") as HTMLAudioElement;
    fireEvent(audio, new Event("ended"));
    await waitFor(() => {
      expect(screen.getByText("Episode B")).toBeInTheDocument();
    });
  });

  it("uses subscription default speed when queue item has no per-episode listening state", async () => {
    installPlaybackFetchMock([
      buildPlaybackQueueItem("item-a", "media-a", "Episode A", 0),
      buildPlaybackQueueItem("item-b", "media-b", "Episode B", 1, {
        listeningState: null,
        subscriptionDefaultPlaybackSpeed: 1.75,
      }),
    ]);
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Load A" }));
    fireEvent.click(screen.getByRole("button", { name: "More controls" }));
    expect(await screen.findByRole("button", { name: "Open playback queue (1 upcoming)" })).toBeVisible();

    const audio = screen.getByLabelText("Global podcast player") as HTMLAudioElement;
    fireEvent(audio, new Event("ended"));

    await waitFor(() => {
      expect(screen.getByText("Episode B")).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(audio.playbackRate).toBeCloseTo(1.75, 3);
    });
  });

  it("opens queue panel with count and supports remove and clear", async () => {
    installPlaybackFetchMock([
      buildPlaybackQueueItem("item-a", "media-a", "Episode A", 0),
      buildPlaybackQueueItem("item-b", "media-b", "Episode B", 1),
      buildPlaybackQueueItem("item-c", "media-c", "Episode C", 2),
    ]);
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Load A" }));
    fireEvent.click(screen.getByRole("button", { name: "More controls" }));

    const queueButton = await screen.findByRole("button", { name: "Open playback queue (2 upcoming)" });
    expect(queueButton).toBeVisible();
    fireEvent.click(queueButton);
    expect(await screen.findByText("Episode B")).toBeInTheDocument();
    expect(screen.getByText("Episode C")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Remove Episode B from queue" }));
    await waitFor(() => {
      expect(screen.queryByText("Episode B")).toBeNull();
    });

    fireEvent.click(screen.getByRole("button", { name: "Clear queue" }));
    await waitFor(() => {
      expect(screen.getByText("Queue is empty.")).toBeVisible();
    });
  });
});
