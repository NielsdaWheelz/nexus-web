import { useEffect, type ReactNode } from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import PodcastSubscriptionSettingsModal from "@/app/(authenticated)/podcasts/PodcastSubscriptionSettingsModal";
import LecternMutationNotice from "@/components/LecternMutationNotice";
import { PlayerPlaybackPanel } from "@/components/player/PlayerPlaybackControls";
import { RenderEnvironmentProvider } from "@/lib/renderEnvironment/provider";
import type { RenderEnvironment } from "@/lib/renderEnvironment/types";
import {
  LecternProvider,
  useLectern,
  type LecternCapability,
} from "@/lib/lectern/LecternProvider";
import {
  assumeMediaId,
  type MediaId,
  type PlayerDescriptor,
} from "@/lib/lectern/contract";
import {
  GlobalPlayerProvider,
  usePlayerCommands,
  usePlayerSession,
  usePlayerSettings,
  usePlayerTimeline,
} from "@/lib/player/globalPlayer";
import { NATIVE_PLAYER_COMMAND_DEADLINE_MS } from "@/lib/player/androidPlayerProtocol";
import {
  publishPodcastSubscriptionUnsubscribed,
  savePodcastSubscriptionSettings,
} from "@/lib/podcasts/subscriptionSettings";

const ACCOUNT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_ACCOUNT_ID = "abababab-abab-4bab-8bab-abababababab";
const SESSION_A = "11111111-1111-4111-8111-111111111111";
const SESSION_STALE = "22222222-2222-4222-8222-222222222222";
const MUTATION_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const MEDIA_A = assumeMediaId("dddddddd-dddd-4ddd-8ddd-dddddddddddd");
const MEDIA_B = assumeMediaId("99999999-9999-4999-8999-999999999999");
const ITEM_A = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const ITEM_B = "88888888-8888-4888-8888-888888888888";
const PODCAST_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const PODCAST_B_ID = "66666666-6666-4666-8666-666666666666";

const ANDROID_ENVIRONMENT: RenderEnvironment = {
  androidShell: true,
  platform: "android",
  displayLocale: "en-US",
  displayTimeZone: "UTC",
  currentInstant: "2026-07-30T12:00:00.000Z",
  currentLocalDate: "2026-07-30",
  initialViewport: "mobile",
};

type WireCommand = {
  kind: string;
  requestId: string;
  protocolVersion: 1;
  [key: string]: unknown;
};

type BridgeResponder = (
  command: WireCommand,
  bridge: FakeNexusPlayerBridge,
) => void;

class FakeNexusPlayerBridge {
  readonly commands: WireCommand[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  responder: BridgeResponder;

  constructor(responder: BridgeResponder) {
    this.responder = responder;
  }

  postMessage = vi.fn((message: string): void => {
    const command = JSON.parse(message) as WireCommand;
    this.commands.push(command);
    this.responder(command, this);
  });

  reply(
    command: WireCommand,
    reply:
      | { kind: "Accepted" }
      | {
          kind: "Connected" | "Snapshot";
          snapshot: Record<string, unknown>;
          pendingNaturalEnd: Record<string, unknown>;
        },
  ): void {
    this.deliver({
      ...reply,
      requestId: command.requestId,
      protocolVersion: 1,
    });
  }

  reject(
    command: WireCommand,
    code:
      | "InvalidRequest"
      | "AccountMismatch"
      | "StaleSession"
      | "NaturalEndPending"
      | "PlayerUnavailable",
  ): void {
    this.deliver({
      kind: "Rejected",
      requestId: command.requestId,
      protocolVersion: 1,
      code,
    });
  }

  emit(event: Record<string, unknown>): void {
    this.deliver({ ...event, protocolVersion: 1 });
  }

  private deliver(message: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

function present<T>(value: T) {
  return { kind: "Present" as const, value };
}

function absent() {
  return { kind: "Absent" as const };
}

function playerDescriptor(
  mediaId: MediaId,
  title: string,
  options: {
    pauseShorteningMode?: "Off" | "Natural";
    playbackRate?: number;
    podcastRate?: number;
    podcastId?: string;
  } = {},
): PlayerDescriptor {
  const playbackRate = options.playbackRate ?? 1.75;
  return {
    mediaId,
    title,
    subtitle: absent(),
    activation: {
      kind: "FooterAudio",
      streamUrl: `https://media.example/${mediaId}.mp3`,
      sourceUrl: `https://example.test/media/${mediaId}`,
      positionMs: 12_000,
      writeRevision: 7,
      resetEpoch: 2,
      playbackRate: {
        value: playbackRate,
        source: "Episode",
        podcastPreference: present({
          podcastId: options.podcastId ?? PODCAST_ID,
          value: present(options.podcastRate ?? 1.25),
        }),
      },
      pauseShorteningMode: present(
        options.pauseShorteningMode ?? "Natural",
      ),
      consumptionOverrideRevision: present(4),
      durationMs: present(120_000),
      artworkUrl: absent(),
      chapters: [],
    },
  };
}

function canonicalSnapshot(
  options: {
    sessionKey?: string;
    phase?: "Buffering" | "Playing" | "Paused" | "Ended";
    mediaId?: MediaId;
    itemId?: string;
    title?: string;
    effectiveMode?: "Off" | "Natural";
    sessionMode?: "Off" | "Natural" | null;
    podcastMode?: "Off" | "Natural" | null;
    podcastId?: string;
  } = {},
) {
  const mediaId = options.mediaId ?? MEDIA_A;
  const itemId = options.itemId ?? ITEM_A;
  const effectiveMode = options.effectiveMode ?? "Natural";
  const sessionMode =
    options.sessionMode === undefined ? "Natural" : options.sessionMode;
  const podcastMode =
    options.podcastMode === undefined ? "Natural" : options.podcastMode;
  const podcastId = options.podcastId ?? PODCAST_ID;
  return {
    kind: "Canonical",
    sessionKey: options.sessionKey ?? SESSION_A,
    phase: options.phase ?? "Paused",
    positionMs: 42_000,
    durationMs: 120_000,
    bufferedMs: 90_000,
    volume: 0.65,
    observedBaseRate: 1.75,
    rateState: {
      kind: "Canonical",
      episodeRate: present(1.75),
      podcastPreference: present({
        podcastId,
        value: present(1.25),
      }),
      preferred: 1.75,
      temporaryNormal: false,
      base: 1.75,
    },
    persistence: { kind: "Ready" },
    playbackFailure: absent(),
    pauseShortening: {
      deviceDefaultMode: "Off",
      podcastOverride:
        podcastMode === null ? absent() : present(podcastMode),
      sessionOverride:
        sessionMode === null ? absent() : present(sessionMode),
      effectiveMode,
      provenance:
        sessionMode !== null
          ? "Session"
          : podcastMode !== null
            ? "Podcast"
            : "Device",
      savedOnDeviceMs: 9_876,
    },
    session: {
      descriptor: playerDescriptor(
        mediaId,
        options.title ?? "First episode",
        { pauseShorteningMode: effectiveMode, podcastId },
      ),
      origin: { kind: "Lectern", itemId },
    },
  };
}

function pendingNaturalEnd(
  accountId = ACCOUNT_ID,
  sessionKey = SESSION_A,
) {
  return {
    accountId,
    sessionKey,
    mediaId: MEDIA_A,
    origin: { kind: "Lectern", itemId: ITEM_A },
    clientMutationId: MUTATION_A,
    terminalListening: {
      positionMs: 120_000,
      durationMs: present(120_000),
      episodePlaybackRate: present(1.75),
      expectedWriteRevision: 7,
      expectedResetEpoch: 2,
    },
    expectedConsumptionOverrideRevision: present(4),
  };
}

function lecternItem(itemId: string, mediaId: MediaId, title: string) {
  return {
    itemId,
    mediaId,
    kind: "podcast_episode",
    title,
    subtitle: absent(),
    href: `/media/${mediaId}`,
    consumption: {
      state: "Unread",
      progress: absent(),
      progressResettable: false,
    },
    activation: playerDescriptor(mediaId, title).activation,
  };
}

function consumptionResultWithSuccessor() {
  const next = lecternItem(ITEM_B, MEDIA_B, "Second episode");
  return {
    data: {
      outcome: { kind: "Completed" },
      lectern: { items: [next] },
      nextItem: present(next),
      progressState: absent(),
      completionHandle: absent(),
      libraryEntriesCollectionRevision: 2,
    },
  };
}

function subscriptionSettingsResponse(options: {
  pauseMode: "Off" | "Natural";
  defaultRate?: number;
}) {
  return {
    data: {
      user_id: ACCOUNT_ID,
      podcast_id: PODCAST_ID,
      default_playback_speed: present(options.defaultRate ?? 1.25),
      pause_shortening_mode: present(options.pauseMode),
      auto_queue: false,
      sync_status: "Complete",
      sync_error_code: null,
      sync_error_message: null,
      sync_attempts: 0,
      sync_started_at: null,
      sync_completed_at: null,
      last_checked_at: null,
      updated_at: "2026-07-30T12:00:00.000Z",
      backfill: {
        id: "77777777-7777-4777-8777-777777777777",
        state: "Complete",
        processedCount: 0,
        addedCount: 0,
      },
      collectionRevision: 3,
      libraryEntriesCollectionRevision: 5,
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type FetchHandlers = {
  initialItems?: Record<string, unknown>[];
  lectern?: () => Response | Promise<Response>;
  consumption?: (
    body: Record<string, unknown>,
  ) => Response | Promise<Response>;
  settings?: (
    body: Record<string, unknown>,
  ) => Response | Promise<Response>;
};

function installFetch(handlers: FetchHandlers = {}) {
  const consumptionBodies: Record<string, unknown>[] = [];
  const settingsBodies: Record<string, unknown>[] = [];
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const url = new URL(String(input), "http://localhost");
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.pathname === "/api/lectern" && method === "GET") {
        return (
          handlers.lectern?.() ??
          jsonResponse({
            data: { items: handlers.initialItems ?? [] },
          })
        );
      }
      if (
        url.pathname === "/api/consumption/commands" &&
        method === "POST"
      ) {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<
          string,
          unknown
        >;
        consumptionBodies.push(body);
        return (
          handlers.consumption?.(body) ??
          jsonResponse(consumptionResultWithSuccessor())
        );
      }
      if (
        url.pathname ===
          `/api/podcasts/subscriptions/${PODCAST_ID}/settings` &&
        method === "PATCH"
      ) {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<
          string,
          unknown
        >;
        settingsBodies.push(body);
        return (
          handlers.settings?.(body) ??
          jsonResponse(subscriptionSettingsResponse({ pauseMode: "Natural" }))
        );
      }
      throw new Error(`Unexpected fetch: ${method} ${url.pathname}`);
    });
  return { consumptionBodies, fetchMock, settingsBodies };
}

let currentLectern: LecternCapability | null = null;

function Probe() {
  const lectern = useLectern();
  const { state } = usePlayerSession();
  const settings = usePlayerSettings();
  const timeline = usePlayerTimeline();
  const commands = usePlayerCommands();

  useEffect(() => {
    currentLectern = lectern;
    return () => {
      if (currentLectern === lectern) currentLectern = null;
    };
  }, [lectern]);

  const title = "session" in state ? state.session.descriptor.title : "";
  const pause =
    settings.pauseShortening.kind === "Available"
      ? settings.pauseShortening
      : null;
  return (
    <>
      <span data-testid="lectern-status">{lectern.resource.status}</span>
      <span data-testid="player-state">{state.kind}</span>
      <span data-testid="player-title">{title}</span>
      <span data-testid="position">{timeline.positionMs}</span>
      <span data-testid="volume">{settings.volume}</span>
      <span data-testid="rate">{settings.playbackRate.preferred}</span>
      <span data-testid="pause-mode">{pause?.effectiveMode ?? "Unavailable"}</span>
      <span data-testid="pause-provenance">
        {pause?.provenance ?? "Unavailable"}
      </span>
      <span data-testid="saved-ms">
        {timeline.pauseShorteningSavedOnDeviceMs.kind === "Present"
          ? timeline.pauseShorteningSavedOnDeviceMs.value
          : "Absent"}
      </span>
      <span data-testid="lectern-items">
        {lectern.resource.status === "ready"
          ? lectern.resource.data.items.map((item) => item.title).join(",")
          : ""}
      </span>
      <button
        type="button"
        onClick={commands.rememberPlaybackRateForPodcast}
      >
        Remember rate
      </button>
      <button
        type="button"
        onClick={() =>
          commands.playAudio(
            playerDescriptor(MEDIA_B, "Podcast B episode", {
              podcastId: PODCAST_B_ID,
            }),
          )
        }
      >
        Play podcast B
      </button>
      <button
        type="button"
        onClick={() =>
          commands.playAudio(
            playerDescriptor(MEDIA_B, "New session", {
              podcastId: PODCAST_ID,
            }),
          )
        }
      >
        Play same podcast
      </button>
      <button
        type="button"
        onClick={commands.rememberPauseShorteningForPodcast}
      >
        Remember pause
      </button>
      <button type="button" onClick={commands.dismiss}>
        Dismiss player
      </button>
      <button
        type="button"
        onClick={() => {
          if (state.kind === "RuntimeFailed") state.retry();
        }}
      >
        Retry runtime
      </button>
      <button
        type="button"
        onClick={() => {
          if (
            pause?.mutation.kind === "Failed" &&
            pause.mutation.retryable
          ) {
            pause.mutation.retry();
          }
        }}
      >
        Retry pause
      </button>
      <span data-testid="pause-mutation">
        {pause?.mutation.kind ?? "Unavailable"}
      </span>
      <LecternMutationNotice />
    </>
  );
}

function App({
  accountId = ACCOUNT_ID,
  children,
}: {
  accountId?: string;
  children?: ReactNode;
}) {
  return (
    <RenderEnvironmentProvider value={ANDROID_ENVIRONMENT}>
      <LecternProvider>
        <GlobalPlayerProvider accountId={accountId}>
          <Probe />
          {children}
        </GlobalPlayerProvider>
      </LecternProvider>
    </RenderEnvironmentProvider>
  );
}

function installBridge(bridge: FakeNexusPlayerBridge): void {
  Object.defineProperty(window, "nexusPlayer", {
    configurable: true,
    writable: true,
    value: bridge,
  });
}

function commandsOf(
  bridge: FakeNexusPlayerBridge,
  kind: string,
): WireCommand[] {
  return bridge.commands.filter((command) => command.kind === kind);
}

async function drainFakeTimers(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
  });
}

beforeEach(() => {
  currentLectern = null;
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, "nexusPlayer");
  currentLectern = null;
});

describe("AndroidPlayerRuntimeProvider", () => {
  it("rehydrates exclusively from the native snapshot, renders no audio element, and ignores a stale session event", async () => {
    installFetch({
      initialItems: [lecternItem(ITEM_A, MEDIA_A, "First episode")],
    });
    const initial = canonicalSnapshot();
    const bridge = new FakeNexusPlayerBridge((command, owner) => {
      if (command.kind === "Connect") {
        owner.reply(command, {
          kind: "Connected",
          snapshot: initial,
          pendingNaturalEnd: absent(),
        });
        return;
      }
      owner.reply(command, { kind: "Accepted" });
    });
    installBridge(bridge);

    render(<App />);

    await screen.findByText("Active", {
      selector: '[data-testid="player-state"]',
    });
    expect(screen.queryByLabelText("Media player audio")).toBeNull();
    expect(screen.getByTestId("player-title")).toHaveTextContent(
      "First episode",
    );
    expect(screen.getByTestId("position")).toHaveTextContent("42000");
    expect(screen.getByTestId("volume")).toHaveTextContent("0.65");
    expect(screen.getByTestId("rate")).toHaveTextContent("1.75");
    expect(screen.getByTestId("pause-mode")).toHaveTextContent("Natural");
    expect(screen.getByTestId("pause-provenance")).toHaveTextContent(
      "Session",
    );
    expect(screen.getByTestId("saved-ms")).toHaveTextContent("9876");

    await act(async () => {
      bridge.emit({
        kind: "SnapshotChanged",
        snapshot: canonicalSnapshot({
          sessionKey: SESSION_STALE,
          title: "Stale episode",
        }),
      });
    });

    expect(screen.getByTestId("player-title")).toHaveTextContent(
      "First episode",
    );
    expect(screen.queryByText("Stale episode")).toBeNull();
  });

  it("removes the previous account session before the replacement account connects", async () => {
    installFetch({
      initialItems: [lecternItem(ITEM_A, MEDIA_A, "First episode")],
    });
    const bridge = new FakeNexusPlayerBridge((command, owner) => {
      if (
        command.kind === "Connect" &&
        command.accountId === ACCOUNT_ID
      ) {
        owner.reply(command, {
          kind: "Connected",
          snapshot: canonicalSnapshot({ title: "Account A episode" }),
          pendingNaturalEnd: absent(),
        });
      }
    });
    installBridge(bridge);
    const { rerender } = render(<App accountId={ACCOUNT_ID} />);

    await screen.findByText("Account A episode", {
      selector: '[data-testid="player-title"]',
    });

    rerender(<App accountId={OTHER_ACCOUNT_ID} />);

    expect(screen.getByTestId("player-state")).toHaveTextContent("Absent");
    expect(screen.getByTestId("player-title")).toBeEmptyDOMElement();
    expect(commandsOf(bridge, "Connect")).toEqual([
      expect.objectContaining({ accountId: ACCOUNT_ID }),
      expect.objectContaining({ accountId: OTHER_ACCOUNT_ID }),
    ]);
  });

  it("renders the Android playback policy accessibly without narrow-width overflow and freezes every pause action while pending", async () => {
    let resolveSettings: ((response: Response) => void) | undefined;
    installFetch({
      initialItems: [lecternItem(ITEM_A, MEDIA_A, "First episode")],
      settings: () =>
        new Promise<Response>((resolve) => {
          resolveSettings = resolve;
        }),
    });
    const initial = canonicalSnapshot({
      sessionMode: "Natural",
      podcastMode: "Off",
    });
    const bridge = new FakeNexusPlayerBridge((command, owner) => {
      if (command.kind === "Connect") {
        owner.reply(command, {
          kind: "Connected",
          snapshot: initial,
          pendingNaturalEnd: absent(),
        });
        return;
      }
      owner.reply(command, { kind: "Accepted" });
    });
    installBridge(bridge);
    document.documentElement.style.setProperty("--size-xl", "44px");

    try {
      render(
        <App>
          <div
            data-testid="narrow-playback-panel"
            style={{ width: 320, maxWidth: 320 }}
          >
            <PlayerPlaybackPanel podcastTitle="The Example Podcast" />
          </div>
          <PodcastSubscriptionSettingsModal
            podcastTitle="The Example Podcast"
            settingsModal={{
              podcastId: PODCAST_ID,
              defaultPlaybackSpeed: absent(),
              pauseShorteningMode: absent(),
              autoQueue: false,
              busy: false,
              error: null,
              setDefaultPlaybackSpeed: vi.fn(),
              setPauseShorteningMode: vi.fn(),
              setAutoQueue: vi.fn(),
              open: vi.fn(),
              close: vi.fn(),
              save: vi.fn(async () => {}),
            }}
          />
        </App>,
      );

      const pauseHeading = await screen.findByRole("heading", {
        name: "Shorten pauses",
      });
      const rateSlider = screen.getByRole("slider", {
        name: "Playback speed",
      });
      const outputHeading = screen.getByRole("heading", {
        name: "Output effects",
      });
      expect(
        rateSlider.compareDocumentPosition(pauseHeading) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(
        pauseHeading.compareDocumentPosition(outputHeading) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();

      const mode = screen.getByRole("combobox", { name: "Mode" });
      expect(mode).toHaveValue("Natural");
      expect(mode.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
      expect(screen.getByText("This session · Natural")).toBeVisible();
      expect(
        screen.getByRole("button", { name: "Use podcast setting" }),
      ).toBeEnabled();
      expect(
        screen.getByRole("button", { name: "Remember for this podcast" }),
      ).toBeEnabled();
      expect(
        screen.getByRole("button", {
          name: "Make default on this device",
        }),
      ).toBeEnabled();
      expect(screen.getByText("Saved on this device · 00:09")).toBeVisible();
      expect(
        screen.getByText("Output effects unavailable for this source."),
      ).toBeVisible();
      expect(
        screen.getByRole("option", {
          name: "Use device default (currently Off)",
        }),
      ).toBeVisible();

      const host = screen.getByTestId("narrow-playback-panel");
      expect(host.scrollWidth).toBeLessThanOrEqual(host.clientWidth);

      fireEvent.click(
        screen.getByRole("button", { name: "Remember for this podcast" }),
      );
      expect(
        await screen.findByRole("button", {
          name: "Remembering for this podcast…",
        }),
      ).toBeDisabled();
      expect(mode).toBeDisabled();
      expect(
        screen.getByRole("button", { name: "Use podcast setting" }),
      ).toBeDisabled();
      expect(
        screen.getByRole("button", {
          name: "Make default on this device",
        }),
      ).toBeDisabled();
    } finally {
      resolveSettings?.(
        jsonResponse(
          subscriptionSettingsResponse({ pauseMode: "Natural" }),
        ),
      );
      document.documentElement.style.removeProperty("--size-xl");
    }
  });

  it("settles a restored Connected receipt headlessly, ACKs only after canonical install, and does not auto-start its successor", async () => {
    const next = lecternItem(ITEM_B, MEDIA_B, "Second episode");
    const { consumptionBodies } = installFetch({
      initialItems: [
        lecternItem(ITEM_A, MEDIA_A, "First episode"),
        next,
      ],
      consumption: () =>
        jsonResponse({
          data: {
            ...consumptionResultWithSuccessor().data,
            lectern: { items: [next] },
            nextItem: present(next),
          },
        }),
    });
    let canonicalInstalledAtAck = false;
    const bridge = new FakeNexusPlayerBridge((command, owner) => {
      if (command.kind === "Connect") {
        owner.reply(command, {
          kind: "Connected",
          snapshot: canonicalSnapshot({ phase: "Ended" }),
          pendingNaturalEnd: present(pendingNaturalEnd()),
        });
        return;
      }
      if (command.kind === "AcknowledgeNaturalEnd") {
        canonicalInstalledAtAck =
          currentLectern?.getCanonicalSnapshot()?.items[0]?.mediaId ===
          MEDIA_B;
      }
      owner.reply(command, { kind: "Accepted" });
    });
    installBridge(bridge);

    render(<App />);

    await waitFor(() => {
      expect(consumptionBodies).toHaveLength(1);
      expect(commandsOf(bridge, "AcknowledgeNaturalEnd")).toHaveLength(1);
    });
    expect(consumptionBodies[0]).toEqual({
      kind: "SettleNaturalEnd",
      clientMutationId: MUTATION_A,
      mediaId: MEDIA_A,
      origin: { kind: "Lectern", itemId: ITEM_A },
      terminalListening: {
        positionMs: 120_000,
        durationMs: present(120_000),
        episodePlaybackRate: present(1.75),
        expectedWriteRevision: 7,
        expectedResetEpoch: 2,
      },
      expectedConsumptionOverrideRevision: present(4),
      nextCapability: "FooterAudio",
    });
    expect(consumptionBodies[0]).not.toHaveProperty("accountId");
    expect(consumptionBodies[0]).not.toHaveProperty("sessionKey");
    expect(canonicalInstalledAtAck).toBe(true);
    expect(commandsOf(bridge, "LoadCanonical")).toHaveLength(0);
  });

  it("settles and installs a restored receipt even when the initial Lectern GET failed", async () => {
    const next = lecternItem(ITEM_B, MEDIA_B, "Second episode");
    const { consumptionBodies } = installFetch({
      lectern: () =>
        jsonResponse(
          {
            error: {
              code: "E_NETWORK",
              message: "Lectern is temporarily unavailable.",
            },
          },
          503,
        ),
      consumption: () =>
        jsonResponse({
          data: {
            ...consumptionResultWithSuccessor().data,
            lectern: { items: [next] },
            nextItem: present(next),
          },
        }),
    });
    let canonicalInstalledAtAck = false;
    const bridge = new FakeNexusPlayerBridge((command, owner) => {
      if (command.kind === "Connect") {
        owner.reply(command, {
          kind: "Connected",
          snapshot: canonicalSnapshot({ phase: "Ended" }),
          pendingNaturalEnd: present(pendingNaturalEnd()),
        });
        return;
      }
      if (command.kind === "AcknowledgeNaturalEnd") {
        canonicalInstalledAtAck =
          currentLectern?.getCanonicalSnapshot()?.items[0]?.mediaId ===
          MEDIA_B;
      }
      owner.reply(command, { kind: "Accepted" });
    });
    installBridge(bridge);

    render(<App />);

    await waitFor(() => {
      expect(consumptionBodies).toHaveLength(1);
      expect(commandsOf(bridge, "AcknowledgeNaturalEnd")).toHaveLength(1);
    });
    expect(canonicalInstalledAtAck).toBe(true);
    expect(commandsOf(bridge, "LoadCanonical")).toHaveLength(0);
  });

  it("allows only a live matching Ended event to ACK and then load the returned successor", async () => {
    const next = lecternItem(ITEM_B, MEDIA_B, "Second episode");
    installFetch({
      initialItems: [
        lecternItem(ITEM_A, MEDIA_A, "First episode"),
        next,
      ],
      consumption: () => jsonResponse(consumptionResultWithSuccessor()),
    });
    const bridge = new FakeNexusPlayerBridge((command, owner) => {
      if (command.kind === "Connect") {
        owner.reply(command, {
          kind: "Connected",
          snapshot: canonicalSnapshot({ phase: "Ended" }),
          pendingNaturalEnd: absent(),
        });
        return;
      }
      owner.reply(command, { kind: "Accepted" });
    });
    installBridge(bridge);

    render(<App />);
    await screen.findByText("ready", {
      selector: '[data-testid="lectern-status"]',
    });

    await act(async () => {
      bridge.emit({
        kind: "NaturalEndPending",
        receipt: pendingNaturalEnd(),
      });
    });

    await waitFor(() =>
      expect(commandsOf(bridge, "LoadCanonical")).toHaveLength(1),
    );
    const ackIndex = bridge.commands.findIndex(
      (command) => command.kind === "AcknowledgeNaturalEnd",
    );
    const loadIndex = bridge.commands.findIndex(
      (command) => command.kind === "LoadCanonical",
    );
    expect(ackIndex).toBeGreaterThan(-1);
    expect(loadIndex).toBeGreaterThan(ackIndex);
    expect(bridge.commands[loadIndex]).toMatchObject({
      kind: "LoadCanonical",
      session: {
        descriptor: {
          mediaId: MEDIA_B,
          title: "Second episode",
        },
        origin: { kind: "Lectern", itemId: ITEM_B },
      },
    });
  });

  it("settles and ACKs but does not advance after Dismiss replaces the matching Ended session", async () => {
    const next = lecternItem(ITEM_B, MEDIA_B, "Second episode");
    let resolveSettlement: ((response: Response) => void) | undefined;
    installFetch({
      initialItems: [
        lecternItem(ITEM_A, MEDIA_A, "First episode"),
        next,
      ],
      consumption: () =>
        new Promise<Response>((resolve) => {
          resolveSettlement = resolve;
        }),
    });
    const bridge = new FakeNexusPlayerBridge((command, owner) => {
      if (command.kind === "Connect") {
        owner.reply(command, {
          kind: "Connected",
          snapshot: canonicalSnapshot({ phase: "Ended" }),
          pendingNaturalEnd: absent(),
        });
        return;
      }
      if (command.kind === "Dismiss") {
        owner.emit({
          kind: "SnapshotChanged",
          snapshot: {
            kind: "Absent",
            deviceDefaultPauseShorteningMode: "Off",
            pauseShorteningSavedOnDeviceMs: 0,
          },
        });
      }
      owner.reply(command, { kind: "Accepted" });
    });
    installBridge(bridge);

    render(<App />);
    await screen.findByText("ready", {
      selector: '[data-testid="lectern-status"]',
    });
    await act(async () => {
      bridge.emit({
        kind: "NaturalEndPending",
        receipt: pendingNaturalEnd(),
      });
    });
    await waitFor(() => expect(resolveSettlement).toBeTypeOf("function"));

    fireEvent.click(
      screen.getByRole("button", { name: "Dismiss player" }),
    );
    await screen.findByText("Absent", {
      selector: '[data-testid="player-state"]',
    });

    await act(async () => {
      resolveSettlement?.(jsonResponse(consumptionResultWithSuccessor()));
    });
    await waitFor(() =>
      expect(commandsOf(bridge, "AcknowledgeNaturalEnd")).toHaveLength(1),
    );
    expect(commandsOf(bridge, "LoadCanonical")).toHaveLength(0);
  });

  it("does not settle or ACK a receipt owned by another account", async () => {
    const { consumptionBodies } = installFetch({
      initialItems: [lecternItem(ITEM_A, MEDIA_A, "First episode")],
    });
    const bridge = new FakeNexusPlayerBridge((command, owner) => {
      if (command.kind === "Connect") {
        owner.reply(command, {
          kind: "Connected",
          snapshot: canonicalSnapshot({ phase: "Ended" }),
          pendingNaturalEnd: present(
            pendingNaturalEnd(OTHER_ACCOUNT_ID),
          ),
        });
        return;
      }
      owner.reply(command, { kind: "Accepted" });
    });
    installBridge(bridge);

    render(<App />);

    await screen.findByText("RuntimeFailed", {
      selector: '[data-testid="player-state"]',
    });
    expect(consumptionBodies).toHaveLength(0);
    expect(commandsOf(bridge, "AcknowledgeNaturalEnd")).toHaveLength(0);
  });

  it("retains an ambiguous receipt and never advances when ACK times out and GetSnapshot still reports it", async () => {
    vi.useFakeTimers();
    installFetch({
      initialItems: [
        lecternItem(ITEM_A, MEDIA_A, "First episode"),
        lecternItem(ITEM_B, MEDIA_B, "Second episode"),
      ],
      consumption: () => jsonResponse(consumptionResultWithSuccessor()),
    });
    const ended = canonicalSnapshot({ phase: "Ended" });
    const receipt = pendingNaturalEnd();
    const bridge = new FakeNexusPlayerBridge((command, owner) => {
      if (command.kind === "Connect") {
        owner.reply(command, {
          kind: "Connected",
          snapshot: ended,
          pendingNaturalEnd: present(receipt),
        });
        return;
      }
      if (command.kind === "AcknowledgeNaturalEnd") {
        return;
      }
      if (command.kind === "GetSnapshot") {
        owner.reply(command, {
          kind: "Snapshot",
          snapshot: ended,
          pendingNaturalEnd: present(receipt),
        });
        return;
      }
      owner.reply(command, { kind: "Accepted" });
    });
    installBridge(bridge);

    render(<App />);
    await drainFakeTimers();
    await drainFakeTimers();
    expect(commandsOf(bridge, "AcknowledgeNaturalEnd")).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        NATIVE_PLAYER_COMMAND_DEADLINE_MS,
      );
    });
    await drainFakeTimers();

    expect(commandsOf(bridge, "GetSnapshot")).toHaveLength(1);
    expect(commandsOf(bridge, "LoadCanonical")).toHaveLength(0);
    expect(commandsOf(bridge, "AcknowledgeNaturalEnd")).toHaveLength(1);
  });

  it("keeps Android completion state while the Lectern owner visibly offers retry after settlement failure", async () => {
    installFetch({
      initialItems: [lecternItem(ITEM_A, MEDIA_A, "First episode")],
      consumption: () =>
        jsonResponse(
          {
            error: {
              code: "E_NETWORK",
              message: "Settlement is temporarily unavailable.",
            },
          },
          503,
        ),
    });
    const bridge = new FakeNexusPlayerBridge((command, owner) => {
      if (command.kind === "Connect") {
        owner.reply(command, {
          kind: "Connected",
          snapshot: canonicalSnapshot({ phase: "Ended" }),
          pendingNaturalEnd: present(pendingNaturalEnd()),
        });
        return;
      }
      owner.reply(command, { kind: "Accepted" });
    });
    installBridge(bridge);

    render(<App />);

    await screen.findByText("Completing", {
      selector: '[data-testid="player-state"]',
    });
    const notice = await screen.findByRole("alert");
    expect(notice).toHaveTextContent("Couldn't update the Lectern.");
    expect(
      screen.getByRole("button", { name: "Retry" }),
    ).toBeVisible();
    expect(commandsOf(bridge, "AcknowledgeNaturalEnd")).toHaveLength(0);
  });

  it("keeps a committed Reset successful and surfaces a failed native listening-state adopt", async () => {
    vi.useFakeTimers();
    const item = lecternItem(ITEM_A, MEDIA_A, "First episode");
    const { consumptionBodies } = installFetch({
      initialItems: [item],
      consumption: () =>
        jsonResponse({
          data: {
            outcome: { kind: "StateOnly" },
            lectern: { items: [item] },
            nextItem: absent(),
            progressState: present({
              mediaId: MEDIA_A,
              readerCursor: { state: "Empty", revision: 8 },
              listeningState: present({
                positionMs: 0,
                durationMs: present(120_000),
                episodePlaybackRate: absent(),
                writeRevision: 9,
                resetEpoch: 3,
              }),
            }),
            completionHandle: absent(),
            libraryEntriesCollectionRevision: 6,
          },
        }),
    });
    const oldSnapshot = canonicalSnapshot();
    const adoptedBase = canonicalSnapshot();
    const adoptedSnapshot = {
      ...adoptedBase,
      positionMs: 0,
      observedBaseRate: 1.25,
      rateState: {
        kind: "Canonical",
        episodeRate: absent(),
        podcastPreference: present({
          podcastId: PODCAST_ID,
          value: present(1.25),
        }),
        preferred: 1.25,
        temporaryNormal: false,
        base: 1.25,
      },
      session: {
        ...adoptedBase.session,
        descriptor: {
          ...adoptedBase.session.descriptor,
          activation: {
            ...adoptedBase.session.descriptor.activation,
            positionMs: 0,
            writeRevision: 9,
            resetEpoch: 3,
            durationMs: present(120_000),
            playbackRate: {
              value: 1.25,
              source: "Podcast",
              podcastPreference: present({
                podcastId: PODCAST_ID,
                value: present(1.25),
              }),
            },
          },
        },
      },
    };
    let adoptCount = 0;
    const bridge = new FakeNexusPlayerBridge((command, owner) => {
      if (command.kind === "Connect") {
        owner.reply(command, {
          kind: "Connected",
          snapshot: oldSnapshot,
          pendingNaturalEnd: absent(),
        });
        return;
      }
      if (command.kind === "AdoptListeningState") {
        adoptCount += 1;
        if (adoptCount === 1) return;
        owner.emit({
          kind: "SnapshotChanged",
          snapshot: adoptedSnapshot,
        });
        owner.reply(command, { kind: "Accepted" });
        return;
      }
      if (command.kind === "GetSnapshot") {
        owner.reply(command, {
          kind: "Snapshot",
          snapshot: oldSnapshot,
          pendingNaturalEnd: absent(),
        });
        return;
      }
      owner.reply(command, { kind: "Accepted" });
    });
    installBridge(bridge);

    render(<App />);
    await drainFakeTimers();
    expect(screen.getByTestId("lectern-status")).toHaveTextContent("ready");

    const lectern = currentLectern;
    if (lectern === null) throw new Error("Expected the Lectern capability.");
    await act(async () => {
      await expect(
        lectern.resetProgress(MEDIA_A),
      ).resolves.toMatchObject({
        outcome: { kind: "StateOnly" },
      });
    });

    expect(consumptionBodies).toHaveLength(1);
    expect(commandsOf(bridge, "Drain")).toHaveLength(1);
    expect(commandsOf(bridge, "AdoptListeningState")).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        NATIVE_PLAYER_COMMAND_DEADLINE_MS,
      );
    });
    await drainFakeTimers();
    expect(screen.getByTestId("player-state")).toHaveTextContent(
      "RuntimeFailed",
    );

    await act(async () => {
      bridge.emit({
        kind: "SnapshotChanged",
        snapshot: oldSnapshot,
      });
    });
    expect(screen.getByTestId("player-state")).toHaveTextContent(
      "RuntimeFailed",
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Retry runtime" }),
    );
    await drainFakeTimers();
    expect(commandsOf(bridge, "AdoptListeningState")).toHaveLength(2);
    expect(commandsOf(bridge, "AdoptListeningState")[1]).toMatchObject({
      sessionKey: SESSION_A,
      listeningState:
        commandsOf(bridge, "AdoptListeningState")[0]?.listeningState,
    });
    expect(screen.getByTestId("player-state")).toHaveTextContent("Active");
    expect(screen.getByTestId("position")).toHaveTextContent("0");
  });

  it("rejects an ambiguous canonical Load when timeout reconciliation returns the old session", async () => {
    vi.useFakeTimers();
    installFetch({
      initialItems: [
        lecternItem(ITEM_A, MEDIA_A, "First episode"),
        lecternItem(ITEM_B, MEDIA_B, "Podcast B episode"),
      ],
    });
    const oldSnapshot = canonicalSnapshot();
    let loadCount = 0;
    const bridge = new FakeNexusPlayerBridge((command, owner) => {
      if (command.kind === "Connect") {
        owner.reply(command, {
          kind: "Connected",
          snapshot: oldSnapshot,
          pendingNaturalEnd: absent(),
        });
        return;
      }
      if (command.kind === "LoadCanonical") {
        loadCount += 1;
        if (loadCount === 1) return;
        owner.emit({
          kind: "SnapshotChanged",
          snapshot: canonicalSnapshot({
            sessionKey: String(command.sessionKey),
            mediaId: MEDIA_B,
            itemId: ITEM_B,
            title: "Podcast B episode",
            podcastId: PODCAST_B_ID,
          }),
        });
        owner.reply(command, { kind: "Accepted" });
        return;
      }
      if (command.kind === "GetSnapshot") {
        owner.reply(command, {
          kind: "Snapshot",
          snapshot: oldSnapshot,
          pendingNaturalEnd: absent(),
        });
        return;
      }
      owner.reply(command, { kind: "Accepted" });
    });
    installBridge(bridge);

    render(<App />);
    await drainFakeTimers();
    expect(screen.getByTestId("player-state")).toHaveTextContent("Active");

    fireEvent.click(
      screen.getByRole("button", { name: "Play podcast B" }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        NATIVE_PLAYER_COMMAND_DEADLINE_MS,
      );
    });
    await drainFakeTimers();

    expect(commandsOf(bridge, "GetSnapshot")).toHaveLength(1);
    expect(screen.getByTestId("player-state")).toHaveTextContent(
      "RuntimeFailed",
    );
    expect(screen.getByTestId("player-title")).not.toHaveTextContent(
      "Podcast B episode",
    );

    await act(async () => {
      bridge.emit({
        kind: "SnapshotChanged",
        snapshot: oldSnapshot,
      });
    });
    expect(screen.getByTestId("player-state")).toHaveTextContent(
      "RuntimeFailed",
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Retry runtime" }),
    );
    await drainFakeTimers();
    expect(commandsOf(bridge, "LoadCanonical")).toHaveLength(2);
    expect(commandsOf(bridge, "LoadCanonical")[1]?.sessionKey).toBe(
      commandsOf(bridge, "LoadCanonical")[0]?.sessionKey,
    );
    expect(screen.getByTestId("player-state")).toHaveTextContent("Active");
    expect(screen.getByTestId("player-title")).toHaveTextContent(
      "Podcast B episode",
    );
  });

  it("does not replay a failed Load after a newer explicit Load supersedes its frozen session key", async () => {
    vi.useFakeTimers();
    installFetch({
      initialItems: [
        lecternItem(ITEM_A, MEDIA_A, "First episode"),
        lecternItem(ITEM_B, MEDIA_B, "New session"),
      ],
    });
    const oldSnapshot = canonicalSnapshot();
    let loadCount = 0;
    const bridge = new FakeNexusPlayerBridge((command, owner) => {
      if (command.kind === "Connect") {
        owner.reply(command, {
          kind: "Connected",
          snapshot: oldSnapshot,
          pendingNaturalEnd: absent(),
        });
        return;
      }
      if (command.kind === "LoadCanonical") {
        loadCount += 1;
        if (loadCount === 1) return;
        owner.emit({
          kind: "SnapshotChanged",
          snapshot: canonicalSnapshot({
            sessionKey: String(command.sessionKey),
            mediaId: MEDIA_B,
            itemId: ITEM_B,
            title: "New session",
            sessionMode: null,
          }),
        });
        owner.reply(command, { kind: "Accepted" });
        return;
      }
      if (command.kind === "GetSnapshot") {
        owner.reply(command, {
          kind: "Snapshot",
          snapshot: oldSnapshot,
          pendingNaturalEnd: absent(),
        });
        return;
      }
      owner.reply(command, { kind: "Accepted" });
    });
    installBridge(bridge);

    render(<App />);
    await drainFakeTimers();

    fireEvent.click(
      screen.getByRole("button", { name: "Play podcast B" }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        NATIVE_PLAYER_COMMAND_DEADLINE_MS,
      );
    });
    await drainFakeTimers();
    expect(screen.getByTestId("player-state")).toHaveTextContent(
      "RuntimeFailed",
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Play same podcast" }),
    );
    await drainFakeTimers();
    expect(commandsOf(bridge, "LoadCanonical")).toHaveLength(2);
    expect(screen.getByTestId("player-state")).toHaveTextContent(
      "RuntimeFailed",
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Retry runtime" }),
    );
    await drainFakeTimers();
    expect(commandsOf(bridge, "LoadCanonical")).toHaveLength(2);
    expect(screen.getByTestId("player-state")).toHaveTextContent("Active");
    expect(screen.getByTestId("player-title")).toHaveTextContent(
      "New session",
    );
  });

  it("installs a controller-reconnection snapshot authoritatively, clears frozen retries, and settles its receipt headlessly", async () => {
    const { consumptionBodies } = installFetch({
      initialItems: [
        lecternItem(ITEM_A, MEDIA_A, "First episode"),
        lecternItem(ITEM_B, MEDIA_B, "Reconnected episode"),
      ],
      consumption: () => jsonResponse(consumptionResultWithSuccessor()),
    });
    const initial = canonicalSnapshot();
    const reconnected = canonicalSnapshot({
      sessionKey: SESSION_STALE,
      mediaId: MEDIA_B,
      itemId: ITEM_B,
      title: "Reconnected episode",
      sessionMode: null,
    });
    const bridge = new FakeNexusPlayerBridge((command, owner) => {
      if (command.kind === "Connect") {
        owner.reply(command, {
          kind: "Connected",
          snapshot: initial,
          pendingNaturalEnd: absent(),
        });
        return;
      }
      if (command.kind === "LoadCanonical") {
        owner.reject(command, "PlayerUnavailable");
        return;
      }
      owner.reply(command, { kind: "Accepted" });
    });
    installBridge(bridge);

    render(<App />);
    await screen.findByText("Active", {
      selector: '[data-testid="player-state"]',
    });
    await screen.findByText("ready", {
      selector: '[data-testid="lectern-status"]',
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Play podcast B" }),
    );
    await screen.findByText("RuntimeFailed", {
      selector: '[data-testid="player-state"]',
    });

    await act(async () => {
      bridge.emit({
        kind: "ControllerReconnected",
        snapshot: reconnected,
        pendingNaturalEnd: present(pendingNaturalEnd()),
      });
    });

    await waitFor(() => {
      expect(consumptionBodies).toHaveLength(1);
      expect(
        commandsOf(bridge, "AcknowledgeNaturalEnd"),
      ).toHaveLength(1);
    });
    expect(screen.getByTestId("player-state")).toHaveTextContent("Active");
    expect(screen.getByTestId("player-title")).toHaveTextContent(
      "Reconnected episode",
    );
    expect(commandsOf(bridge, "LoadCanonical")).toHaveLength(1);

    await act(async () => {
      bridge.emit({
        kind: "SnapshotChanged",
        snapshot: initial,
      });
    });
    expect(screen.getByTestId("player-title")).toHaveTextContent(
      "Reconnected episode",
    );

    await act(async () => {
      bridge.emit({
        kind: "ControllerReconnected",
        snapshot: reconnected,
        pendingNaturalEnd: absent(),
      });
    });
    expect(consumptionBodies).toHaveLength(1);
  });

  it("treats a stale settings-install reconciliation as a harmless no-op after switching to another podcast", async () => {
    installFetch({
      initialItems: [
        lecternItem(ITEM_A, MEDIA_A, "Podcast A episode"),
        lecternItem(ITEM_B, MEDIA_B, "Podcast B episode"),
      ],
      settings: () =>
        jsonResponse(
          subscriptionSettingsResponse({
            defaultRate: 1.25,
            pauseMode: "Off",
          }),
        ),
    });
    let podcastB: ReturnType<typeof canonicalSnapshot> | null = null;
    let staleInstall: WireCommand | null = null;
    const bridge = new FakeNexusPlayerBridge((command, owner) => {
      if (command.kind === "Connect") {
        owner.reply(command, {
          kind: "Connected",
          snapshot: canonicalSnapshot({
            title: "Podcast A episode",
            sessionMode: null,
          }),
          pendingNaturalEnd: absent(),
        });
        return;
      }
      if (command.kind === "InstallPodcastPlaybackSettings") {
        staleInstall = command;
        return;
      }
      if (command.kind === "LoadCanonical") {
        podcastB = canonicalSnapshot({
          sessionKey: String(command.sessionKey),
          mediaId: MEDIA_B,
          itemId: ITEM_B,
          title: "Podcast B episode",
          effectiveMode: "Natural",
          sessionMode: null,
          podcastId: PODCAST_B_ID,
        });
        owner.emit({
          kind: "SnapshotChanged",
          snapshot: podcastB,
        });
        owner.reply(command, { kind: "Accepted" });
        return;
      }
      if (command.kind === "GetSnapshot") {
        if (podcastB === null) {
          throw new Error("Expected the podcast B session.");
        }
        owner.reply(command, {
          kind: "Snapshot",
          snapshot: podcastB,
          pendingNaturalEnd: absent(),
        });
        return;
      }
      owner.reply(command, { kind: "Accepted" });
    });
    installBridge(bridge);

    render(<App />);
    await screen.findByText("Podcast A episode", {
      selector: '[data-testid="player-title"]',
    });

    const settingsSave = savePodcastSubscriptionSettings(PODCAST_ID, {
      pauseShorteningMode: present("Off"),
    });
    await waitFor(() =>
      expect(
        commandsOf(bridge, "InstallPodcastPlaybackSettings"),
      ).toHaveLength(1),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Play podcast B" }),
    );
    await screen.findByText(
      "Podcast B episode",
      { selector: '[data-testid="player-title"]' },
    );

    await act(async () => {
      if (staleInstall === null) {
        throw new Error("Expected the stale native settings install.");
      }
      bridge.reject(staleInstall, "StaleSession");
      await settingsSave;
    });

    expect(commandsOf(bridge, "GetSnapshot")).toHaveLength(1);
    expect(screen.getByTestId("player-state")).toHaveTextContent("Active");
    expect(screen.getByTestId("player-title")).toHaveTextContent(
      "Podcast B episode",
    );

    await act(async () => {
      bridge.emit({
        kind: "SnapshotChanged",
        snapshot: canonicalSnapshot({
          title: "Late podcast A episode",
          sessionMode: null,
        }),
      });
    });
    expect(screen.getByTestId("player-title")).toHaveTextContent(
      "Podcast B episode",
    );
  });

  it("retargets a stale settings install once when a new session belongs to the same podcast", async () => {
    installFetch({
      initialItems: [
        lecternItem(ITEM_A, MEDIA_A, "Old session"),
        lecternItem(ITEM_B, MEDIA_B, "New session"),
      ],
      settings: () =>
        jsonResponse(
          subscriptionSettingsResponse({
            defaultRate: 1.25,
            pauseMode: "Off",
          }),
        ),
    });
    let newSessionBeforeInstall:
      | ReturnType<typeof canonicalSnapshot>
      | null = null;
    let newSessionAfterInstall:
      | ReturnType<typeof canonicalSnapshot>
      | null = null;
    let newSessionKey: string | null = null;
    let firstInstall: WireCommand | null = null;
    let installCount = 0;
    const bridge = new FakeNexusPlayerBridge((command, owner) => {
      if (command.kind === "Connect") {
        owner.reply(command, {
          kind: "Connected",
          snapshot: canonicalSnapshot({
            title: "Old session",
            sessionMode: null,
          }),
          pendingNaturalEnd: absent(),
        });
        return;
      }
      if (command.kind === "InstallPodcastPlaybackSettings") {
        installCount += 1;
        if (installCount === 1) {
          firstInstall = command;
          return;
        }
        if (newSessionAfterInstall === null) {
          throw new Error("Expected the retargeted session.");
        }
        owner.emit({
          kind: "SnapshotChanged",
          snapshot: newSessionAfterInstall,
        });
        owner.reply(command, { kind: "Accepted" });
        return;
      }
      if (command.kind === "LoadCanonical") {
        newSessionKey = String(command.sessionKey);
        newSessionBeforeInstall = canonicalSnapshot({
          sessionKey: newSessionKey,
          mediaId: MEDIA_B,
          itemId: ITEM_B,
          title: "New session",
          effectiveMode: "Natural",
          sessionMode: null,
          podcastMode: "Natural",
        });
        newSessionAfterInstall = canonicalSnapshot({
          sessionKey: newSessionKey,
          mediaId: MEDIA_B,
          itemId: ITEM_B,
          title: "New session",
          effectiveMode: "Off",
          sessionMode: null,
          podcastMode: "Off",
        });
        owner.emit({
          kind: "SnapshotChanged",
          snapshot: newSessionBeforeInstall,
        });
        owner.reply(command, { kind: "Accepted" });
        return;
      }
      if (command.kind === "GetSnapshot") {
        if (newSessionBeforeInstall === null) {
          throw new Error("Expected the new same-podcast session.");
        }
        owner.reply(command, {
          kind: "Snapshot",
          snapshot: newSessionBeforeInstall,
          pendingNaturalEnd: absent(),
        });
        return;
      }
      owner.reply(command, { kind: "Accepted" });
    });
    installBridge(bridge);

    render(<App />);
    await screen.findByText("Old session", {
      selector: '[data-testid="player-title"]',
    });

    const settingsSave = savePodcastSubscriptionSettings(PODCAST_ID, {
      pauseShorteningMode: present("Off"),
    });
    await waitFor(() => expect(installCount).toBe(1));

    fireEvent.click(
      screen.getByRole("button", { name: "Play same podcast" }),
    );
    await screen.findByText("New session", {
      selector: '[data-testid="player-title"]',
    });

    await act(async () => {
      if (firstInstall === null) {
        throw new Error("Expected the first native settings install.");
      }
      bridge.reject(firstInstall, "StaleSession");
      await settingsSave;
    });

    expect(commandsOf(bridge, "GetSnapshot")).toHaveLength(1);
    expect(
      commandsOf(bridge, "InstallPodcastPlaybackSettings"),
    ).toHaveLength(2);
    expect(
      commandsOf(bridge, "InstallPodcastPlaybackSettings")[1],
    ).toMatchObject({
      kind: "InstallPodcastPlaybackSettings",
      sessionKey: newSessionKey,
      podcastId: PODCAST_ID,
      subscription: present({
        defaultPlaybackSpeed: present(1.25),
        pauseShorteningMode: present("Off"),
      }),
    });
    expect(screen.getByTestId("player-state")).toHaveTextContent("Active");
    expect(screen.getByTestId("player-title")).toHaveTextContent(
      "New session",
    );
    expect(screen.getByTestId("pause-mode")).toHaveTextContent("Off");

    await act(async () => {
      bridge.emit({
        kind: "SnapshotChanged",
        snapshot: canonicalSnapshot({
          title: "Late old session",
          sessionMode: null,
        }),
      });
    });
    expect(screen.getByTestId("player-title")).toHaveTextContent(
      "New session",
    );
    expect(
      commandsOf(bridge, "InstallPodcastPlaybackSettings"),
    ).toHaveLength(2);
  });

  it("abandons player-owned Remember UI work after a source switch while preserving the shared guard and live install", async () => {
    let resolveSettings!: (response: Response) => void;
    const settingsGate = new Promise<Response>((resolve) => {
      resolveSettings = resolve;
    });
    const { settingsBodies } = installFetch({
      initialItems: [
        lecternItem(ITEM_A, MEDIA_A, "Old session"),
        lecternItem(ITEM_B, MEDIA_B, "New session"),
      ],
      settings: () => settingsGate,
    });
    let newSessionKey: string | null = null;
    const bridge = new FakeNexusPlayerBridge((command, owner) => {
      if (command.kind === "Connect") {
        owner.reply(command, {
          kind: "Connected",
          snapshot: canonicalSnapshot({
            title: "Old session",
            sessionMode: "Natural",
          }),
          pendingNaturalEnd: absent(),
        });
        return;
      }
      if (command.kind === "LoadCanonical") {
        newSessionKey = String(command.sessionKey);
        owner.emit({
          kind: "SnapshotChanged",
          snapshot: canonicalSnapshot({
            sessionKey: newSessionKey,
            mediaId: MEDIA_B,
            itemId: ITEM_B,
            title: "New session",
            sessionMode: null,
          }),
        });
        owner.reply(command, { kind: "Accepted" });
        return;
      }
      owner.reply(command, { kind: "Accepted" });
    });
    installBridge(bridge);

    render(<App />);
    await screen.findByText("Old session", {
      selector: '[data-testid="player-title"]',
    });

    fireEvent.click(screen.getByRole("button", { name: "Remember pause" }));
    await waitFor(() => expect(settingsBodies).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Remember rate" }));
    expect(settingsBodies).toHaveLength(1);

    fireEvent.click(
      screen.getByRole("button", { name: "Play same podcast" }),
    );
    await screen.findByText("New session", {
      selector: '[data-testid="player-title"]',
    });

    await act(async () => {
      resolveSettings(
        jsonResponse(
          subscriptionSettingsResponse({
            defaultRate: 1.25,
            pauseMode: "Natural",
          }),
        ),
      );
      await settingsGate;
    });
    await waitFor(() =>
      expect(
        commandsOf(bridge, "InstallPodcastPlaybackSettings"),
      ).toHaveLength(1),
    );

    expect(
      commandsOf(bridge, "InstallPodcastPlaybackSettings")[0],
    ).toMatchObject({
      sessionKey: newSessionKey,
      podcastId: PODCAST_ID,
      subscription: present({
        defaultPlaybackSpeed: present(1.25),
        pauseShorteningMode: present("Natural"),
      }),
    });
    expect(
      commandsOf(bridge, "ClearSessionPauseShorteningMode"),
    ).toHaveLength(0);
    expect(screen.getByTestId("player-state")).toHaveTextContent("Active");
    expect(screen.getByTestId("pause-mutation")).toHaveTextContent("Idle");
  });

  it("keeps committed modal and unsubscribe settings successful when their native install fails", async () => {
    installFetch({
      initialItems: [lecternItem(ITEM_A, MEDIA_A, "First episode")],
      settings: () =>
        jsonResponse(
          subscriptionSettingsResponse({
            defaultRate: 1.25,
            pauseMode: "Off",
          }),
        ),
    });
    let installCount = 0;
    const bridge = new FakeNexusPlayerBridge((command, owner) => {
      if (command.kind === "Connect") {
        owner.reply(command, {
          kind: "Connected",
          snapshot: canonicalSnapshot({
            effectiveMode: "Natural",
            sessionMode: null,
          }),
          pendingNaturalEnd: absent(),
        });
        return;
      }
      if (command.kind === "InstallPodcastPlaybackSettings") {
        installCount += 1;
        if (installCount <= 2) {
          owner.reject(command, "PlayerUnavailable");
          return;
        }
        owner.reply(command, { kind: "Accepted" });
        return;
      }
      owner.reply(command, { kind: "Accepted" });
    });
    installBridge(bridge);

    render(<App />);
    await screen.findByText("Active", {
      selector: '[data-testid="player-state"]',
    });

    await act(async () => {
      await expect(
        savePodcastSubscriptionSettings(PODCAST_ID, {
          pauseShorteningMode: present("Off"),
        }),
      ).resolves.toMatchObject({
        podcast_id: PODCAST_ID,
        pause_shortening_mode: present("Off"),
      });
      await expect(
        publishPodcastSubscriptionUnsubscribed(PODCAST_ID),
      ).resolves.toBeUndefined();
    });

    expect(screen.getByTestId("player-state")).toHaveTextContent(
      "RuntimeFailed",
    );
    expect(
      commandsOf(bridge, "InstallPodcastPlaybackSettings"),
    ).toHaveLength(2);
    expect(
      commandsOf(bridge, "InstallPodcastPlaybackSettings")[1],
    ).toMatchObject({
      podcastId: PODCAST_ID,
      subscription: absent(),
    });

    await act(async () => {
      bridge.emit({
        kind: "SnapshotChanged",
        snapshot: canonicalSnapshot({
          effectiveMode: "Natural",
          sessionMode: null,
        }),
      });
    });
    expect(screen.getByTestId("player-state")).toHaveTextContent(
      "RuntimeFailed",
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Retry runtime" }),
    );
    await waitFor(() => {
      expect(
        commandsOf(bridge, "InstallPodcastPlaybackSettings"),
      ).toHaveLength(3);
      expect(screen.getByTestId("player-state")).toHaveTextContent(
        "Active",
      );
    });
    expect(
      commandsOf(bridge, "InstallPodcastPlaybackSettings")[2],
    ).toMatchObject({
      podcastId: PODCAST_ID,
      subscription: absent(),
    });
  });

  it("atomically installs both decoded podcast settings, preserves episode rate, and freezes pause intent across retry", async () => {
    const { settingsBodies } = installFetch({
      initialItems: [lecternItem(ITEM_A, MEDIA_A, "First episode")],
      settings: () =>
        jsonResponse(
          subscriptionSettingsResponse({
            defaultRate: 1.25,
            pauseMode: "Natural",
          }),
        ),
    });
    let installCount = 0;
    const bridge = new FakeNexusPlayerBridge((command, owner) => {
      if (command.kind === "Connect") {
        owner.reply(command, {
          kind: "Connected",
          snapshot: canonicalSnapshot({
            effectiveMode: "Natural",
            sessionMode: null,
          }),
          pendingNaturalEnd: absent(),
        });
        return;
      }
      if (command.kind === "InstallPodcastPlaybackSettings") {
        installCount += 1;
        if (installCount === 1) {
          owner.reject(command, "PlayerUnavailable");
          return;
        }
      }
      owner.reply(command, { kind: "Accepted" });
    });
    installBridge(bridge);

    render(<App />);
    await screen.findByText("Active", {
      selector: '[data-testid="player-state"]',
    });

    fireEvent.click(screen.getByRole("button", { name: "Remember pause" }));
    await screen.findByText("Failed", {
      selector: '[data-testid="pause-mutation"]',
    });

    await act(async () => {
      bridge.emit({
        kind: "SnapshotChanged",
        snapshot: canonicalSnapshot({
          effectiveMode: "Off",
          sessionMode: "Off",
        }),
      });
    });
    expect(screen.getByTestId("pause-mode")).toHaveTextContent("Off");

    fireEvent.click(screen.getByRole("button", { name: "Retry pause" }));

    await waitFor(() => {
      expect(settingsBodies).toHaveLength(2);
      expect(
        commandsOf(bridge, "InstallPodcastPlaybackSettings"),
      ).toHaveLength(2);
    });
    expect(settingsBodies).toEqual([
      { pause_shortening_mode: present("Natural") },
      { pause_shortening_mode: present("Natural") },
    ]);
    expect(
      commandsOf(bridge, "InstallPodcastPlaybackSettings")[1],
    ).toMatchObject({
      kind: "InstallPodcastPlaybackSettings",
      sessionKey: SESSION_A,
      podcastId: PODCAST_ID,
      subscription: present({
        defaultPlaybackSpeed: present(1.25),
        pauseShorteningMode: present("Natural"),
      }),
      rateState: {
        kind: "Canonical",
        episodeRate: present(1.75),
        podcastPreference: present({
          podcastId: PODCAST_ID,
          value: present(1.25),
        }),
        preferred: 1.75,
        temporaryNormal: false,
        base: 1.75,
      },
    });
  });
});
