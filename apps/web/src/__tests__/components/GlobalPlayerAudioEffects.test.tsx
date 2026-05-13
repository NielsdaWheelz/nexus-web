import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import GlobalPlayerFooter from "@/components/GlobalPlayerFooter";
import { GlobalPlayerProvider, useGlobalPlayer } from "@/lib/player/globalPlayer";
import { setAudioMetrics, setViewportWidth } from "../helpers/audio";

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
    const source = this.frames.shift() ?? new Float32Array(target.length).fill(0.4);
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

  const cancelSpy = vi.spyOn(window, "cancelAnimationFrame").mockImplementation((requestId) => {
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

function createFrame(amplitude: number): Float32Array {
  return new Float32Array(128).fill(amplitude);
}

describe("GlobalPlayer audio effects cutover", () => {
  beforeEach(() => {
    setViewportWidth(1280);
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("creates AudioContext only after first play and persists effect preferences", async () => {
    const audioContextMock = installAudioContextMock();

    let unmount: (() => void) | null = null;
    try {
      ({ unmount } = render(<App />));
      fireEvent.click(screen.getByRole("button", { name: "Load A" }));

      expect(audioContextMock.instances).toHaveLength(0);

      fireEvent.click(screen.getByRole("button", { name: "More controls" }));
      fireEvent.click(screen.getByRole("button", { name: "Audio effects" }));
      fireEvent.click(screen.getByRole("checkbox", { name: "Silence trimming" }));
      fireEvent.change(screen.getByRole("combobox", { name: "Volume boost" }), {
        target: { value: "medium" },
      });
      fireEvent.click(screen.getByRole("checkbox", { name: "Mono audio" }));

      expect(window.localStorage.getItem("podcast_effects_silence_trim")).toBe("true");
      expect(window.localStorage.getItem("podcast_effects_volume_boost")).toBe("medium");
      expect(window.localStorage.getItem("podcast_effects_mono")).toBe("true");
      expect(screen.getByRole("button", { name: "Audio effects" })).toHaveAttribute(
        "data-active",
        "true"
      );

      const audio = screen.getByLabelText("Global podcast player") as HTMLAudioElement;
      vi.spyOn(audio, "play").mockResolvedValue(undefined);
      fireEvent.mouseDown(screen.getByRole("button", { name: "Play global player" }));
      fireEvent.click(screen.getByRole("button", { name: "Play global player" }));

      await waitFor(() => {
        expect(audioContextMock.instances).toHaveLength(1);
      });

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
    window.localStorage.setItem("podcast_effects_silence_trim", "true");
    window.localStorage.setItem("podcast_effects_volume_boost", "high");
    window.localStorage.setItem("podcast_effects_mono", "true");

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Load A" }));
    fireEvent.click(screen.getByRole("button", { name: "More controls" }));
    fireEvent.click(screen.getByRole("button", { name: "Audio effects" }));

    expect(screen.getByRole("checkbox", { name: "Silence trimming" })).toBeChecked();
    expect(screen.getByRole("combobox", { name: "Volume boost" })).toHaveValue("high");
    expect(screen.getByRole("checkbox", { name: "Mono audio" })).toBeChecked();
    expect(screen.getByRole("button", { name: "Audio effects" })).toHaveAttribute("data-active", "true");
  });

  it("speeds through sustained silence at 6x, restores user speed, and tracks time saved", async () => {
    const audioContextMock = installAudioContextMock();
    const raf = installAnimationFrameHarness();

    let unmount: (() => void) | null = null;
    try {
      ({ unmount } = render(<App />));
      fireEvent.click(screen.getByRole("button", { name: "Load A" }));

      const audio = screen.getByLabelText("Global podcast player") as HTMLAudioElement;
      vi.spyOn(audio, "play").mockResolvedValue(undefined);
      fireEvent.click(screen.getByRole("button", { name: "More controls" }));
      fireEvent.change(screen.getByRole("combobox", { name: "Playback speed" }), {
        target: { value: "1.5" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Audio effects" }));
      fireEvent.click(screen.getByRole("checkbox", { name: "Silence trimming" }));
      fireEvent.mouseDown(screen.getByRole("button", { name: "Play global player" }));
      fireEvent.click(screen.getByRole("button", { name: "Play global player" }));
      fireEvent(audio, new Event("play"));

      await waitFor(() => {
        expect(audioContextMock.instances).toHaveLength(1);
      });

      const analyser = audioContextMock.instances[0].analyserNode;
      for (let index = 0; index < 8; index += 1) {
        analyser.pushFrame(createFrame(0));
      }
      raf.runFrames(8, 100);

      await waitFor(() => {
        expect(audio.playbackRate).toBeCloseTo(6, 2);
      });
      // Reopen popover to see effects indicators (popover closed on Play click)
      fireEvent.click(screen.getByRole("button", { name: "More controls" }));
      expect(screen.getByText("Trimming silence")).toBeVisible();

      setAudioMetrics(audio, { duration: 180, currentTime: 10 });
      fireEvent(audio, new Event("durationchange"));
      fireEvent(audio, new Event("timeupdate"));
      expect(screen.getByText(/00:10 \/ 03:00/i)).toBeInTheDocument();

      for (let index = 0; index < 4; index += 1) {
        analyser.pushFrame(createFrame(0));
      }
      raf.runFrames(4, 100);

      const savedLabel = screen.getByText(/^Time saved:/i).textContent ?? "";
      const savedMatch = savedLabel.match(/([\d.]+)s/);
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
      fireEvent.click(screen.getByRole("button", { name: "Load A" }));

      const audio = screen.getByLabelText("Global podcast player") as HTMLAudioElement;
      const playSpy = vi.spyOn(audio, "play").mockResolvedValue(undefined);
      const pauseSpy = vi.spyOn(audio, "pause").mockImplementation(() => {});
      fireEvent.mouseDown(screen.getByRole("button", { name: "Play global player" }));
      fireEvent.click(screen.getByRole("button", { name: "Play global player" }));

      await waitFor(() => {
        expect(audioContextMock.instances).toHaveLength(1);
      });

      fireEvent.click(screen.getByRole("button", { name: "More controls" }));
      fireEvent.click(screen.getByRole("button", { name: "Audio effects" }));
      fireEvent.click(screen.getByRole("checkbox", { name: "Mono audio" }));

      const instance = audioContextMock.instances[0];
      expect(playSpy).toHaveBeenCalledTimes(1);
      expect(pauseSpy).not.toHaveBeenCalled();
      expect(screen.getByRole("checkbox", { name: "Mono audio" })).toBeChecked();
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
      fireEvent.click(screen.getByRole("button", { name: "Load A" }));

      const audio = screen.getByLabelText("Global podcast player") as HTMLAudioElement;
      const playSpy = vi.spyOn(audio, "play").mockResolvedValue(undefined);
      fireEvent.mouseDown(screen.getByRole("button", { name: "Play global player" }));
      fireEvent.click(screen.getByRole("button", { name: "Play global player" }));

      await waitFor(() => {
        expect(audioContextMock.instances).toHaveLength(1);
      });
      expect(playSpy).toHaveBeenCalled();

      fireEvent.click(screen.getByRole("button", { name: "More controls" }));
      fireEvent.click(screen.getByRole("button", { name: "Audio effects" }));
      expect(screen.getByText("Audio effects unavailable for this source.")).toBeVisible();
      expect(screen.getByRole("checkbox", { name: "Silence trimming" })).toBeDisabled();
      expect(screen.getByRole("combobox", { name: "Volume boost" })).toBeDisabled();
      expect(screen.getByRole("checkbox", { name: "Mono audio" })).toBeDisabled();
    } finally {
      unmount?.();
      audioContextMock.restore();
    }
  });
});
