import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import GlobalPlayerFooter from "@/components/GlobalPlayerFooter";
import { GlobalPlayerProvider, useGlobalPlayer } from "@/lib/player/globalPlayer";
import { setAudioMetrics, setViewportWidth } from "../helpers/audio";

const PODCAST_CHAPTERS = [
  {
    chapter_idx: 0,
    title: "Intro",
    t_start_ms: 0,
    t_end_ms: 60_000,
    url: null,
    image_url: null,
  },
  {
    chapter_idx: 1,
    title: "Deep Dive",
    t_start_ms: 60_000,
    t_end_ms: 120_000,
    url: null,
    image_url: null,
  },
];

function RouteA() {
  const { setTrack } = useGlobalPlayer();
  return (
    <button
      type="button"
      onClick={() =>
        setTrack(
          {
            media_id: "media-123",
            title: "Episode Alpha",
            stream_url: "https://cdn.example.com/episode-alpha.mp3",
            source_url: "https://example.com/episode-alpha",
            chapters: PODCAST_CHAPTERS,
          },
          { autoplay: false }
        )
      }
    >
      Load episode
    </button>
  );
}

function RouteHarness() {
  const [route, setRoute] = useState<"a" | "b">("a");
  return (
    <GlobalPlayerProvider>
      <button type="button" onClick={() => setRoute("b")}>
        Navigate away
      </button>
      <input type="text" aria-label="Episode notes" />
      {route === "a" ? <RouteA /> : <p>Route B content</p>}
      <GlobalPlayerFooter />
    </GlobalPlayerProvider>
  );
}

function mockAudioTransport(audio: HTMLAudioElement) {
  const playSpy = vi.spyOn(audio, "play").mockResolvedValue(undefined);
  const pauseSpy = vi.spyOn(audio, "pause").mockImplementation(() => {});
  return { playSpy, pauseSpy };
}

describe("GlobalPlayerFooter", () => {
  beforeEach(() => {
    setViewportWidth(1280);
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("persists selected track across route changes on desktop", async () => {
    render(<RouteHarness />);

    fireEvent.click(screen.getByRole("button", { name: "Load episode" }));
    expect(await screen.findByText("Episode Alpha")).toBeInTheDocument();

    const audio = screen.getByLabelText("Global podcast player") as HTMLAudioElement;
    expect(audio.src).toContain("episode-alpha.mp3");

    fireEvent.click(screen.getByRole("button", { name: "Navigate away" }));
    expect(screen.getByText("Route B content")).toBeInTheDocument();
    expect(screen.getByText("Episode Alpha")).toBeInTheDocument();
    expect(screen.getByLabelText("Global podcast player")).toBeInTheDocument();
  });

  it("switches footer presentation to mobile mode", async () => {
    setViewportWidth(390);
    render(<RouteHarness />);

    fireEvent.click(screen.getByRole("button", { name: "Load episode" }));
    expect(await screen.findByRole("button", { name: "Expand player" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Play global player" })).toBeNull();
  });

  it("renders scrubber, skip, speed, and volume controls", async () => {
    render(<RouteHarness />);

    fireEvent.click(screen.getByRole("button", { name: "Load episode" }));

    const audio = screen.getByLabelText("Global podcast player") as HTMLAudioElement;
    setAudioMetrics(audio, { duration: 120, currentTime: 60, bufferedEnd: 90 });
    fireEvent(audio, new Event("durationchange"));
    fireEvent(audio, new Event("timeupdate"));
    fireEvent(audio, new Event("progress"));

    const seekSlider = screen.getByRole("slider", { name: /seek playback position/i });
    fireEvent.input(seekSlider, { target: { value: "90" } });
    fireEvent.change(seekSlider, { target: { value: "90" } });
    expect(Math.floor(audio.currentTime)).toBe(90);

    fireEvent.click(screen.getByRole("button", { name: /back 15 seconds/i }));
    expect(Math.floor(audio.currentTime)).toBe(75);

    fireEvent.click(screen.getByRole("button", { name: /forward 30 seconds/i }));
    expect(Math.floor(audio.currentTime)).toBe(105);

    audio.currentTime = 5;
    fireEvent(audio, new Event("timeupdate"));
    fireEvent.click(screen.getByRole("button", { name: /back 15 seconds/i }));
    expect(Math.floor(audio.currentTime)).toBe(0);

    audio.currentTime = 118;
    fireEvent(audio, new Event("timeupdate"));
    fireEvent.click(screen.getByRole("button", { name: /forward 30 seconds/i }));
    expect(Math.floor(audio.currentTime)).toBe(120);

    fireEvent.click(screen.getByRole("button", { name: "More controls" }));
    const speedControl = screen.getByRole("combobox", { name: /playback speed/i });
    fireEvent.change(speedControl, { target: { value: "1.5" } });
    expect(audio.playbackRate).toBeCloseTo(1.5, 3);

    const volumeSlider = screen.getByRole("slider", { name: /volume/i });
    fireEvent.input(volumeSlider, { target: { value: "0.3" } });
    fireEvent.change(volumeSlider, { target: { value: "0.3" } });
    expect(audio.volume).toBeCloseTo(0.3, 3);
    expect(window.localStorage.getItem("nexus.globalPlayer.volume")).toBe("0.3");
  });

  it("supports global space/arrow shortcuts with input guard", async () => {
    render(<RouteHarness />);

    fireEvent.keyDown(document, { key: " ", code: "Space" });
    expect(screen.queryByRole("contentinfo", { name: "Global player footer" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Load episode" }));

    const audio = screen.getByLabelText("Global podcast player") as HTMLAudioElement;
    const { playSpy, pauseSpy } = mockAudioTransport(audio);
    setAudioMetrics(audio, { duration: 120, currentTime: 30, bufferedEnd: 60 });
    fireEvent(audio, new Event("durationchange"));
    fireEvent(audio, new Event("timeupdate"));
    fireEvent(audio, new Event("progress"));

    fireEvent.keyDown(document, { key: " ", code: "Space" });
    expect(playSpy).toHaveBeenCalledTimes(1);
    fireEvent(audio, new Event("play"));

    fireEvent.keyDown(document, { key: " ", code: "Space" });
    expect(pauseSpy).toHaveBeenCalledTimes(1);
    fireEvent(audio, new Event("pause"));

    fireEvent.keyDown(document, { key: "ArrowLeft" });
    expect(Math.floor(audio.currentTime)).toBe(15);

    fireEvent.keyDown(document, { key: "ArrowRight" });
    expect(Math.floor(audio.currentTime)).toBe(45);

    const notesInput = screen.getByRole("textbox", { name: "Episode notes" });
    notesInput.focus();
    fireEvent.keyDown(notesInput, { key: "ArrowLeft" });
    fireEvent.keyDown(notesInput, { key: "ArrowRight" });
    fireEvent.keyDown(notesInput, { key: " " });
    expect(Math.floor(audio.currentTime)).toBe(45);
    expect(playSpy).toHaveBeenCalledTimes(1);
    expect(pauseSpy).toHaveBeenCalledTimes(1);
  });

  it("shows the current chapter label for chapterized audio", async () => {
    render(<RouteHarness />);

    fireEvent.click(screen.getByRole("button", { name: "Load episode" }));

    const audio = screen.getByLabelText("Global podcast player") as HTMLAudioElement;
    setAudioMetrics(audio, { duration: 120, currentTime: 75, bufferedEnd: 100 });
    fireEvent(audio, new Event("durationchange"));
    fireEvent(audio, new Event("timeupdate"));
    fireEvent(audio, new Event("progress"));

    expect(screen.getByText("Chapter 2: Deep Dive")).toBeVisible();
  });

  it("renders playback error UI with retry and source fallback", async () => {
    render(<RouteHarness />);

    fireEvent.click(screen.getByRole("button", { name: "Load episode" }));

    const audio = screen.getByLabelText("Global podcast player") as HTMLAudioElement;
    Object.defineProperty(audio, "error", {
      configurable: true,
      value: { code: 4 },
    });
    const loadSpy = vi.spyOn(audio, "load").mockImplementation(() => {});
    const playSpy = vi.spyOn(audio, "play").mockResolvedValue(undefined);

    fireEvent(audio, new Event("error"));
    expect(await screen.findByText("Audio URL unavailable.")).toBeInTheDocument();

    const retryButton = screen.getByRole("button", { name: "Retry playback" });
    expect(retryButton).toBeVisible();

    const sourceLink = screen.getByRole("link", { name: "Open source audio" });
    expect(sourceLink).toHaveAttribute("href", "https://example.com/episode-alpha");

    fireEvent.click(retryButton);
    expect(loadSpy).toHaveBeenCalledTimes(1);
    expect(playSpy).toHaveBeenCalledTimes(1);
  });

  it("auto-retries network playback errors when browser comes online", async () => {
    render(<RouteHarness />);

    fireEvent.click(screen.getByRole("button", { name: "Load episode" }));

    const audio = screen.getByLabelText("Global podcast player") as HTMLAudioElement;
    const playSpy = vi.spyOn(audio, "play").mockResolvedValue(undefined);
    vi.spyOn(audio, "load").mockImplementation(() => {});

    Object.defineProperty(audio, "error", {
      configurable: true,
      value: { code: 2 },
    });
    fireEvent(audio, new Event("error"));
    expect(await screen.findByText("Network error. Check your connection.")).toBeInTheDocument();

    window.dispatchEvent(new Event("online"));
    await waitFor(() => {
      expect(playSpy).toHaveBeenCalledTimes(1);
    });
  });

  it("shows and clears a buffering indicator around waiting/playing events", async () => {
    render(<RouteHarness />);

    fireEvent.click(screen.getByRole("button", { name: "Load episode" }));
    const audio = screen.getByLabelText("Global podcast player") as HTMLAudioElement;

    fireEvent(audio, new Event("waiting"));
    expect(await screen.findByText("Buffering...")).toBeVisible();

    fireEvent(audio, new Event("playing"));
    await waitFor(() => {
      expect(screen.queryByText("Buffering...")).toBeNull();
    });
  });
});
