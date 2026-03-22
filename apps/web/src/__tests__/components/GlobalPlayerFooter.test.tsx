import { useState } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import GlobalPlayerFooter from "@/components/GlobalPlayerFooter";
import { GlobalPlayerProvider, useGlobalPlayer } from "@/lib/player/globalPlayer";

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

function setViewportWidth(width: number): void {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: width,
  });
  window.dispatchEvent(new Event("resize"));
}

function setAudioMetrics(
  audio: HTMLAudioElement,
  values: { duration: number; currentTime: number; bufferedEnd: number }
): void {
  Object.defineProperty(audio, "duration", {
    configurable: true,
    value: values.duration,
  });
  Object.defineProperty(audio, "buffered", {
    configurable: true,
    value: {
      length: 1,
      start: () => 0,
      end: () => values.bufferedEnd,
    },
  });
  audio.currentTime = values.currentTime;
}

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
      {route === "a" ? <RouteA /> : <p>Route B content</p>}
      <GlobalPlayerFooter />
    </GlobalPlayerProvider>
  );
}

describe("GlobalPlayerFooter", () => {
  beforeEach(() => {
    setViewportWidth(1280);
    window.localStorage.clear();
  });

  it("persists selected track across route changes on desktop", async () => {
    const user = userEvent.setup();
    render(<RouteHarness />);

    await user.click(screen.getByRole("button", { name: "Load episode" }));
    expect(await screen.findByText("Episode Alpha")).toBeInTheDocument();

    const audio = screen.getByLabelText("Global podcast player") as HTMLAudioElement;
    expect(audio.src).toContain("episode-alpha.mp3");

    await user.click(screen.getByRole("button", { name: "Navigate away" }));
    expect(screen.getByText("Route B content")).toBeInTheDocument();
    expect(screen.getByText("Episode Alpha")).toBeInTheDocument();
    expect(screen.getByLabelText("Global podcast player")).toBeInTheDocument();
  });

  it("switches footer presentation to mobile mode", async () => {
    const user = userEvent.setup();
    setViewportWidth(390);
    render(<RouteHarness />);

    await user.click(screen.getByRole("button", { name: "Load episode" }));
    await waitFor(() => {
      const footer = screen.getByRole("contentinfo", { name: "Global player footer" });
      expect(footer).toHaveAttribute("data-mobile", "true");
    });
  });

  it("renders scrubber, skip, speed, and volume controls", async () => {
    const user = userEvent.setup();
    render(<RouteHarness />);

    await user.click(screen.getByRole("button", { name: "Load episode" }));

    const audio = screen.getByLabelText("Global podcast player") as HTMLAudioElement;
    setAudioMetrics(audio, { duration: 120, currentTime: 60, bufferedEnd: 90 });
    fireEvent(audio, new Event("durationchange"));
    fireEvent(audio, new Event("timeupdate"));
    fireEvent(audio, new Event("progress"));

    const seekSlider = screen.getByRole("slider", { name: /seek playback position/i });
    fireEvent.input(seekSlider, { target: { value: "90" } });
    fireEvent.change(seekSlider, { target: { value: "90" } });
    expect(Math.floor(audio.currentTime)).toBe(90);

    await user.click(screen.getByRole("button", { name: /back 15 seconds/i }));
    expect(Math.floor(audio.currentTime)).toBe(75);

    await user.click(screen.getByRole("button", { name: /forward 30 seconds/i }));
    expect(Math.floor(audio.currentTime)).toBe(105);

    audio.currentTime = 5;
    fireEvent(audio, new Event("timeupdate"));
    await user.click(screen.getByRole("button", { name: /back 15 seconds/i }));
    expect(Math.floor(audio.currentTime)).toBe(0);

    audio.currentTime = 118;
    fireEvent(audio, new Event("timeupdate"));
    await user.click(screen.getByRole("button", { name: /forward 30 seconds/i }));
    expect(Math.floor(audio.currentTime)).toBe(120);

    const speedControl = screen.getByRole("combobox", { name: /playback speed/i });
    await user.selectOptions(speedControl, "1.5");
    expect(audio.playbackRate).toBeCloseTo(1.5, 3);

    const volumeSlider = screen.getByRole("slider", { name: /volume/i });
    fireEvent.input(volumeSlider, { target: { value: "0.3" } });
    fireEvent.change(volumeSlider, { target: { value: "0.3" } });
    expect(audio.volume).toBeCloseTo(0.3, 3);
    expect(window.localStorage.getItem("nexus.globalPlayer.volume")).toBe("0.3");
  });

  it("supports arrow-key skip shortcuts when player controls are focused", async () => {
    const user = userEvent.setup();
    render(<RouteHarness />);

    await user.click(screen.getByRole("button", { name: "Load episode" }));

    const audio = screen.getByLabelText("Global podcast player") as HTMLAudioElement;
    setAudioMetrics(audio, { duration: 120, currentTime: 30, bufferedEnd: 60 });
    fireEvent(audio, new Event("durationchange"));
    fireEvent(audio, new Event("timeupdate"));
    fireEvent(audio, new Event("progress"));

    const controls = screen.getByRole("group", { name: /global player controls/i });
    controls.focus();

    await user.keyboard("{ArrowLeft}");
    expect(Math.floor(audio.currentTime)).toBe(15);

    await user.keyboard("{ArrowRight}");
    expect(Math.floor(audio.currentTime)).toBe(45);
  });

  it("shows current chapter label and scrubber chapter tick markers", async () => {
    const user = userEvent.setup();
    render(<RouteHarness />);

    await user.click(screen.getByRole("button", { name: "Load episode" }));

    const audio = screen.getByLabelText("Global podcast player") as HTMLAudioElement;
    setAudioMetrics(audio, { duration: 120, currentTime: 75, bufferedEnd: 100 });
    fireEvent(audio, new Event("durationchange"));
    fireEvent(audio, new Event("timeupdate"));
    fireEvent(audio, new Event("progress"));

    expect(screen.getByText("Chapter 2: Deep Dive")).toBeVisible();
    expect(screen.getByTitle("Intro")).toBeVisible();
    expect(screen.getByTitle("Deep Dive")).toBeVisible();
  });
});
