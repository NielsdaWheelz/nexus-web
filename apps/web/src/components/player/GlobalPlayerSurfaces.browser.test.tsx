import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Component, type ReactNode } from "react";
import { withRenderEnvironment } from "@/__tests__/helpers/renderEnvironment";
import { AuthenticatedAccountProvider } from "@/lib/account/authenticatedAccount";
import UnauthenticatedApiBoundary from "@/lib/auth/UnauthenticatedApiBoundary";
import { ResourceCacheProvider } from "@/lib/api/resourceCache";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import { ResourceActionRuntimeProvider } from "@/lib/actions/resourceActionRuntime";
import { KeybindingsProvider } from "@/lib/keybindingsProvider";
import { LecternProvider } from "@/lib/lectern/LecternProvider";
import { LibraryPlacementControllerProvider } from "@/lib/libraries/placementController";
import { OfflineMediaProvider } from "@/lib/offlineMedia/OfflineMediaProvider";
import { ResourceOverlaysProvider } from "@/lib/resources/resourceOverlaysController";
import { ShareControllerProvider } from "@/lib/sharing/controller";
import { ANDROID_PLAYER_PROTOCOL_VERSION } from "@/lib/player/androidPlayerProtocol";
import {
  GlobalPlayerProvider,
  usePlayerCommands,
  usePlayerSession,
} from "@/lib/player/globalPlayer";
import { MobileChromeProvider } from "@/lib/workspace/mobileChrome";
import { PaneReturnMementoProvider } from "@/lib/workspace/paneReturnMemento";
import type { WorkspacePrimaryMetrics } from "@/lib/workspace/paneSizing";
import { createDefaultWorkspaceState } from "@/lib/workspace/schema";
import { WorkspaceStoreProvider } from "@/lib/workspace/store";
import { WalknoteSessionProvider } from "@/lib/walknotes/walknoteSession";
import GlobalPlayerSurfaces from "./GlobalPlayerSurfaces";

const ACCOUNT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const workspacePrimaryMetrics: WorkspacePrimaryMetrics = {
  primaryMinWidthPx: 684,
  primaryDefaultWidthPx: 684,
};

class DefectBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: true } {
    return { failed: true };
  }

  render() {
    return this.state.failed ? <p>Player defect boundary</p> : this.props.children;
  }
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}

function installBff({ holdSettlement = false } = {}): {
  releaseSettlement: () => void;
  settlementStarted: Promise<void>;
} {
  let releaseSettlement: () => void = () => {};
  const settlement = new Promise<void>((resolve) => {
    releaseSettlement = resolve;
  });
  let resolveSettlementStarted: () => void = () => {};
  const settlementStarted = new Promise<void>((resolve) => {
    resolveSettlementStarted = resolve;
  });
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(
        input instanceof Request ? input.url : String(input),
        window.location.origin,
      );
      if (url.pathname === "/api/lectern") {
        return jsonResponse({ data: { items: [] } });
      }
      if (url.pathname === "/api/consumption/commands") {
        resolveSettlementStarted();
        if (holdSettlement) await settlement;
        return jsonResponse({
          data: {
            outcome: { kind: "CompletedWithoutAdvance" },
            lectern: { items: [] },
            nextItem: { kind: "Absent" },
            progressState: { kind: "Absent" },
            completionHandle: { kind: "Absent" },
            libraryEntriesCollectionRevision: 0,
          },
        });
      }
      if (url.pathname === "/api/billing/account") {
        return jsonResponse({
          data: {
            billing_enabled: false,
            billing_plan_tier: "free",
            billing_status: "inactive",
            subscription_current_period_start: null,
            subscription_current_period_end: null,
            cancel_at_period_end: false,
            can_manage_billing: false,
            entitlement_plan_tier: "free",
            entitlement_source: "free",
            entitlement_expires_at: null,
            can_share: false,
            can_transcribe: false,
            transcription_usage: {
              used: 0,
              reserved: 0,
              limit: null,
              remaining: null,
              period_start: "2026-01-01T00:00:00Z",
              period_end: "2026-02-01T00:00:00Z",
            },
          },
        });
      }
      if (url.pathname === "/api/resource-items/action-snapshots/resolve") {
        // The shell resolves action snapshots for the playing media; the
        // player surfaces under test do not depend on their content.
        const body =
          typeof init?.body === "string"
            ? (JSON.parse(init.body) as { refs?: unknown })
            : null;
        const refs = Array.isArray(body?.refs) ? (body.refs as string[]) : [];
        return jsonResponse({
          data: {
            snapshots: refs.map((ref) => ({
              ref,
              activation: {
                resourceRef: ref,
                kind: "none",
                href: null,
                unresolvedReason: null,
              },
              missing: true,
              factsRevision: "0".repeat(64),
              capabilities: [],
            })),
          },
        });
      }
      throw new Error(`Unexpected BFF request: ${url.pathname}`);
    },
  );
  return { releaseSettlement, settlementStarted };
}

type FakeBridge = {
  postMessage: (message: string) => void;
  onmessage: ((event: { data: unknown }) => void) | null;
};

/** The only fake: the external `window.nexusPlayer` bridge Android injects. */
function installBridge(bridge: FakeBridge): void {
  vi.stubGlobal("nexusPlayer", bridge);
}

function installSkewedBridge(): void {
  const bridge: {
    postMessage: (message: string) => void;
    onmessage: ((event: { data: unknown }) => void) | null;
  } = {
    postMessage: () => {
      queueMicrotask(() => {
        bridge.onmessage?.({
          data: JSON.stringify({
            protocolVersion: ANDROID_PLAYER_PROTOCOL_VERSION + 1,
            opaque: true,
          }),
        });
      });
    },
    onmessage: null,
  };
  installBridge(bridge);
}

function canonicalSnapshot(): object {
  return {
    kind: "Canonical",
    sessionKey: "00000000-0000-4000-8000-000000000008",
    session: {
      descriptor: {
        mediaId: "00000000-0000-4000-8000-000000000009",
        title: "Canonical episode",
        subtitle: { kind: "Present", value: "Canonical podcast" },
        activation: {
          kind: "FooterAudio",
          streamUrl: "https://audio.example/episode.mp3",
          sourceUrl: "https://podcast.example/episode",
          positionMs: 12000,
          writeRevision: 3,
          resetEpoch: 1,
          playbackRate: {
            value: 1.5,
            source: "Episode",
            podcastPreference: { kind: "Absent" },
          },
          pauseShorteningMode: { kind: "Present", value: "Natural" },
          consumptionOverrideRevision: { kind: "Present", value: 4 },
          durationMs: { kind: "Present", value: 120000 },
          artworkUrl: { kind: "Absent" },
          chapters: [],
        },
      },
      origin: { kind: "Direct" },
    },
    phase: "Playing",
    positionMs: 12000,
    durationMs: 120000,
    bufferedMs: 30000,
    volume: 0.75,
    observedBaseRate: 1.5,
    rateState: {
      kind: "Canonical",
      episodeRate: { kind: "Present", value: 1.5 },
      podcastPreference: { kind: "Absent" },
      preferred: 1.5,
      temporaryNormal: false,
      base: 1.5,
    },
    persistence: { kind: "Ready" },
    playbackFailure: { kind: "Absent" },
    pauseShortening: {
      deviceDefaultMode: "Off",
      podcastOverride: { kind: "Present", value: "Natural" },
      sessionOverride: { kind: "Absent" },
      effectiveMode: "Natural",
      provenance: "Podcast",
      savedOnDeviceMs: 2500,
    },
    activitySync: {
      capture: { kind: "Recording" },
      sync: { kind: "Pending", count: 2, oldestAt: "2026-08-10T00:00:00Z" },
      acceptedRevision: 7,
    },
  };
}

function installCorruptMatchingIdentityBridge(): void {
  const bridge: FakeBridge = {
    postMessage: (message) => {
      const command = JSON.parse(message) as {
        requestId: string;
        protocolVersion: number;
        protocolContractSha256: string;
      };
      queueMicrotask(() => {
        bridge.onmessage?.({
          data: JSON.stringify({
            kind: "Connected",
            requestId: command.requestId,
            protocolVersion: command.protocolVersion,
            protocolContractSha256: command.protocolContractSha256,
            snapshot: { kind: "Canonical" },
            pendingNaturalEnd: { kind: "Absent" },
          }),
        });
      });
    },
    onmessage: null,
  };
  installBridge(bridge);
}

function installConnectThenRejectedPlayBridge(): { connected: Promise<void> } {
  let resolveConnected: () => void = () => {};
  const connected = new Promise<void>((resolve) => {
    resolveConnected = resolve;
  });
  const bridge: {
    postMessage: (message: string) => void;
    onmessage: ((event: { data: unknown }) => void) | null;
  } = {
    postMessage: (message) => {
      const command = JSON.parse(message) as {
        kind: string;
        requestId: string;
        protocolVersion: number;
        protocolContractSha256: string;
      };
      queueMicrotask(() => {
        bridge.onmessage?.({
          data: JSON.stringify({
            kind:
              command.kind === "Connect"
                ? "Connected"
                : command.kind === "Play"
                  ? "Rejected"
                  : "Accepted",
            requestId: command.requestId,
            protocolVersion: command.protocolVersion,
            protocolContractSha256: command.protocolContractSha256,
            ...(command.kind === "Connect"
              ? {
                  snapshot: canonicalSnapshot(),
                  pendingNaturalEnd: { kind: "Absent" },
                }
              : { code: "InvalidRequest" }),
          }),
        });
        if (command.kind === "Connect") resolveConnected();
      });
    },
    onmessage: null,
  };
  installBridge(bridge);
  return { connected };
}

function installNaturalEndBarrierBridge({
  delayFirstPlayRejection = false,
  delayAcknowledgement = false,
}: {
  delayFirstPlayRejection?: boolean;
  delayAcknowledgement?: boolean;
} = {}): {
  connected: Promise<void>;
  emitReceipt: () => void;
  rejectFirstPlay: () => void;
  releaseAcknowledgement: () => void;
  playCount: () => number;
  acknowledgementCount: () => number;
  commandKinds: () => readonly string[];
} {
  let resolveConnected: () => void = () => {};
  const connected = new Promise<void>((resolve) => {
    resolveConnected = resolve;
  });
  let protocolVersion: number | null = null;
  let protocolContractSha256: string | null = null;
  let plays = 0;
  let acknowledgements = 0;
  const commandKinds: string[] = [];
  let firstPlay: {
    requestId: string;
    protocolVersion: number;
    protocolContractSha256: string;
  } | null = null;
  let acknowledgement: {
    requestId: string;
    protocolVersion: number;
    protocolContractSha256: string;
  } | null = null;
  const bridge: {
    postMessage: (message: string) => void;
    onmessage: ((event: { data: unknown }) => void) | null;
  } = {
    postMessage: (message) => {
      const command = JSON.parse(message) as {
        kind: string;
        requestId: string;
        protocolVersion: number;
        protocolContractSha256: string;
      };
      protocolVersion = command.protocolVersion;
      protocolContractSha256 = command.protocolContractSha256;
      commandKinds.push(command.kind);
      if (command.kind === "Play") plays += 1;
      if (command.kind === "AcknowledgeNaturalEnd") acknowledgements += 1;
      const rejectedNaturalEnd = command.kind === "Play" && plays === 1;
      if (rejectedNaturalEnd && delayFirstPlayRejection) {
        firstPlay = command;
        return;
      }
      if (command.kind === "AcknowledgeNaturalEnd" && delayAcknowledgement) {
        acknowledgement = command;
        return;
      }
      queueMicrotask(() => {
        bridge.onmessage?.({
          data: JSON.stringify({
            kind:
              command.kind === "Connect"
                ? "Connected"
                : rejectedNaturalEnd
                  ? "Rejected"
                  : "Accepted",
            requestId: command.requestId,
            protocolVersion: command.protocolVersion,
            protocolContractSha256: command.protocolContractSha256,
            ...(command.kind === "Connect"
              ? {
                  snapshot: canonicalSnapshot(),
                  pendingNaturalEnd: { kind: "Absent" },
                }
              : rejectedNaturalEnd
                ? { code: "NaturalEndPending" }
                : {}),
          }),
        });
        if (command.kind === "Connect") resolveConnected();
      });
    },
    onmessage: null,
  };
  installBridge(bridge);
  return {
    connected,
    emitReceipt: () => {
      if (protocolVersion === null || protocolContractSha256 === null) {
        throw new Error("Natural-end receipt emitted before player connected");
      }
      queueMicrotask(() => {
        bridge.onmessage?.({
          data: JSON.stringify({
            kind: "NaturalEndPending",
            protocolVersion,
            protocolContractSha256,
            receipt: {
              accountId: ACCOUNT_ID,
              sessionKey: "00000000-0000-4000-8000-000000000008",
              mediaId: "00000000-0000-4000-8000-000000000009",
              origin: { kind: "Direct" },
              clientMutationId: "00000000-0000-4000-8000-000000000029",
              terminalListening: {
                positionMs: 120000,
                durationMs: { kind: "Present", value: 120000 },
                episodePlaybackRate: { kind: "Present", value: 1.5 },
                expectedWriteRevision: 4,
                expectedResetEpoch: 1,
              },
              expectedConsumptionOverrideRevision: { kind: "Present", value: 4 },
            },
          }),
        });
      });
    },
    rejectFirstPlay: () => {
      if (firstPlay === null) {
        throw new Error("Natural-end Play rejection was not delayed");
      }
      const command = firstPlay;
      firstPlay = null;
      queueMicrotask(() => {
        bridge.onmessage?.({
          data: JSON.stringify({
            kind: "Rejected",
            requestId: command.requestId,
            protocolVersion: command.protocolVersion,
            protocolContractSha256: command.protocolContractSha256,
            code: "NaturalEndPending",
          }),
        });
      });
    },
    releaseAcknowledgement: () => {
      if (acknowledgement === null) {
        throw new Error("Natural-end acknowledgement was not delayed");
      }
      const command = acknowledgement;
      acknowledgement = null;
      queueMicrotask(() => {
        bridge.onmessage?.({
          data: JSON.stringify({
            kind: "Accepted",
            requestId: command.requestId,
            protocolVersion: command.protocolVersion,
            protocolContractSha256: command.protocolContractSha256,
          }),
        });
      });
    },
    playCount: () => plays,
    acknowledgementCount: () => acknowledgements,
    commandKinds: () => commandKinds,
  };
}

function installUnavailablePlayReconnectBridge(): {
  connected: Promise<void>;
  reconnect: () => void;
  commandKinds: () => readonly string[];
} {
  let resolveConnected: () => void = () => {};
  const connected = new Promise<void>((resolve) => {
    resolveConnected = resolve;
  });
  let protocolVersion: number | null = null;
  let protocolContractSha256: string | null = null;
  const commandKinds: string[] = [];
  const bridge: {
    postMessage: (message: string) => void;
    onmessage: ((event: { data: unknown }) => void) | null;
  } = {
    postMessage: (message) => {
      const command = JSON.parse(message) as {
        kind: string;
        requestId: string;
        protocolVersion: number;
        protocolContractSha256: string;
      };
      protocolVersion = command.protocolVersion;
      protocolContractSha256 = command.protocolContractSha256;
      commandKinds.push(command.kind);
      queueMicrotask(() => {
        bridge.onmessage?.({
          data: JSON.stringify({
            kind:
              command.kind === "Connect"
                ? "Connected"
                : command.kind === "Play"
                  ? "Rejected"
                  : "Accepted",
            requestId: command.requestId,
            protocolVersion: command.protocolVersion,
            protocolContractSha256: command.protocolContractSha256,
            ...(command.kind === "Connect"
              ? {
                  snapshot: canonicalSnapshot(),
                  pendingNaturalEnd: { kind: "Absent" },
                }
              : command.kind === "Play"
                ? { code: "PlayerUnavailable" }
                : {}),
          }),
        });
        if (command.kind === "Connect") resolveConnected();
      });
    },
    onmessage: null,
  };
  installBridge(bridge);
  return {
    connected,
    reconnect: () => {
      if (protocolVersion === null || protocolContractSha256 === null) {
        throw new Error("Reconnect emitted before player connected");
      }
      queueMicrotask(() => {
        bridge.onmessage?.({
          data: JSON.stringify({
            kind: "ControllerReconnected",
            protocolVersion,
            protocolContractSha256,
            snapshot: canonicalSnapshot(),
            pendingNaturalEnd: { kind: "Absent" },
          }),
        });
      });
    },
    commandKinds: () => commandKinds,
  };
}

function PlayerCommandProbe() {
  const commands = usePlayerCommands();
  const session = usePlayerSession();
  return (
    <>
      <button onClick={() => commands.resume()}>Send Play</button>
      <button onClick={() => commands.seekTo(1)}>Send Seek</button>
      <p>Player state: {session.state.kind}</p>
    </>
  );
}

function renderPlayerSurfaces({
  includeCommandProbe = false,
}: {
  includeCommandProbe?: boolean;
} = {}): void {
  render(
    withRenderEnvironment(
      <AuthenticatedAccountProvider
        account={{ accountId: ACCOUNT_ID, calendarTimeZone: "UTC" }}
      >
        <UnauthenticatedApiBoundary>
          <ResourceCacheProvider value={{}}>
            <FeedbackProvider>
              <PaneReturnMementoProvider>
                <WorkspaceStoreProvider
                  initialState={createDefaultWorkspaceState(
                    "/nexus",
                    workspacePrimaryMetrics,
                  )}
                  workspacePrimaryMetrics={workspacePrimaryMetrics}
                >
                  <MobileChromeProvider>
                    <KeybindingsProvider>
                      <LecternProvider>
                        <LibraryPlacementControllerProvider>
                          <ShareControllerProvider>
                            <OfflineMediaProvider
                              accountId={ACCOUNT_ID}
                              transport={null}
                            >
                              <ResourceOverlaysProvider>
                                <DefectBoundary>
                                  <GlobalPlayerProvider accountId={ACCOUNT_ID}>
                                    <ResourceActionRuntimeProvider>
                                      <WalknoteSessionProvider>
                                        <GlobalPlayerSurfaces />
                                        {includeCommandProbe ? (
                                          <PlayerCommandProbe />
                                        ) : null}
                                      </WalknoteSessionProvider>
                                    </ResourceActionRuntimeProvider>
                                  </GlobalPlayerProvider>
                                </DefectBoundary>
                              </ResourceOverlaysProvider>
                            </OfflineMediaProvider>
                          </ShareControllerProvider>
                        </LibraryPlacementControllerProvider>
                      </LecternProvider>
                    </KeybindingsProvider>
                  </MobileChromeProvider>
                </WorkspaceStoreProvider>
              </PaneReturnMementoProvider>
            </FeedbackProvider>
          </ResourceCacheProvider>
        </UnauthenticatedApiBoundary>
      </AuthenticatedAccountProvider>,
      { androidShell: true },
    ),
  );
}

describe("Global player protocol-skew presentation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("offers Android update, not Retry, for an incompatible player reply", async () => {
    installBff();
    installSkewedBridge();
    renderPlayerSurfaces();

    const player = await screen.findByRole("region", { name: "Media player" });
    const surface = within(player);
    expect(surface.getByText("Update Nexus for Android")).toBeVisible();
    expect(
      surface.getByText("This app version no longer matches the Nexus player."),
    ).toBeVisible();
    const update = surface.getByRole("link", { name: "Update" });
    expect(update).toHaveAttribute("href", "/android");
    await userEvent.tab();
    expect(update).toHaveFocus();
    expect(surface.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("keeps Retry for transient bridge unavailability", async () => {
    installBff();
    renderPlayerSurfaces();

    const player = await screen.findByRole("region", { name: "Media player" });
    const surface = within(player);
    expect(surface.getByRole("button", { name: "Retry" })).toBeVisible();
    expect(surface.queryByText("Update Nexus for Android")).toBeNull();
    expect(surface.queryByRole("link", { name: "Update" })).toBeNull();
  });

  it("defects, never Update or Retry, when a matching-identity reply is malformed", async () => {
    installBff();
    installCorruptMatchingIdentityBridge();
    renderPlayerSurfaces();

    expect(await screen.findByText("Player defect boundary")).toBeVisible();
    expect(screen.queryByText("Update Nexus for Android")).toBeNull();
    expect(screen.queryByRole("link", { name: "Update" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("defects, rather than offering Retry, when Play is rejected after connect", async () => {
    installBff();
    const bridge = installConnectThenRejectedPlayBridge();
    renderPlayerSurfaces({ includeCommandProbe: true });

    await bridge.connected;
    await userEvent.click(screen.getByRole("button", { name: "Send Play" }));
    expect(await screen.findByText("Player defect boundary")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Update" })).toBeNull();
  });

  it("replays Play only after an observed natural-end receipt is settled", async () => {
    const bff = installBff({ holdSettlement: true });
    const bridge = installNaturalEndBarrierBridge({
      delayAcknowledgement: true,
    });
    renderPlayerSurfaces({ includeCommandProbe: true });

    await bridge.connected;
    await userEvent.click(screen.getByRole("button", { name: "Send Play" }));
    await waitFor(() => expect(bridge.playCount()).toBe(1));
    expect(screen.queryByText("Player defect boundary")).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();

    bridge.emitReceipt();
    await bff.settlementStarted;
    expect(bridge.playCount()).toBe(1);
    expect(bridge.acknowledgementCount()).toBe(0);
    bff.releaseSettlement();
    await waitFor(() => expect(bridge.acknowledgementCount()).toBe(1));
    expect(bridge.playCount()).toBe(1);
    bridge.releaseAcknowledgement();
    await waitFor(() => expect(bridge.playCount()).toBe(2));
    expect(screen.queryByText("Player defect boundary")).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("replays a delayed natural-end rejection once after its receipt already settled", async () => {
    installBff();
    const bridge = installNaturalEndBarrierBridge({
      delayFirstPlayRejection: true,
    });
    renderPlayerSurfaces({ includeCommandProbe: true });

    await bridge.connected;
    await userEvent.click(screen.getByRole("button", { name: "Send Play" }));
    await waitFor(() => expect(bridge.playCount()).toBe(1));
    bridge.emitReceipt();
    await waitFor(() => expect(bridge.acknowledgementCount()).toBe(1));
    bridge.rejectFirstPlay();
    await waitFor(() => expect(bridge.playCount()).toBe(2));
    expect(screen.queryByText("Player defect boundary")).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("serializes queued controls through settlement and acknowledgement", async () => {
    const bff = installBff({ holdSettlement: true });
    const bridge = installNaturalEndBarrierBridge({
      delayFirstPlayRejection: true,
      delayAcknowledgement: true,
    });
    renderPlayerSurfaces({ includeCommandProbe: true });

    await bridge.connected;
    await userEvent.click(screen.getByRole("button", { name: "Send Play" }));
    await userEvent.click(screen.getByRole("button", { name: "Send Seek" }));
    await waitFor(() =>
      expect(bridge.commandKinds()).toEqual(["Connect", "Play"]),
    );

    bridge.emitReceipt();
    await bff.settlementStarted;
    expect(bridge.commandKinds()).toEqual(["Connect", "Play"]);
    bff.releaseSettlement();
    await waitFor(() => expect(bridge.acknowledgementCount()).toBe(1));
    expect(bridge.commandKinds()).toEqual([
      "Connect",
      "Play",
      "AcknowledgeNaturalEnd",
    ]);

    bridge.releaseAcknowledgement();
    bridge.rejectFirstPlay();
    await waitFor(() =>
      expect(bridge.commandKinds()).toEqual([
        "Connect",
        "Play",
        "AcknowledgeNaturalEnd",
        "Play",
        "SeekTo",
      ]),
    );
    expect(screen.queryByText("Player defect boundary")).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("drops an ambiguous reconnect-frozen Play and drains queued Seek", async () => {
    installBff();
    const bridge = installUnavailablePlayReconnectBridge();
    renderPlayerSurfaces({ includeCommandProbe: true });

    await bridge.connected;
    await userEvent.click(screen.getByRole("button", { name: "Send Play" }));
    await userEvent.click(screen.getByRole("button", { name: "Send Seek" }));
    await waitFor(() =>
      expect(bridge.commandKinds()).toEqual(["Connect", "Play"]),
    );
    expect(await screen.findByText("Player state: RuntimeFailed")).toBeVisible();

    bridge.reconnect();
    await waitFor(() =>
      expect(bridge.commandKinds()).toEqual(["Connect", "Play", "SeekTo"]),
    );
    expect(screen.getByText("Player state: Active")).toBeVisible();
  });
});
