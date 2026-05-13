import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import GlobalPlayerFooter from "@/components/GlobalPlayerFooter";
import { GlobalPlayerProvider, useGlobalPlayer } from "@/lib/player/globalPlayer";
import { setAudioMetrics, setViewportWidth } from "../helpers/audio";

function installIntervalHarness() {
  const handlers = new Map<number, { delay: number; handler: TimerHandler }>();
  let nextId = 1;

  const setIntervalSpy = vi.spyOn(window, "setInterval").mockImplementation((handler, delay) => {
    const intervalId = nextId;
    nextId += 1;
    handlers.set(intervalId, { delay: Number(delay), handler });
    return intervalId as unknown as ReturnType<typeof window.setInterval>;
  });

  const clearIntervalSpy = vi.spyOn(window, "clearInterval").mockImplementation((intervalId) => {
    handlers.delete(Number(intervalId));
  });

  return {
    setIntervalSpy,
    clearIntervalSpy,
    run(delay: number): boolean {
      let invoked = false;
      for (const { delay: registeredDelay, handler } of handlers.values()) {
        if (registeredDelay !== delay || typeof handler !== "function") {
          continue;
        }
        handler();
        invoked = true;
      }
      return invoked;
    },
  };
}

function getListeningStateCalls(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fetchSpy: { mock: { calls: any[][] } }
): Array<[input: string, init?: RequestInit]> {
  return fetchSpy.mock.calls.filter(
    (args) =>
      String(args[0]).includes("/api/media/") &&
      String(args[0]).includes("/listening-state")
  ) as Array<[string, RequestInit?]>;
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
              media_id: "media-123",
              title: "Episode Alpha",
              stream_url: "https://cdn.example.com/episode-alpha.mp3",
              source_url: "https://example.com/episode-alpha",
            },
            { autoplay: false, seek_seconds: 45, playback_rate: 1.75 }
          )
        }
      >
        Load episode A
      </button>
      <button
        type="button"
        onClick={() =>
          setTrack(
            {
              media_id: "media-456",
              title: "Episode Beta",
              stream_url: "https://cdn.example.com/episode-beta.mp3",
              source_url: "https://example.com/episode-beta",
            },
            { autoplay: false }
          )
        }
      >
        Load episode B
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

describe("GlobalPlayer listening-state persistence", () => {
  beforeEach(() => {
    setViewportWidth(1280);
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("writes at most every 15 seconds during playback and flushes on pause", async () => {
    const fetchSpy = vi
      .spyOn(window, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));
    const intervalHarness = installIntervalHarness();

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Load episode A" }));

    const audio = screen.getByLabelText("Global podcast player") as HTMLAudioElement;
    setAudioMetrics(audio, { duration: 120, currentTime: 30, playbackRate: 1.5 });
    fireEvent(audio, new Event("durationchange"));
    fireEvent(audio, new Event("timeupdate"));
    fireEvent(audio, new Event("play"));

    await waitFor(() =>
      expect(intervalHarness.setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 15_000)
    );
    expect(getListeningStateCalls(fetchSpy)).toHaveLength(0);
    expect(intervalHarness.run(15_000)).toBe(true);
    expect(getListeningStateCalls(fetchSpy)).toHaveLength(1);

    const firstCall = getListeningStateCalls(fetchSpy)[0];
    expect(String(firstCall?.[0])).toContain("/api/media/media-123/listening-state");

    audio.currentTime = 42;
    fireEvent(audio, new Event("timeupdate"));
    fireEvent(audio, new Event("pause"));
    expect(getListeningStateCalls(fetchSpy)).toHaveLength(2);
    expect(intervalHarness.clearIntervalSpy).toHaveBeenCalled();
  });

  it("flushes on track switch and page unload", async () => {
    const fetchSpy = vi
      .spyOn(window, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Load episode A" }));

    const audio = screen.getByLabelText("Global podcast player") as HTMLAudioElement;
    setAudioMetrics(audio, { duration: 120, currentTime: 15, playbackRate: 1.0 });
    fireEvent(audio, new Event("durationchange"));
    fireEvent(audio, new Event("timeupdate"));

    fireEvent.click(screen.getByRole("button", { name: "Load episode B" }));
    expect(getListeningStateCalls(fetchSpy)).toHaveLength(1);
    expect(String(getListeningStateCalls(fetchSpy)[0]?.[0])).toContain(
      "/api/media/media-123/listening-state"
    );

    setAudioMetrics(audio, { duration: 180, currentTime: 20, playbackRate: 1.25 });
    fireEvent(audio, new Event("durationchange"));
    fireEvent(audio, new Event("timeupdate"));

    window.dispatchEvent(new Event("beforeunload"));
    expect(getListeningStateCalls(fetchSpy)).toHaveLength(2);
    expect(String(getListeningStateCalls(fetchSpy)[1]?.[0])).toContain(
      "/api/media/media-456/listening-state"
    );
  });

  it("applies resume seek and speed options when setting a track", async () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Load episode A" }));
    const audio = screen.getByLabelText("Global podcast player") as HTMLAudioElement;

    await waitFor(() => {
      expect(Math.floor(audio.currentTime)).toBe(45);
      expect(audio.playbackRate).toBeCloseTo(1.75, 3);
    });
  });
});
