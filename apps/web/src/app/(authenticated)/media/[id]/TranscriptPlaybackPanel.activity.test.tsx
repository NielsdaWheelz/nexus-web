import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TranscriptPlaybackPanel from "./TranscriptPlaybackPanel";

const recorder = vi.hoisted(() => ({
  observe: vi.fn(),
  registerObserver: vi.fn(() => vi.fn()),
}));

vi.mock("@/lib/consumption/activityRecorder", () => ({
  activityRecorder: () => recorder,
}));

vi.mock("@/lib/player/globalPlayer", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/player/globalPlayer")>(
      "@/lib/player/globalPlayer",
    );
  return {
    ...actual,
    useGlobalPlayer: () => ({
      playAudio: vi.fn(),
      presentation: { positionMs: 0 },
      state: { kind: "Absent" },
    }),
  };
});

vi.mock("@/lib/lectern/LecternProvider", () => ({
  useLectern: () => ({
    placeItems: vi.fn(),
    resource: { status: "ready", data: { items: [] } },
  }),
}));

let intersectionCallback: IntersectionObserverCallback | undefined;

function latestViewingObservation() {
  const observations = recorder.observe.mock.calls as unknown as Array<
    [string, { modality: string; eligible: boolean; deviceClass: "Desktop" | "Mobile" }]
  >;
  const call = observations
    .map(([, observation]) => observation)
    .filter((observation) => observation.modality === "Viewing")
    .at(-1);
  if (!call) throw new Error("Viewing observer was not updated");
  return call;
}

function Panel({ paneActive = true, validSource = true }: { paneActive?: boolean; validSource?: boolean }) {
  return (
    <TranscriptPlaybackPanel
      mediaId="00000000-0000-4000-8000-000000000801"
      mediaKind="video"
      playbackSource={{
        kind: "external_video",
        stream_url: "https://media.example/activity-test.mp4",
        embed_url: validSource
          ? "https://www.youtube.com/embed/activity-test"
          : "https://example.com/untrusted-video",
        source_url: "https://example.com/video",
      }}
      canonicalSourceUrl="https://example.com/video"
      chapters={[]}
      playerDescriptor={null}
      videoSeekTargetMs={null}
      paneActive={paneActive}
      paneInstance="activity-pane"
      onSeek={vi.fn()}
    />
  );
}

describe("TranscriptPlaybackPanel activity adapter", () => {
  beforeEach(() => {
    vi.stubGlobal("innerWidth", 1280);
    recorder.observe.mockReset();
    recorder.registerObserver.mockReset();
    recorder.registerObserver.mockImplementation(() => vi.fn());
    intersectionCallback = undefined;
    vi.stubGlobal(
      "IntersectionObserver",
      class IntersectionObserverMock {
        constructor(callback: IntersectionObserverCallback) {
          intersectionCallback = callback;
        }

        observe = vi.fn();
        disconnect = vi.fn();
        root = null;
        rootMargin = "0px";
        thresholds = [0, 0.5];
        takeRecords = () => [];
        unobserve = vi.fn();
      },
    );
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("publishes only loaded, 50%-visible, active-pane dwell and closes on pane loss", async () => {
    const { rerender, unmount } = render(<Panel />);
    const iframe = screen.getByTitle("YouTube video player");

    await waitFor(() => expect(recorder.registerObserver).toHaveBeenCalledTimes(1));
    expect(latestViewingObservation().eligible).toBe(false);
    expect(intersectionCallback).toBeDefined();
    intersectionCallback?.(
      [{ intersectionRatio: 0.5 } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    );
    await waitFor(() => expect(latestViewingObservation().eligible).toBe(false));

    fireEvent.load(iframe);
    await waitFor(() => expect(latestViewingObservation().eligible).toBe(true));
    expect(latestViewingObservation().deviceClass).toBe("Desktop");

    vi.stubGlobal("innerWidth", 390);
    window.dispatchEvent(new Event("resize"));
    await waitFor(() => expect(latestViewingObservation().deviceClass).toBe("Mobile"));

    intersectionCallback?.(
      [{ intersectionRatio: 0.49 } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    );
    await waitFor(() => expect(latestViewingObservation().eligible).toBe(false));

    rerender(<Panel paneActive={false} />);
    await waitFor(() => expect(latestViewingObservation().eligible).toBe(false));

    const unregister = recorder.registerObserver.mock.results.at(-1)?.value as ReturnType<typeof vi.fn>;
    unmount();
    expect(unregister).toHaveBeenCalledOnce();
  });

  it("keeps iframe-focused dwell eligible across parent blur but closes when hidden", async () => {
    let visibilityState: DocumentVisibilityState = "visible";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibilityState,
    });
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    render(<Panel />);
    const iframe = screen.getByTitle("YouTube video player");

    await waitFor(() => expect(intersectionCallback).toBeDefined());
    intersectionCallback?.(
      [{ intersectionRatio: 0.5 } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    );
    fireEvent.load(iframe);
    iframe.focus();
    window.dispatchEvent(new Event("blur"));
    await waitFor(() => expect(latestViewingObservation().eligible).toBe(true));

    visibilityState = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(latestViewingObservation().eligible).toBe(false));
  });

  it("does not register a video observer for an unavailable embed source", () => {
    render(<Panel validSource={false} />);
    expect(recorder.registerObserver).not.toHaveBeenCalled();
  });
});
