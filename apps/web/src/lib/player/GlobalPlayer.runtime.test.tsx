import type { ReactNode } from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { absent } from "@/lib/api/presence";
import {
  LecternProvider,
  useLectern,
} from "@/lib/lectern/LecternProvider";
import { assumeMediaId } from "@/lib/lectern/contract";
import {
  GlobalPlayerProvider,
  usePlayerCommands,
  usePlayerSession,
  usePlayerSettings,
  usePlayerTimeline,
  type PlayerCommandsCapability,
} from "@/lib/player/globalPlayer";
import {
  buildPlayerDescriptor,
  installLecternPlayerFetchMock,
  jsonResponse,
  setAudioMetrics,
} from "@/__tests__/helpers/audio";

const MEDIA_A = "11111111-1111-4111-8111-111111111111";
const MEDIA_B = "22222222-2222-4222-8222-222222222222";
let restoreAudioContext: (() => void) | null = null;

class FakeAudioNode {
  connect(target: FakeAudioNode): FakeAudioNode {
    return target;
  }

  disconnect(): void {}
}

class FakeGainNode extends FakeAudioNode {
  gain = { value: 1 };
}

class FakeCompressorNode extends FakeAudioNode {
  threshold = { value: 0 };
  knee = { value: 0 };
  ratio = { value: 0 };
  attack = { value: 0 };
  release = { value: 0 };
}

class FakeAnalyserNode extends FakeAudioNode {
  fftSize = 128;

  getFloatTimeDomainData(target: Float32Array): void {
    target.fill(0);
  }
}

class FakeAudioContext {
  state: AudioContextState = "suspended";
  destination = new FakeAudioNode();
  capturedElements: HTMLAudioElement[] = [];
  private readonly listeners = new Set<EventListenerOrEventListenerObject>();

  createMediaElementSource(element: HTMLAudioElement): FakeAudioNode {
    this.capturedElements.push(element);
    return new FakeAudioNode();
  }

  createAnalyser(): FakeAnalyserNode {
    return new FakeAnalyserNode();
  }

  createGain(): FakeGainNode {
    return new FakeGainNode();
  }

  createDynamicsCompressor(): FakeCompressorNode {
    return new FakeCompressorNode();
  }

  createChannelSplitter(): FakeAudioNode {
    return new FakeAudioNode();
  }

  createChannelMerger(): FakeAudioNode {
    return new FakeAudioNode();
  }

  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
  ): void {
    if (type === "statechange") this.listeners.add(listener);
  }

  async resume(): Promise<void> {
    this.state = "running";
  }

  async suspend(): Promise<void> {
    if (this.state !== "closed") this.state = "suspended";
  }

  async close(): Promise<void> {
    this.state = "closed";
  }

  closeUnexpectedly(): void {
    this.state = "closed";
    const event = new Event("statechange");
    for (const listener of this.listeners) {
      if (typeof listener === "function") {
        listener(event);
      } else {
        listener.handleEvent(event);
      }
    }
  }
}

function installAudioContext() {
  const descriptor = Object.getOwnPropertyDescriptor(window, "AudioContext");
  const instances: FakeAudioContext[] = [];
  class TestAudioContext extends FakeAudioContext {
    constructor() {
      super();
      instances.push(this);
    }
  }
  Object.defineProperty(window, "AudioContext", {
    configurable: true,
    value: TestAudioContext,
  });
  restoreAudioContext = () => {
    if (descriptor === undefined) {
      Reflect.deleteProperty(window, "AudioContext");
    } else {
      Object.defineProperty(window, "AudioContext", descriptor);
    }
  };
  return {
    instances,
  };
}

function installAnimationFrames() {
  let nextId = 0;
  let timestampMs = 0;
  const callbacks = new Map<number, FrameRequestCallback>();
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    nextId += 1;
    callbacks.set(nextId, callback);
    return nextId;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    callbacks.delete(id);
  });
  return {
    run(count: number) {
      for (let index = 0; index < count; index += 1) {
        timestampMs += 100;
        const frame = [...callbacks.values()];
        callbacks.clear();
        for (const callback of frame) callback(timestampMs);
      }
    },
  };
}

function App({ children }: { children: ReactNode }) {
  return (
    <LecternProvider>
      <GlobalPlayerProvider>{children}</GlobalPlayerProvider>
    </LecternProvider>
  );
}

describe("GlobalPlayer runtime", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  });

  afterEach(() => {
    restoreAudioContext?.();
    restoreAudioContext = null;
    vi.restoreAllMocks();
  });

  it("dismisses a parked completion without swallowing the next session's natural end", async () => {
    const commandBodies: Array<{
      kind: string;
      clientMutationId: string;
      mediaId: string;
    }> = [];
    let failedId: string | null = null;

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input), "http://localhost");
      const method = init?.method ?? "GET";
      if (url.pathname === "/api/lectern" && method === "GET") {
        return jsonResponse({ data: { items: [] } });
      }
      if (
        url.pathname === "/api/consumption/commands" &&
        method === "POST"
      ) {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          kind: string;
          clientMutationId: string;
          mediaId: string;
        };
        commandBodies.push(body);
        if (failedId === null) {
          failedId = body.clientMutationId;
          return jsonResponse(
            { error: { code: "E_NETWORK", message: "Unavailable" } },
            503,
          );
        }
        return jsonResponse({
          data: {
            outcome: { kind: "StateOnly" },
            lectern: { items: [] },
            nextItem: absent(),
            progressState: absent(),
            completionHandle: absent(),
            libraryEntriesCollectionRevision: 1,
          },
        });
      }
      if (url.pathname.endsWith("/listening-state")) {
        if (method === "PUT") {
          const body = JSON.parse(String(init?.body ?? "{}")) as {
            positionMs: number;
            durationMs: { kind: "Absent" };
            playbackSpeed: number;
            heartbeatGeneration: string;
            heartbeatSequence: number;
          };
          return jsonResponse({
            data: {
              listeningState: {
                positionMs: body.positionMs,
                durationMs: body.durationMs,
                playbackSpeed: body.playbackSpeed,
                writeRevision: 1,
                resetEpoch: 0,
              },
              heartbeatGeneration: body.heartbeatGeneration,
              heartbeatSequence: body.heartbeatSequence,
            },
          });
        }
        return jsonResponse({
          data: {
            positionMs: 0,
            durationMs: absent(),
            playbackSpeed: 1,
            writeRevision: 0,
            resetEpoch: 0,
          },
        });
      }
      return jsonResponse({ data: {} });
    });

    function Harness() {
      const commands = usePlayerCommands();
      const { state } = usePlayerSession();
      const { mutation, resource } = useLectern();
      return (
        <>
          <output aria-label="lectern status">{resource.status}</output>
          <output aria-label="player state">{state.kind}</output>
          <button
            type="button"
            onClick={() =>
              commands.playAudio(buildPlayerDescriptor(MEDIA_A, "Alpha"))
            }
          >
            Play Alpha
          </button>
          <button type="button" onClick={commands.dismiss}>
            Close player
          </button>
          <button
            type="button"
            onClick={() =>
              commands.playAudio(buildPlayerDescriptor(MEDIA_B, "Bravo"))
            }
          >
            Play Bravo
          </button>
          {mutation.kind === "RetryableFailure" ? (
            <button type="button" onClick={mutation.retry}>
              Retry parked completion
            </button>
          ) : null}
        </>
      );
    }

    render(
      <App>
        <Harness />
      </App>,
    );
    await screen.findByText("ready", {
      selector: '[aria-label="lectern status"]',
    });
    fireEvent.click(screen.getByRole("button", { name: "Play Alpha" }));
    const audio = screen.getByLabelText(
      "Media player audio",
    ) as HTMLAudioElement;
    fireEvent(audio, new Event("ended"));
    await screen.findByRole("button", { name: "Retry parked completion" });
    expect(screen.getByLabelText("player state")).toHaveTextContent(
      "CompletionFailed",
    );

    fireEvent.click(screen.getByRole("button", { name: "Close player" }));
    expect(screen.getByLabelText("player state")).toHaveTextContent("Absent");
    fireEvent.click(screen.getByRole("button", { name: "Play Bravo" }));
    fireEvent(audio, new Event("ended"));
    expect(screen.getByLabelText("player state")).toHaveTextContent(
      "Completing",
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Retry parked completion" }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("player state")).toHaveTextContent(
        "PausedAtEnd",
      ),
    );

    const alpha = commandBodies.filter((body) => body.mediaId === MEDIA_A);
    const bravo = commandBodies.filter((body) => body.mediaId === MEDIA_B);
    expect(alpha).toHaveLength(2);
    expect(new Set(alpha.map((body) => body.clientMutationId)).size).toBe(1);
    expect(bravo).toHaveLength(1);
    expect(bravo[0]?.kind).toBe("EnsureMediaFinished");
  });

  it("rotates a fresh owned element before recovering effects from an unexpectedly closed context", async () => {
    const audioContext = installAudioContext();
    installLecternPlayerFetchMock();

    function Harness() {
      const commands = usePlayerCommands();
      const settings = usePlayerSettings();
      const { resource } = useLectern();
      return (
        <>
          <output aria-label="lectern status">{resource.status}</output>
          <output aria-label="effects availability">
            {String(settings.audioEffectsAvailable)}
          </output>
          <button
            type="button"
            onClick={() =>
              commands.playAudio(buildPlayerDescriptor(MEDIA_A, "Alpha"))
            }
          >
            Play Alpha
          </button>
          <button
            type="button"
            onClick={() => {
              commands.setVolume(0.35);
              commands.setPlaybackRate(1.5);
              commands.setAudioEffects({ mono: true });
            }}
          >
            Configure effects
          </button>
          <button
            type="button"
            onClick={() =>
              commands.playAudio(
                buildPlayerDescriptor(MEDIA_B, "Bravo", {
                  playbackSpeed: 1.5,
                }),
              )
            }
          >
            Play Bravo
          </button>
        </>
      );
    }

    render(
      <App>
        <Harness />
      </App>,
    );
    await screen.findByText("ready", {
      selector: '[aria-label="lectern status"]',
    });
    fireEvent.click(screen.getByRole("button", { name: "Play Alpha" }));
    const firstAudio = screen.getByLabelText(
      "Media player audio",
    ) as HTMLAudioElement;
    fireEvent.click(
      screen.getByRole("button", { name: "Configure effects" }),
    );
    expect(audioContext.instances).toHaveLength(1);
    expect(audioContext.instances[0]?.capturedElements).toEqual([firstAudio]);

    audioContext.instances[0]?.closeUnexpectedly();
    await waitFor(() =>
      expect(screen.getByLabelText("effects availability")).toHaveTextContent(
        "false",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Play Bravo" }));

    await waitFor(() => expect(audioContext.instances).toHaveLength(2));
    const secondAudio = screen.getByLabelText(
      "Media player audio",
    ) as HTMLAudioElement;
    expect(secondAudio).not.toBe(firstAudio);
    expect(firstAudio.getAttribute("src")).toBeNull();
    expect(secondAudio.getAttribute("src")).toBe(
      `https://cdn.example.com/${MEDIA_B}.mp3`,
    );
    expect(secondAudio.volume).toBe(0.35);
    expect(secondAudio.playbackRate).toBe(1.5);
    expect(audioContext.instances[1]?.capturedElements).toEqual([secondAudio]);
    expect(screen.getByLabelText("effects availability")).toHaveTextContent(
      "true",
    );
  });

  it("keeps command identity and command-only consumers stable across every other capability cadence", async () => {
    const audioContext = installAudioContext();
    const animationFrames = installAnimationFrames();
    const { fetchMock } = installLecternPlayerFetchMock();
    const renders = {
      commands: 0,
      session: 0,
      settings: 0,
      timeline: 0,
    };
    let firstCommands: PlayerCommandsCapability | null = null;

    function CommandsProbe() {
      renders.commands += 1;
      const commands = usePlayerCommands();
      firstCommands ??= commands;
      return (
        <>
          <button
            type="button"
            onClick={() =>
              commands.playAudio(buildPlayerDescriptor(MEDIA_A, "Alpha"))
            }
          >
            Play
          </button>
          <button type="button" onClick={() => commands.setVolume(0.4)}>
            Set volume
          </button>
          <button
            type="button"
            onClick={() => commands.setAudioEffects({ silenceTrim: true })}
          >
            Enable silence trimming
          </button>
        </>
      );
    }

    function SessionProbe() {
      renders.session += 1;
      const { state } = usePlayerSession();
      return <output aria-label="session cadence">{state.kind}</output>;
    }

    function SettingsProbe() {
      renders.settings += 1;
      const { volume } = usePlayerSettings();
      return <output aria-label="settings cadence">{volume}</output>;
    }

    function TimelineProbe() {
      renders.timeline += 1;
      const {
        bufferedMs,
        isSilenceTrimming,
        positionMs,
        silenceTimeSavedMs,
      } = usePlayerTimeline();
      return (
        <output aria-label="timeline cadence">
          {positionMs}:{bufferedMs}:{String(isSilenceTrimming)}:
          {silenceTimeSavedMs}
        </output>
      );
    }

    function LecternProbe() {
      const { mutation, resource, setUnread } = useLectern();
      return (
        <>
          <output aria-label="lectern status">{resource.status}</output>
          <output aria-label="mutation status">{mutation.kind}</output>
          <button
            type="button"
            onClick={() => void setUnread(assumeMediaId(MEDIA_A))}
          >
            Install Lectern snapshot
          </button>
        </>
      );
    }

    render(
      <App>
        <CommandsProbe />
        <SessionProbe />
        <SettingsProbe />
        <TimelineProbe />
        <LecternProbe />
      </App>,
    );
    await screen.findByText("ready", {
      selector: '[aria-label="lectern status"]',
    });
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    await waitFor(() =>
      expect(screen.getByLabelText("session cadence")).toHaveTextContent(
        "Active",
      ),
    );
    const audio = screen.getByLabelText(
      "Media player audio",
    ) as HTMLAudioElement;
    setAudioMetrics(audio, {
      duration: 100,
      currentTime: 10,
      bufferedEnd: 30,
    });

    fireEvent(audio, new Event("playing"));
    let baseline = { ...renders };
    fireEvent(audio, new Event("waiting"));
    expect(renders).toEqual({
      ...baseline,
      session: baseline.session + 1,
    });
    fireEvent(audio, new Event("playing"));

    baseline = { ...renders };
    fireEvent(audio, new Event("timeupdate"));
    await waitFor(() =>
      expect(screen.getByLabelText("timeline cadence")).toHaveTextContent(
        "10000",
      ),
    );
    expect(renders).toEqual({
      ...baseline,
      timeline: baseline.timeline + 1,
    });

    baseline = { ...renders };
    fireEvent(audio, new Event("progress"));
    await waitFor(() =>
      expect(screen.getByLabelText("timeline cadence")).toHaveTextContent(
        "30000",
      ),
    );
    expect(renders).toEqual({
      ...baseline,
      timeline: baseline.timeline + 1,
    });

    baseline = { ...renders };
    fireEvent.click(screen.getByRole("button", { name: "Set volume" }));
    await waitFor(() =>
      expect(screen.getByLabelText("settings cadence")).toHaveTextContent(
        "0.4",
      ),
    );
    expect(renders).toEqual({
      ...baseline,
      settings: baseline.settings + 1,
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Enable silence trimming" }),
    );
    expect(audioContext.instances).toHaveLength(1);
    fireEvent(audio, new Event("playing"));
    baseline = { ...renders };
    act(() => animationFrames.run(5));
    await waitFor(() =>
      expect(screen.getByLabelText("timeline cadence")).toHaveTextContent(
        "true",
      ),
    );
    expect(renders.commands).toBe(baseline.commands);
    expect(renders.session).toBe(baseline.session);
    expect(renders.settings).toBe(baseline.settings);
    expect(renders.timeline).toBeGreaterThan(baseline.timeline);

    baseline = { ...renders };
    fireEvent.click(
      screen.getByRole("button", { name: "Install Lectern snapshot" }),
    );
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([input, init]) => {
          const url = new URL(String(input), "http://localhost");
          return (
            url.pathname === "/api/consumption/commands" &&
            init?.method === "POST"
          );
        }),
      ).toBe(true),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("mutation status")).toHaveTextContent(
        "Idle",
      ),
    );
    expect(renders).toEqual({
      ...baseline,
      session: baseline.session + 1,
    });
    expect(firstCommands).not.toBeNull();
  });
});
