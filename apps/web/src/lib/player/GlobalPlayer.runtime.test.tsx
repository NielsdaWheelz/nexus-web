import type { ReactNode } from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { absent, present } from "@/lib/api/presence";
import { assumeDiscoveryTargetHandle } from "@/lib/browse/contract";
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
const MEDIA_C = "77777777-7777-4777-8777-777777777777";
const MEDIA_D = "88888888-8888-4888-8888-888888888888";
const PODCAST_A = "33333333-3333-4333-8333-333333333333";
const PODCAST_B = "44444444-4444-4444-8444-444444444444";
let restoreAudioContext: (() => void) | null = null;

function podcastRateDescriptor(
  mediaId: string,
  title: string,
  value: number,
  podcastId: string,
  podcastValue: number,
) {
  return buildPlayerDescriptor(mediaId, title, {
    playbackRate: {
      value,
      source: value === podcastValue ? "Podcast" : "Episode",
      podcastPreference: present({
        podcastId,
        value: present(podcastValue),
      }),
    },
  });
}

function settingsResponse(
  podcastId: string,
  defaultPlaybackSpeed: number,
) {
  return {
    data: {
      user_id: "55555555-5555-4555-8555-555555555555",
      podcast_id: podcastId,
      default_playback_speed: present(defaultPlaybackSpeed),
      pause_shortening_mode: absent(),
      auto_queue: false,
      sync_status: "Complete",
      sync_error_code: null,
      sync_error_message: null,
      sync_attempts: 0,
      sync_started_at: null,
      sync_completed_at: null,
      last_checked_at: null,
      updated_at: "2026-07-30T00:00:00Z",
      backfill: {
        id: "66666666-6666-4666-8666-666666666666",
        state: "Complete",
        processedCount: 0,
        addedCount: 0,
      },
      collectionRevision: 1,
      libraryEntriesCollectionRevision: 1,
    },
  };
}

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

class FakeAudioContext {
  state: AudioContextState = "suspended";
  destination = new FakeAudioNode();
  capturedElements: HTMLAudioElement[] = [];
  private readonly listeners = new Set<EventListenerOrEventListenerObject>();

  createMediaElementSource(element: HTMLAudioElement): FakeAudioNode {
    this.capturedElements.push(element);
    return new FakeAudioNode();
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
            episodePlaybackRate: { kind: "Present"; value: number };
            heartbeatGeneration: string;
            heartbeatSequence: number;
          };
          return jsonResponse({
            data: {
              listeningState: {
                positionMs: body.positionMs,
                durationMs: body.durationMs,
                episodePlaybackRate: body.episodePlaybackRate,
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
            episodePlaybackRate: absent(),
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
            {String(settings.outputEffectsAvailable)}
          </output>
          <button
            type="button"
            onClick={() =>
              commands.playAudio(
                buildPlayerDescriptor(MEDIA_A, "Alpha", {
                  streamUrl: `/media/${MEDIA_A}.mp3`,
                }),
              )
            }
          >
            Play Alpha
          </button>
          <button
            type="button"
            onClick={() => {
              commands.setVolume(0.35);
              commands.setPlaybackRate(1.5);
              commands.setOutputEffects({ mono: true });
            }}
          >
            Configure effects
          </button>
          <button
            type="button"
            onClick={() =>
              commands.playAudio(
                buildPlayerDescriptor(MEDIA_B, "Bravo", {
                  streamUrl: `/media/${MEDIA_B}.mp3`,
                  playbackRate: {
                    value: 1.5,
                    source: "Episode",
                    podcastPreference: absent(),
                  },
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
      `/media/${MEDIA_B}.mp3`,
    );
    expect(secondAudio.volume).toBe(0.35);
    expect(secondAudio.preservesPitch).toBe(true);
    expect(secondAudio.playbackRate).toBe(1.5);
    expect(audioContext.instances[1]?.capturedElements).toEqual([secondAudio]);
    expect(screen.getByLabelText("effects availability")).toHaveTextContent(
      "true",
    );
  });

  it("inherits truthfully, suppresses pre-play checkpoints, and establishes on first playing", async () => {
    const { fetchMock } = installLecternPlayerFetchMock();

    function Harness() {
      const commands = usePlayerCommands();
      const settings = usePlayerSettings();
      const { resource } = useLectern();
      return (
        <>
          <output aria-label="lectern status">{resource.status}</output>
          <output aria-label="playback rate">
            {JSON.stringify(settings.playbackRate)}
          </output>
          <button
            type="button"
            onClick={() =>
              commands.playAudio(
                podcastRateDescriptor(
                  MEDIA_A,
                  "Inherited",
                  1.5,
                  PODCAST_A,
                  1.5,
                ),
              )
            }
          >
            Play inherited
          </button>
          <button type="button" onClick={commands.pause}>
            Pause
          </button>
          <button type="button" onClick={() => commands.seekTo(30_000)}>
            Seek before play
          </button>
          <button
            type="button"
            onClick={() =>
              commands.playAudio(
                buildPlayerDescriptor(MEDIA_B, "Product default", {
                  playbackRate: {
                    value: 1,
                    source: "Product",
                    podcastPreference: absent(),
                  },
                }),
              )
            }
          >
            Switch before play
          </button>
          <button type="button" onClick={commands.dismiss}>
            Dismiss before play
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
    fireEvent.click(screen.getByRole("button", { name: "Play inherited" }));
    const audio = screen.getByLabelText(
      "Media player audio",
    ) as HTMLAudioElement;
    await waitFor(() => expect(audio.playbackRate).toBe(1.5));
    expect(audio.preservesPitch).toBe(true);
    expect(screen.getByLabelText("playback rate")).toHaveTextContent(
      '"episodeRate":{"kind":"Absent"}',
    );

    fireEvent.click(screen.getByRole("button", { name: "Seek before play" }));
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    window.dispatchEvent(new Event("beforeunload"));
    fireEvent.click(screen.getByRole("button", { name: "Switch before play" }));
    await waitFor(() => expect(audio.playbackRate).toBe(1));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss before play" }));
    fireEvent.click(screen.getByRole("button", { name: "Play inherited" }));
    await Promise.resolve();
    const preplayPuts = fetchMock.mock.calls
      .filter(([input, init]) => {
        const url = new URL(String(input), "http://localhost");
        return (
          url.pathname.endsWith("/listening-state") && init?.method === "PUT"
        );
      })
      .map(([, init]) => JSON.parse(String(init?.body)));
    expect(preplayPuts).toEqual([]);

    const replayedAudio = screen.getByLabelText(
      "Media player audio",
    ) as HTMLAudioElement;
    await waitFor(() => expect(replayedAudio.playbackRate).toBe(1.5));
    fireEvent(replayedAudio, new Event("playing"));
    await waitFor(() =>
      expect(screen.getByLabelText("playback rate")).toHaveTextContent(
        '"episodeRate":{"kind":"Present","value":1.5}',
      ),
    );
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([input, init]) => {
          const url = new URL(String(input), "http://localhost");
          if (
            !url.pathname.endsWith("/listening-state") ||
            init?.method !== "PUT"
          ) {
            return false;
          }
          const body = JSON.parse(String(init.body)) as {
            episodePlaybackRate: unknown;
          };
          return (
            JSON.stringify(body.episodePlaybackRate) ===
            JSON.stringify(present(1.5))
          );
        }),
      ).toBe(true),
    );
  });

  it("owns temporary, source-boundary, echo, and external ratechange semantics", async () => {
    const { fetchMock } = installLecternPlayerFetchMock();

    function Harness() {
      const commands = usePlayerCommands();
      const settings = usePlayerSettings();
      const { state } = usePlayerSession();
      const { resource } = useLectern();
      return (
        <>
          <output aria-label="lectern status">{resource.status}</output>
          <output aria-label="player state">{state.kind}</output>
          <output aria-label="playback rate">
            {JSON.stringify(settings.playbackRate)}
          </output>
          <button
            type="button"
            onClick={() =>
              commands.playAudio(
                podcastRateDescriptor(
                  MEDIA_A,
                  "Established",
                  1.8,
                  PODCAST_A,
                  1.5,
                ),
              )
            }
          >
            Play established
          </button>
          <button
            type="button"
            onClick={commands.toggleTemporaryNormalRate}
          >
            Toggle normal
          </button>
          <button type="button" onClick={commands.pause}>
            Checkpoint
          </button>
          <button
            type="button"
            onClick={() =>
              commands.playAudio(
                podcastRateDescriptor(
                  MEDIA_B,
                  "Inherited next",
                  2,
                  PODCAST_B,
                  2,
                ),
              )
            }
          >
            Play next
          </button>
          <button type="button" onClick={() => commands.setPlaybackRate(1.85)}>
            Set 1.85
          </button>
          <button type="button" onClick={commands.previous}>
            Previous history
          </button>
          <button type="button" onClick={commands.next}>
            Next history
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
    fireEvent.click(screen.getByRole("button", { name: "Play established" }));
    const audio = screen.getByLabelText(
      "Media player audio",
    ) as HTMLAudioElement;
    await waitFor(() => expect(audio.playbackRate).toBe(1.8));

    fireEvent.click(screen.getByRole("button", { name: "Set 1.85" }));
    await waitFor(() => expect(audio.playbackRate).toBe(1.85));
    fireEvent.click(screen.getByRole("button", { name: "Toggle normal" }));
    expect(audio.playbackRate).toBe(1);
    expect(screen.getByLabelText("playback rate")).toHaveTextContent(
      '"temporaryNormal":true',
    );
    fetchMock.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Checkpoint" }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([input, init]) => {
          const url = new URL(String(input), "http://localhost");
          if (
            !url.pathname.endsWith("/listening-state") ||
            init?.method !== "PUT"
          ) {
            return false;
          }
          const body = JSON.parse(String(init.body)) as {
            episodePlaybackRate: unknown;
          };
          return (
            JSON.stringify(body.episodePlaybackRate) ===
            JSON.stringify(present(1.85))
          );
        }),
      ).toBe(true),
    );
    fireEvent.click(screen.getByRole("button", { name: "Toggle normal" }));
    expect(audio.playbackRate).toBe(1.85);
    expect(screen.getByLabelText("playback rate")).toHaveTextContent(
      '"temporaryNormal":false',
    );

    fireEvent.click(screen.getByRole("button", { name: "Toggle normal" }));
    expect(audio.playbackRate).toBe(1);
    audio.playbackRate = 1.9;
    await waitFor(() =>
      expect(screen.getByLabelText("playback rate")).toHaveTextContent(
        '"preferred":1.9',
      ),
    );
    expect(screen.getByLabelText("playback rate")).toHaveTextContent(
      '"temporaryNormal":false',
    );

    fireEvent.click(screen.getByRole("button", { name: "Toggle normal" }));
    expect(audio.playbackRate).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Play next" }));
    await waitFor(() => expect(audio.playbackRate).toBe(2));
    expect(screen.getByLabelText("playback rate")).toHaveTextContent(
      '"temporaryNormal":false',
    );
    expect(screen.getByLabelText("playback rate")).toHaveTextContent(
      '"episodeRate":{"kind":"Absent"}',
    );

    // Chromium may coalesce multiple owned writes into duplicate ratechange
    // observations of the final value. Both echoes remain owned and must not
    // establish this untouched successor.
    fireEvent(audio, new Event("ratechange"));
    fireEvent(audio, new Event("ratechange"));
    expect(screen.getByLabelText("playback rate")).toHaveTextContent(
      '"episodeRate":{"kind":"Absent"}',
    );

    fireEvent.click(screen.getByRole("button", { name: "Previous history" }));
    await waitFor(() => expect(audio.playbackRate).toBe(1.9));
    expect(screen.getByLabelText("playback rate")).toHaveTextContent(
      '"episodeRate":{"kind":"Present","value":1.9}',
    );
    fireEvent.click(screen.getByRole("button", { name: "Next history" }));
    await waitFor(() => expect(audio.playbackRate).toBe(2));
    expect(screen.getByLabelText("playback rate")).toHaveTextContent(
      '"episodeRate":{"kind":"Absent"}',
    );

    fetchMock.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Set 1.85" }));
    // Race an external write ahead of the owned ratechange echo. The
    // mismatched observation must retire the 1.85 token; otherwise a later
    // genuine external return to 1.85 is swallowed as that stale echo.
    audio.playbackRate = 1.9;
    await waitFor(() =>
      expect(screen.getByLabelText("playback rate")).toHaveTextContent(
        '"preferred":1.9',
      ),
    );
    audio.playbackRate = 1.85;
    await waitFor(() =>
      expect(screen.getByLabelText("playback rate")).toHaveTextContent(
        '"preferred":1.85',
      ),
    );
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([input, init]) => {
          const url = new URL(String(input), "http://localhost");
          return (
            url.pathname.endsWith("/listening-state") &&
            init?.method === "PUT" &&
            init.keepalive !== true
          );
        }),
      ).toHaveLength(3),
    );

    audio.playbackRate = 4;
    await waitFor(() =>
      expect(screen.getByLabelText("player state")).toHaveTextContent(
        "PlaybackFailed",
      ),
    );
  });

  it("enters modeled failure when an in-range playback rate is rejected", async () => {
    installLecternPlayerFetchMock();

    function Harness() {
      const commands = usePlayerCommands();
      const { resource } = useLectern();
      const { state } = usePlayerSession();
      return (
        <>
          <output aria-label="lectern status">{resource.status}</output>
          <output aria-label="player state">{state.kind}</output>
          <button
            type="button"
            onClick={() =>
              commands.playAudio(
                buildPlayerDescriptor(MEDIA_A, "Established", {
                  playbackRate: {
                    value: 1.5,
                    source: "Episode",
                    podcastPreference: absent(),
                  },
                }),
              )
            }
          >
            Play
          </button>
          <button type="button" onClick={() => commands.setPlaybackRate(1.7)}>
            Set rejected rate
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
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    const audio = screen.getByLabelText(
      "Media player audio",
    ) as HTMLAudioElement;
    await waitFor(() => expect(audio.playbackRate).toBe(1.5));
    let observed = audio.playbackRate;
    Object.defineProperty(audio, "playbackRate", {
      configurable: true,
      get: () => observed,
      set: (rate: number) => {
        if (rate === 1.7) {
          throw new DOMException("Playback rate rejected", "NotSupportedError");
        }
        observed = rate;
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "Set rejected rate" }));
    expect(audio.playbackRate).toBe(1.5);
    expect(screen.getByLabelText("player state")).toHaveTextContent(
      "PlaybackFailed",
    );
  });

  it("owns Remember pending, matching install, and lapsed-subscription failure", async () => {
    const { fetchMock } = installLecternPlayerFetchMock();
    const baseFetch = fetchMock.getMockImplementation();
    let patchCount = 0;
    let resolveFirstPatch: ((response: Response) => void) | null = null;
    let resolveSecondPatch: ((response: Response) => void) | null = null;
    fetchMock.mockImplementation((input, init) => {
      const url = new URL(String(input), "http://localhost");
      if (
        url.pathname ===
          `/api/podcasts/subscriptions/${PODCAST_A}/settings` &&
        init?.method === "PATCH"
      ) {
        patchCount += 1;
        if (patchCount === 1) {
          return new Promise<Response>((resolve) => {
            resolveFirstPatch = resolve;
          });
        }
        return new Promise<Response>((resolve) => {
          resolveSecondPatch = resolve;
        });
      }
      if (baseFetch === undefined) throw new Error("Missing base fetch mock");
      return baseFetch(input, init);
    });

    function Harness() {
      const commands = usePlayerCommands();
      const settings = usePlayerSettings();
      const { resource } = useLectern();
      return (
        <>
          <output aria-label="lectern status">{resource.status}</output>
          <output aria-label="playback rate">
            {JSON.stringify(settings.playbackRate)}
          </output>
          <button
            type="button"
            onClick={() =>
              commands.playAudio(
                podcastRateDescriptor(
                  MEDIA_A,
                  "Rememberable",
                  1.8,
                  PODCAST_A,
                  1.5,
                ),
              )
            }
          >
            Play
          </button>
          <button
            type="button"
            onClick={commands.rememberPlaybackRateForPodcast}
          >
            Remember
          </button>
          <button type="button" onClick={() => commands.setPlaybackRate(2)}>
            Set 2
          </button>
          <button
            type="button"
            onClick={() =>
              commands.playAudio(
                podcastRateDescriptor(
                  MEDIA_B,
                  "Untouched same podcast",
                  1.5,
                  PODCAST_A,
                  1.5,
                ),
              )
            }
          >
            Play untouched same podcast
          </button>
          <button
            type="button"
            onClick={() =>
              commands.playAudio(
                podcastRateDescriptor(
                  MEDIA_C,
                  "Established same podcast",
                  1.25,
                  PODCAST_A,
                  1.5,
                ),
              )
            }
          >
            Play established same podcast
          </button>
          <button
            type="button"
            onClick={() =>
              commands.playAudio(
                podcastRateDescriptor(
                  MEDIA_D,
                  "Untouched other podcast",
                  2,
                  PODCAST_B,
                  2,
                ),
              )
            }
          >
            Play untouched other podcast
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
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    fireEvent.click(screen.getByRole("button", { name: "Remember" }));
    expect(screen.getByLabelText("playback rate")).toHaveTextContent(
      '"remember":{"kind":"Pending"}',
    );
    await waitFor(() => expect(patchCount).toBe(1));
    fireEvent.click(
      screen.getByRole("button", { name: "Play untouched same podcast" }),
    );
    expect(screen.getByLabelText("playback rate")).toHaveTextContent(
      '"remember":{"kind":"Pending"}',
    );
    fireEvent.click(screen.getByRole("button", { name: "Remember" }));
    expect(patchCount).toBe(1);
    act(() => {
      resolveFirstPatch?.(jsonResponse(settingsResponse(PODCAST_A, 1.8)));
    });
    await waitFor(() =>
      expect(screen.getByLabelText("playback rate")).toHaveTextContent(
        '"remember":{"kind":"Ready"}',
      ),
    );
    expect(screen.getByLabelText("playback rate")).toHaveTextContent(
      '"value":{"kind":"Present","value":1.8}',
    );

    await waitFor(() =>
      expect(screen.getByLabelText("playback rate")).toHaveTextContent(
        '"preferred":1.8',
      ),
    );
    expect(screen.getByLabelText("playback rate")).toHaveTextContent(
      '"episodeRate":{"kind":"Absent"}',
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Play established same podcast" }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("playback rate")).toHaveTextContent(
        '"preferred":1.25',
      ),
    );
    expect(screen.getByLabelText("playback rate")).toHaveTextContent(
      '"value":{"kind":"Present","value":1.8}',
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Play untouched other podcast" }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("playback rate")).toHaveTextContent(
        '"preferred":2',
      ),
    );
    expect(screen.getByLabelText("playback rate")).toHaveTextContent(
      `"podcastId":"${PODCAST_B}"`,
    );

    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    await waitFor(() =>
      expect(screen.getByLabelText("playback rate")).toHaveTextContent(
        '"preferred":1.8',
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Set 2" }));
    fireEvent.click(screen.getByRole("button", { name: "Remember" }));
    expect(screen.getByLabelText("playback rate")).toHaveTextContent(
      '"remember":{"kind":"Pending"}',
    );
    await waitFor(() => expect(patchCount).toBe(2));
    fireEvent.click(
      screen.getByRole("button", { name: "Play established same podcast" }),
    );
    expect(screen.getByLabelText("playback rate")).toHaveTextContent(
      '"remember":{"kind":"Pending"}',
    );
    act(() => {
      resolveSecondPatch?.(
        jsonResponse(
          {
            error: {
              code: "E_NOT_FOUND",
              message: "Subscription not found",
            },
          },
          404,
        ),
      );
    });
    await waitFor(() =>
      expect(screen.getByLabelText("playback rate")).toHaveTextContent(
        '"retryable":false',
      ),
    );
    expect(screen.getByLabelText("playback rate")).toHaveTextContent(
      '"podcastPreference":{"kind":"Absent"}',
    );
    expect(screen.getByLabelText("playback rate")).toHaveTextContent(
      '"preferred":1.25',
    );
  });

  it("keeps Preview rate local and emits no durable mutation", async () => {
    const { fetchMock } = installLecternPlayerFetchMock();

    function Harness() {
      const commands = usePlayerCommands();
      const settings = usePlayerSettings();
      const { resource } = useLectern();
      return (
        <>
          <output aria-label="lectern status">{resource.status}</output>
          <output aria-label="playback rate">
            {JSON.stringify(settings.playbackRate)}
          </output>
          <button
            type="button"
            onClick={() =>
              commands.playPreviewAudio({
                target: assumeDiscoveryTargetHandle(
                  "ndt1.eA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                ),
                previewHref: "/browse/preview",
                title: "Preview",
                source: "Archive",
                sourceHref: "https://example.com/source",
                audioUrl: "https://cdn.example.com/preview.mp3",
                imageUrl: absent(),
                durationMs: absent(),
              })
            }
          >
            Preview
          </button>
          <button type="button" onClick={() => commands.setPlaybackRate(1.85)}>
            Set preview rate
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
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    const audio = screen.getByLabelText(
      "Media player audio",
    ) as HTMLAudioElement;
    await waitFor(() => expect(audio.playbackRate).toBe(1));
    fireEvent.click(screen.getByRole("button", { name: "Set preview rate" }));
    await waitFor(() => expect(audio.playbackRate).toBe(1.85));
    expect(screen.getByLabelText("playback rate")).toHaveTextContent(
      '"scope":{"kind":"Preview"}',
    );
    expect(
      fetchMock.mock.calls.some(([input, init]) => {
        const url = new URL(String(input), "http://localhost");
        return (
          url.pathname.endsWith("/listening-state") ||
          init?.method === "PATCH"
        );
      }),
    ).toBe(false);
  });

  it("keeps command identity and command-only consumers stable across every other capability cadence", async () => {
    const audioContext = installAudioContext();
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
              commands.playAudio(
                buildPlayerDescriptor(MEDIA_A, "Alpha", {
                  streamUrl: `/media/${MEDIA_A}.mp3`,
                }),
              )
            }
          >
            Play
          </button>
          <button type="button" onClick={() => commands.setVolume(0.4)}>
            Set volume
          </button>
          <button
            type="button"
            onClick={() => commands.setOutputEffects({ mono: true })}
          >
            Enable mono output
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
      const { bufferedMs, positionMs } = usePlayerTimeline();
      return (
        <output aria-label="timeline cadence">
          {positionMs}:{bufferedMs}
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

    fireEvent.click(screen.getByRole("button", { name: "Enable mono output" }));
    expect(audioContext.instances).toHaveLength(1);

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
