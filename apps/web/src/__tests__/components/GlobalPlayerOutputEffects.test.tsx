import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import GlobalPlayerSurfaces from "@/components/player/GlobalPlayerSurfaces";
import { MobileViewportProvider } from "@/lib/mobileViewport/MobileViewportProvider";
import { WorkspaceTestProvider } from "@/__tests__/helpers/WorkspaceTestProvider";
import { LecternProvider, useLectern } from "@/lib/lectern/LecternProvider";
import {
  GlobalPlayerProvider,
  usePlayerCommands,
} from "@/lib/player/globalPlayer";
import {
  buildPlayerDescriptor,
  installLecternPlayerFetchMock,
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
  gainNodes: FakeGainNode[];
  compressorNodes: FakeDynamicsCompressorNode[];
  splitterNodes: FakeAudioNode[];
  mergerNodes: FakeAudioNode[];
  createMediaElementSource: ReturnType<typeof vi.fn>;
  createGain: ReturnType<typeof vi.fn>;
  createDynamicsCompressor: ReturnType<typeof vi.fn>;
  createChannelSplitter: ReturnType<typeof vi.fn>;
  createChannelMerger: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
  addEventListener: ReturnType<typeof vi.fn>;
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

    addEventListener = vi.fn();

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

function Harness({ streamUrl }: { streamUrl: string }) {
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
              { streamUrl },
            ),
          )
        }
      >
        Play episode
      </button>
      <button
        type="button"
        onClick={() =>
          playAudio(
            buildPlayerDescriptor(
              "22222222-2222-4222-8222-222222222222",
              "External episode",
              {
                streamUrl: "https://cdn.example.com/external-episode.mp3",
              },
            ),
          )
        }
      >
        Play external episode
      </button>
      <MobileViewportProvider>
        <GlobalPlayerSurfaces />
      </MobileViewportProvider>
    </>
  );
}

function App({ streamUrl = "/audio/episode-alpha.mp3" }: { streamUrl?: string }) {
  return (
    <WorkspaceTestProvider>
      <LecternProvider>
        <GlobalPlayerProvider>
          <Harness streamUrl={streamUrl} />
        </GlobalPlayerProvider>
      </LecternProvider>
    </WorkspaceTestProvider>
  );
}

async function openOutputEffects() {
  await screen.findByText("ready", {
    selector: '[data-testid="lectern-status"]',
  });
  fireEvent.click(screen.getByRole("button", { name: "Play episode" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Playback speed, normal" }),
  );
  expect(screen.getByRole("heading", { name: "Output effects" })).toBeVisible();
}

describe("GlobalPlayer browser output effects", () => {
  beforeEach(() => {
    setViewportWidth(1280);
    window.localStorage.clear();
    installLecternPlayerFetchMock();
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps baseline playback raw and creates Web Audio only for an enabled output effect", async () => {
    const audioContextMock = installAudioContextMock();
    const { unmount } = render(<App />);
    try {
      await openOutputEffects();
      expect(audioContextMock.instances).toHaveLength(0);

      fireEvent.change(
        screen.getByRole("combobox", { name: "Volume boost" }),
        { target: { value: "medium" } },
      );

      await waitFor(() => {
        expect(audioContextMock.instances).toHaveLength(1);
      });
      expect(
        window.localStorage.getItem("podcast_effects_volume_boost"),
      ).toBe("medium");
      const instance = audioContextMock.instances[0];
      expect(instance.resume).toHaveBeenCalled();
      expect(instance.gainNodes[0]?.gain.value).toBe(2);
      expect(instance.compressorNodes).toHaveLength(1);
    } finally {
      unmount();
      audioContextMock.restore();
    }
  });

  it("restores only volume boost and mono preferences", async () => {
    const audioContextMock = installAudioContextMock();
    window.localStorage.setItem("podcast_effects_volume_boost", "high");
    window.localStorage.setItem("podcast_effects_mono", "true");
    const { unmount } = render(<App />);
    try {
      await openOutputEffects();
      expect(
        screen.getByRole("combobox", { name: "Volume boost" }),
      ).toHaveValue("high");
      expect(
        screen.getByRole("checkbox", { name: "Mono audio" }),
      ).toBeChecked();
      expect(audioContextMock.instances).toHaveLength(1);
    } finally {
      unmount();
      audioContextMock.restore();
    }
  });

  it("routes a captured source directly to the destination after every effect is disabled", async () => {
    const audioContextMock = installAudioContextMock();
    const { unmount } = render(<App />);
    try {
      await openOutputEffects();
      const boost = screen.getByRole("combobox", { name: "Volume boost" });
      fireEvent.change(boost, { target: { value: "medium" } });
      await waitFor(() => {
        expect(audioContextMock.instances).toHaveLength(1);
      });
      const instance = audioContextMock.instances[0];

      fireEvent.change(boost, { target: { value: "off" } });

      expect(instance.sourceNode.disconnect).toHaveBeenCalled();
      expect(instance.sourceNode.connect).toHaveBeenLastCalledWith(
        instance.destination,
      );
    } finally {
      unmount();
      audioContextMock.restore();
    }
  });

  it("replaces the controls when a source cannot enter the browser graph", async () => {
    const audioContextMock = installAudioContextMock({ throwOnSource: true });
    const { unmount } = render(<App />);
    try {
      await openOutputEffects();
      fireEvent.change(
        screen.getByRole("combobox", { name: "Volume boost" }),
        { target: { value: "medium" } },
      );
      await waitFor(() => {
        expect(audioContextMock.instances).toHaveLength(1);
      });
      expect(
        screen.getByText("Output effects unavailable for this source."),
      ).toBeVisible();
      expect(
        screen.queryByRole("combobox", { name: "Volume boost" }),
      ).toBeNull();
      expect(
        screen.queryByRole("checkbox", { name: "Mono audio" }),
      ).toBeNull();
    } finally {
      unmount();
      audioContextMock.restore();
    }
  });

  it("never graph-captures an external enclosure and leaves raw playback active", async () => {
    const audioContextMock = installAudioContextMock();
    const { unmount } = render(
      <App streamUrl="https://cdn.example.com/episode-alpha.mp3" />,
    );
    try {
      await screen.findByText("ready", {
        selector: '[data-testid="lectern-status"]',
      });
      fireEvent.click(screen.getByRole("button", { name: "Play episode" }));
      expect(
        screen.getByLabelText("Media player audio"),
      ).toHaveAttribute(
        "src",
        "https://cdn.example.com/episode-alpha.mp3",
      );
      fireEvent.click(
        screen.getByRole("button", { name: "Playback speed, normal" }),
      );
      expect(
        screen.getByText("Output effects unavailable for this source."),
      ).toBeVisible();
      expect(audioContextMock.instances).toHaveLength(0);
    } finally {
      unmount();
      audioContextMock.restore();
    }
  });

  it("rotates a captured same-origin element before loading an external enclosure", async () => {
    const audioContextMock = installAudioContextMock();
    const { unmount } = render(<App />);
    try {
      await openOutputEffects();
      const firstAudio = screen.getByLabelText("Media player audio");
      fireEvent.change(
        screen.getByRole("combobox", { name: "Volume boost" }),
        { target: { value: "medium" } },
      );
      await waitFor(() => {
        expect(audioContextMock.instances).toHaveLength(1);
      });
      expect(
        audioContextMock.instances[0]?.createMediaElementSource,
      ).toHaveBeenCalledWith(firstAudio);

      fireEvent.click(
        screen.getByRole("button", { name: "Play external episode" }),
      );

      const secondAudio = await screen.findByLabelText("Media player audio");
      expect(secondAudio).not.toBe(firstAudio);
      expect(secondAudio).toHaveAttribute(
        "src",
        "https://cdn.example.com/external-episode.mp3",
      );
      fireEvent.click(
        screen.getByRole("button", { name: "Playback speed, normal" }),
      );
      expect(
        screen.getByText("Output effects unavailable for this source."),
      ).toBeVisible();
      expect(
        audioContextMock.instances[0]?.createMediaElementSource,
      ).toHaveBeenCalledTimes(1);
    } finally {
      unmount();
      audioContextMock.restore();
    }
  });
});
