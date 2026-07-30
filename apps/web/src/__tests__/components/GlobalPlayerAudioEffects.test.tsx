import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import GlobalPlayerSurfaces from "@/components/player/GlobalPlayerSurfaces";
import { MobileViewportProvider } from "@/lib/mobileViewport/MobileViewportProvider";
import { WorkspaceTestProvider } from "@/__tests__/helpers/WorkspaceTestProvider";
import { present } from "@/lib/api/presence";
import type { ChapterOut } from "@/lib/lectern/contract";
import { LecternProvider, useLectern } from "@/lib/lectern/LecternProvider";
import {
  GlobalPlayerProvider,
  usePlayerCommands,
} from "@/lib/player/globalPlayer";
import {
  PLAYER_AUDIO_LABEL,
  buildPlayerDescriptor,
  installLecternPlayerFetchMock,
  setAudioMetrics,
  setViewportWidth,
} from "../helpers/audio";

class FakeAudioParam {
  value: number;

  constructor(initialValue: number) {
    this.value = initialValue;
  }
}

class FakeAudioNode {
  readonly name: string;
  readonly connect = vi.fn((target: FakeAudioNode) => target);
  readonly disconnect = vi.fn();

  constructor(name: string) {
    this.name = name;
  }
}

class FakeAnalyserNode extends FakeAudioNode {
  fftSize = 2048;
  private frames: Float32Array[] = [];
  readonly getFloatTimeDomainData = vi.fn((target: Float32Array) => {
    const source =
      this.frames.shift() ?? new Float32Array(target.length).fill(0.4);
    for (let index = 0; index < target.length; index += 1) {
      target[index] = source[index] ?? 0;
    }
  });

  constructor() {
    super("analyser");
  }

  pushFrame(frame: Float32Array): void {
    this.frames.push(frame);
  }
}

class FakeGainNode extends FakeAudioNode {
  gain = new FakeAudioParam(1);

  constructor(name = "gain") {
    super(name);
  }
}

class FakeDynamicsCompressorNode extends FakeAudioNode {
  threshold = new FakeAudioParam(0);
  knee = new FakeAudioParam(0);
  ratio = new FakeAudioParam(0);
  attack = new FakeAudioParam(0);
  release = new FakeAudioParam(0);

  constructor() {
    super("compressor");
  }
}

interface FakeAudioContext {
  state: AudioContextState;
  destination: FakeAudioNode;
  sourceNode: FakeAudioNode;
  analyserNode: FakeAnalyserNode;
  gainNodes: FakeGainNode[];
  compressorNodes: FakeDynamicsCompressorNode[];
  splitterNodes: FakeAudioNode[];
  mergerNodes: FakeAudioNode[];
  createMediaElementSource: ReturnType<typeof vi.fn>;
  createAnalyser: ReturnType<typeof vi.fn>;
  createGain: ReturnType<typeof vi.fn>;
  createDynamicsCompressor: ReturnType<typeof vi.fn>;
  createChannelSplitter: ReturnType<typeof vi.fn>;
  createChannelMerger: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
  suspend: ReturnType<typeof vi.fn>;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
}

function installAudioContextMock(options: { throwOnSource?: boolean } = {}) {
  const instances: FakeAudioContext[] = [];
  const originalAudioContext = (
    window as Window & { AudioContext?: typeof AudioContext }
  ).AudioContext;

  class MockAudioContext {
    state: AudioContextState = "suspended";
    destination = new FakeAudioNode("destination");
    sourceNode = new FakeAudioNode("source");
    analyserNode = new FakeAnalyserNode();
    gainNodes: FakeGainNode[] = [];
    compressorNodes: FakeDynamicsCompressorNode[] = [];
    splitterNodes: FakeAudioNode[] = [];
    mergerNodes: FakeAudioNode[] = [];

    createMediaElementSource = vi.fn(() => {
      if (options.throwOnSource) {
        throw new DOMException("cross-origin media not CORS-enabled");
      }
      return this.sourceNode;
    });

    createAnalyser = vi.fn(() => this.analyserNode);

    createGain = vi.fn(() => {
      const node = new FakeGainNode();
      this.gainNodes.push(node);
      return node;
    });

    createDynamicsCompressor = vi.fn(() => {
      const node = new FakeDynamicsCompressorNode();
      this.compressorNodes.push(node);
      return node;
    });

    createChannelSplitter = vi.fn(() => {
      const node = new FakeAudioNode("splitter");
      this.splitterNodes.push(node);
      return node;
    });

    createChannelMerger = vi.fn(() => {
      const node = new FakeAudioNode("merger");
      this.mergerNodes.push(node);
      return node;
    });

    resume = vi.fn(async () => {
      this.state = "running";
    });

    suspend = vi.fn(async () => {
      this.state = "suspended";
    });

    addEventListener = vi.fn();
    removeEventListener = vi.fn();

    constructor() {
      instances.push(this as unknown as FakeAudioContext);
    }
  }

  Object.defineProperty(window, "AudioContext", {
    configurable: true,
    value: MockAudioContext as unknown as typeof AudioContext,
  });

  return {
    instances,
    restore: () => {
      if (originalAudioContext) {
        Object.defineProperty(window, "AudioContext", {
          configurable: true,
          value: originalAudioContext,
        });
      } else {
        Reflect.deleteProperty(window, "AudioContext");
      }
    },
  };
}

function installAnimationFrameHarness() {
  const queued = new Map<number, FrameRequestCallback>();
  let nextId = 1;
  let timestampMs = 0;

  const requestSpy = vi
    .spyOn(window, "requestAnimationFrame")
    .mockImplementation((callback: FrameRequestCallback) => {
      const requestId = nextId;
      nextId += 1;
      queued.set(requestId, callback);
      return requestId;
    });

  const cancelSpy = vi
    .spyOn(window, "cancelAnimationFrame")
    .mockImplementation((requestId) => {
      queued.delete(requestId);
    });

  function runFrame(deltaMs = 100): void {
    timestampMs += deltaMs;
    const callbacks = [...queued.values()];
    queued.clear();
    for (const callback of callbacks) {
      callback(timestampMs);
    }
  }

  function runFrames(count: number, deltaMs = 100): void {
    for (let index = 0; index < count; index += 1) {
      runFrame(deltaMs);
    }
  }

  return {
    requestSpy,
    cancelSpy,
    runFrames,
  };
}

const EPISODE_CHAPTERS: ChapterOut[] = [
  { title: "Intro", startMs: 0, endMs: present(60_000) },
  { title: "Deep Dive", startMs: 60_000, endMs: present(120_000) },
];

function Harness() {
  const { playAudio } = usePlayerCommands();
  const { resource } = useLectern();
  return (
    <>
      <span data-testid="lectern-status">{resource.status}</span>
      <button
        type="button"
        onClick={() =>
          playAudio(
            buildPlayerDescriptor(
              "11111111-1111-4111-8111-111111111111",
              "Episode Alpha",
              {
                chapters: EPISODE_CHAPTERS,
                durationMs: 120_000,
              },
            ),
          )
        }
      >
        Play episode
      </button>
      <MobileViewportProvider>
        <GlobalPlayerSurfaces />
      </MobileViewportProvider>
    </>
  );
}

// playAudio defects before the Lectern snapshot is Ready (spec §6); wait for the
// mount GET to resolve before the explicit Play.
async function play() {
  await screen.findByText("ready", {
    selector: '[data-testid="lectern-status"]',
  });
  fireEvent.click(screen.getByRole("button", { name: "Play episode" }));
}

function App() {
  // GlobalPlayerProvider consumes useLectern(), so it MUST be wrapped in a
  // LecternProvider; both fire `/api/lectern` + heartbeat fetches on mount, which
  // `installLecternPlayerFetchMock` (beforeEach) serves.
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

function createFrame(amplitude: number): Float32Array {
  return new Float32Array(128).fill(amplitude);
}

describe("GlobalPlayer audio effects", () => {
  beforeEach(() => {
    setViewportWidth(1280);
    window.localStorage.clear();
    installLecternPlayerFetchMock();
    // `playAudio` autoplays through the real `<audio>`; stub transport so the
    // bogus stream URL never touches the network (which would fire an `error`
    // event and flip the session to PlaybackFailed mid-test).
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps baseline playback direct and creates Web Audio only when an effect is enabled", async () => {
    const audioContextMock = installAudioContextMock();

    let unmount: (() => void) | null = null;
    try {
      ({ unmount } = render(<App />));
      await play();
      expect(audioContextMock.instances).toHaveLength(0);

      fireEvent.click(
        screen.getByRole("button", { name: "More player controls" }),
      );
      fireEvent.click(
        screen.getByRole("checkbox", { name: "Silence trimming" }),
      );
      await waitFor(() => {
        expect(audioContextMock.instances).toHaveLength(1);
      });
      fireEvent.change(screen.getByRole("combobox", { name: "Volume boost" }), {
        target: { value: "medium" },
      });
      fireEvent.click(screen.getByRole("checkbox", { name: "Mono audio" }));

      expect(window.localStorage.getItem("podcast_effects_silence_trim")).toBe(
        "true",
      );
      expect(window.localStorage.getItem("podcast_effects_volume_boost")).toBe(
        "medium",
      );
      expect(window.localStorage.getItem("podcast_effects_mono")).toBe("true");
      const instance = audioContextMock.instances[0];
      expect(instance.resume).toHaveBeenCalled();
      expect(instance.gainNodes[0]?.gain.value).toBeGreaterThan(1);
      expect(instance.compressorNodes).toHaveLength(1);
    } finally {
      unmount?.();
      audioContextMock.restore();
    }
  });

  it("restores saved audio effects preferences on the next session", async () => {
    const audioContextMock = installAudioContextMock();
    window.localStorage.setItem("podcast_effects_silence_trim", "true");
    window.localStorage.setItem("podcast_effects_volume_boost", "high");
    window.localStorage.setItem("podcast_effects_mono", "true");

    let unmount: (() => void) | null = null;
    try {
      ({ unmount } = render(<App />));
      await play();
      fireEvent.click(
        screen.getByRole("button", { name: "More player controls" }),
      );

      expect(
        screen.getByRole("checkbox", { name: "Silence trimming" }),
      ).toBeChecked();
      expect(
        screen.getByRole("combobox", { name: "Volume boost" }),
      ).toHaveValue("high");
      expect(
        screen.getByRole("checkbox", { name: "Mono audio" }),
      ).toBeChecked();
    } finally {
      unmount?.();
      audioContextMock.restore();
    }
  });

  it("speeds through sustained silence at 6x, restores user speed, and tracks time saved", async () => {
    const audioContextMock = installAudioContextMock();
    const raf = installAnimationFrameHarness();

    let unmount: (() => void) | null = null;
    try {
      ({ unmount } = render(<App />));
      await play();

      const audio = screen.getByLabelText(
        PLAYER_AUDIO_LABEL,
      ) as HTMLAudioElement;

      fireEvent.click(
        screen.getByRole("button", { name: "More player controls" }),
      );
      fireEvent.change(
        screen.getByRole("combobox", { name: "Playback speed" }),
        {
          target: { value: "1.5" },
        },
      );
      fireEvent.click(
        screen.getByRole("checkbox", { name: "Silence trimming" }),
      );
      await waitFor(() => {
        expect(audioContextMock.instances).toHaveLength(1);
      });
      // The session already autoplayed; the "play" event drives the Playing
      // phase that silence-trimming runs under.
      fireEvent(audio, new Event("play"));

      const analyser = audioContextMock.instances[0].analyserNode;
      for (let index = 0; index < 8; index += 1) {
        analyser.pushFrame(createFrame(0));
      }
      raf.runFrames(8, 100);

      await waitFor(() => {
        expect(audio.playbackRate).toBeCloseTo(6, 2);
      });
      // The effects popover stayed open (no Play-button click closed it).
      expect(screen.getByText("Trimming silence")).toBeVisible();

      setAudioMetrics(audio, { duration: 180, currentTime: 10 });
      fireEvent(audio, new Event("durationchange"));
      fireEvent(audio, new Event("timeupdate"));
      expect(
        screen.getByRole("slider", { name: "Seek playback position" }),
      ).toHaveAttribute("aria-valuetext", "00:10 of 03:00");

      for (let index = 0; index < 4; index += 1) {
        analyser.pushFrame(createFrame(0));
      }
      raf.runFrames(4, 100);

      const savedLabel = screen.getByText(/^Time saved:/i).textContent ?? "";
      const savedMatch = savedLabel.match(/([\d.]+)\s*s/);
      expect(savedMatch).not.toBeNull();
      expect(Number(savedMatch?.[1] ?? "0")).toBeGreaterThan(0);

      analyser.pushFrame(createFrame(0.5));
      analyser.pushFrame(createFrame(0.5));
      raf.runFrames(2, 100);

      await waitFor(() => {
        expect(audio.playbackRate).toBeCloseTo(1.5, 2);
      });
      expect(screen.queryByText("Trimming silence")).toBeNull();
    } finally {
      unmount?.();
      audioContextMock.restore();
      raf.requestSpy.mockRestore();
      raf.cancelSpy.mockRestore();
    }
  });

  it("applies mono routing without interrupting active playback", async () => {
    const audioContextMock = installAudioContextMock();

    let unmount: (() => void) | null = null;
    try {
      ({ unmount } = render(<App />));
      await play();

      const audio = screen.getByLabelText(
        PLAYER_AUDIO_LABEL,
      ) as HTMLAudioElement;
      fireEvent(audio, new Event("play"));

      // Spy after autoplay so the count reflects only the mono toggle.
      const pauseSpy = vi.spyOn(audio, "pause").mockImplementation(() => {});

      fireEvent.click(
        screen.getByRole("button", { name: "More player controls" }),
      );
      fireEvent.click(screen.getByRole("checkbox", { name: "Mono audio" }));
      await waitFor(() => {
        expect(audioContextMock.instances).toHaveLength(1);
      });

      const instance = audioContextMock.instances[0];
      // Enabling mono re-routes the graph without pausing/reloading playback.
      expect(pauseSpy).not.toHaveBeenCalled();
      expect(
        screen.getByRole("checkbox", { name: "Mono audio" }),
      ).toBeChecked();
      expect(instance.splitterNodes).toHaveLength(1);
      expect(instance.mergerNodes).toHaveLength(1);
    } finally {
      unmount?.();
      audioContextMock.restore();
    }
  });

  it("bypasses Web Audio effects when source graph creation fails", async () => {
    const audioContextMock = installAudioContextMock({ throwOnSource: true });

    let unmount: (() => void) | null = null;
    try {
      ({ unmount } = render(<App />));
      await play();
      expect(audioContextMock.instances).toHaveLength(0);

      fireEvent.click(
        screen.getByRole("button", { name: "More player controls" }),
      );
      fireEvent.click(
        screen.getByRole("checkbox", { name: "Silence trimming" }),
      );
      await waitFor(() => {
        expect(audioContextMock.instances).toHaveLength(1);
      });
      expect(
        screen.getByText("Audio effects unavailable for this source."),
      ).toBeVisible();
      expect(
        screen.getByRole("checkbox", { name: "Silence trimming" }),
      ).toBeDisabled();
      expect(
        screen.getByRole("combobox", { name: "Volume boost" }),
      ).toBeDisabled();
      expect(
        screen.getByRole("checkbox", { name: "Mono audio" }),
      ).toBeDisabled();
    } finally {
      unmount?.();
      audioContextMock.restore();
    }
  });
});
