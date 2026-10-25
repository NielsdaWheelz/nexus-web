"use client";

import { useActivityNavigation } from "@/components/feedback/Activity";
import { NavigationIdentity, useHostPolicy } from "@/lib/host/policy";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useTransition,
  type ReactNode,
} from "react";
import { installedApp } from "@/lib/native/admission";
import { DeviceSettingsProvider } from "@/lib/native/settingsRefresh";
import { DeviceSessionNotice } from "@/lib/native/DeviceSessionNotice";
import { SignOutProvider } from "@/components/appnav/AccountMenu";
import AppNav from "@/components/appnav/AppNav";
import { FeedbackProvider, useFeedback, useWorkspaceCondition } from "@/components/feedback/Feedback";
import Nexus from "@/components/nexus/Nexus";
import GlobalPlayerSurfaces from "@/components/player/GlobalPlayerSurfaces";
import WorkspaceHost from "@/components/workspace/WorkspaceHost";
import { MobileReaderCompositionContext } from "@/components/workspace/PaneShell";
import { AuthenticatedAccountProvider } from "@/lib/account/authenticatedAccount";
import type { AuthenticatedAccount } from "@/lib/account/contract";
import ResourceActionsProvider, { ResourceActionPresentation } from "@/lib/actions/ResourceActionsProvider";
import { MediaContinuationHost } from "@/lib/actions/mediaContinuation";
import { ServerSeedsProvider } from "@/lib/api/serverState";
import { useWritingReceive } from "@/lib/api/writingReceive";
import { apiTransportFeedback } from "@/lib/api/client";
import UnauthenticatedApiBoundary from "@/lib/auth/UnauthenticatedApiBoundary";
import { ActivityCapture } from "@/lib/consumption/capture";
import { LibraryOrderProvider } from "@/lib/collections/order";
import { readerSurfaceStyle } from "@/lib/documentReader/DocumentReader";
import { ImportsProvider } from "@/lib/imports/ImportsProvider";
import { LecternProvider } from "@/lib/lectern/lectern";
import { LibraryPlacementControllerProvider } from "@/lib/libraries/placementController";
import { MediaSummaryProvider } from "@/lib/media/MediaSummaryProvider";
import { MediaAdmissionsProvider, MediaAdmissionsHost } from "@/lib/media/admissions";
import { useChatWorkOwners } from "@/lib/chat/drafts";
import { WorkProvider } from "@/lib/unsavedWork";
import { MobileChromeProvider } from "@/lib/mobileShell/chrome";
import { MobileViewportProvider } from "@/lib/mobileShell/viewport";
import { useWritingRuntime } from "@/lib/notes/useWritingRuntime";
import { connectLocalContent } from "@/lib/offline/localContent";
import { connectListening, observeConsumption, useConsumptionObservationReady, type EpisodeConsumptionObservation } from "@/lib/consumption/listening";
import { resolvePaneRouteModel } from "@/lib/panes/paneRouteModel";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import { GlobalPlayerProvider } from "@/lib/player/playerRuntime";
import { PlayerPresentationProvider, usePlayerPresentation } from "@/lib/player/presentation";
import {
  ReaderProvider,
  useReaderContext,
  type ReaderProfile,
} from "@/lib/reader/ReaderContext";
import { getBrowserViewportKind, RenderEnvironmentProvider } from "@/lib/renderEnvironment/provider";
import type { RenderEnvironment } from "@/lib/renderEnvironment/types";
import { ShareControllerProvider } from "@/lib/sharing/controller";
import type { WorkspaceState } from "@/lib/workspace/model";
import {
  findActivePaneLandmarkFocusTarget,
  findPaneChromeFocusTarget,
  findPaneLandmarkFocusTarget,
} from "@/lib/workspace/paneDom";
import { estimatePrimaryWidthPx } from "@/lib/workspace/paneSizing";
import { useWorkspaceStore, WorkspaceStoreProvider } from "@/lib/workspace/store";
import { WorkspacePresentationsProvider } from "@/lib/workspace/presentations";
import { AuthenticatedWorkspaceErrorBoundary } from "./AuthenticatedWorkspaceErrorBoundary";
import styles from "./layout.module.css";

const returnWorkspaceFocus = () => document.getElementById("entry-failure") ?? findActivePaneLandmarkFocusTarget();

export default function AuthenticatedShell(props: {
  account: AuthenticatedAccount;
  readerProfile: ReaderProfile;
  renderEnvironment: RenderEnvironment;
  initialState: WorkspaceState;
  seeds: Record<string, Record<string, unknown>>;
  consumptionObservations: readonly EpisodeConsumptionObservation[];
  entryFailure: { requestId?: string } | null;
  locationLinkFailure: "TooLong" | null;
}) {
  return (
    <AuthenticatedAccountProvider key={props.account.accountId} account={props.account}>
      <RenderEnvironmentProvider value={props.renderEnvironment}>
        <UnauthenticatedApiBoundary>
          <MobileViewportProvider>
            <FeedbackProvider returnFocus={returnWorkspaceFocus}>
              <DeviceSettingsProvider><WorkProvider>
                {installedApp ? <DeviceSessionNotice /> : null}
                <MediaAdmissionsProvider accountId={props.account.accountId}>
                  <ActivityCapture />
                  <ServerSeedsProvider seeds={props.seeds}>
                    <ReaderProvider initialProfile={props.readerProfile}>
                      <Workspace
                        accountId={props.account.accountId}
                        initialState={props.initialState}
                        consumptionObservations={props.consumptionObservations}
                        entryFailure={props.entryFailure}
                        locationLinkFailure={props.locationLinkFailure}
                      />
                    </ReaderProvider>
                  </ServerSeedsProvider>
                </MediaAdmissionsProvider>
              </WorkProvider></DeviceSettingsProvider>
            </FeedbackProvider>
          </MobileViewportProvider>
        </UnauthenticatedApiBoundary>
      </RenderEnvironmentProvider>
    </AuthenticatedAccountProvider>
  );
}

function Workspace(props: {
  accountId: string;
  initialState: WorkspaceState;
  consumptionObservations: readonly EpisodeConsumptionObservation[];
  entryFailure: { requestId?: string } | null;
  locationLinkFailure: "TooLong" | null;
}) {
  const { accountId } = props;
  const observationReady = useConsumptionObservationReady();
  const sentBootstrapObservations = useRef(false);
  useEffect(() => {
    if (!observationReady || sentBootstrapObservations.current) return;
    sentBootstrapObservations.current = true;
    observeConsumption(props.consumptionObservations);
  }, [observationReady, props.consumptionObservations]);
  const { profile } = useReaderContext();
  // The reader column is every pane's preferred and default width: the server
  // estimates it from the profile, and this hidden probe measures it.
  const probe = useRef<HTMLDivElement>(null);
  const [columnWidthPx, setColumnWidthPx] = useState(() =>
    estimatePrimaryWidthPx(profile),
  );
  useLayoutEffect(() => {
    const node = probe.current!;
    const measure = () => {
      const width = Math.ceil(node.getBoundingClientRect().width);
      if (width > 0) setColumnWidthPx(width);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [profile]);
  // Native owns account binding; these subscriptions read its committed local facts
  // for this account and retire with it.
  useEffect(() => connectLocalContent({ accountId, indexPath: "/_nexus/device/downloads.json" }), [accountId]);
  useEffect(() => installedApp ? connectListening(accountId) : undefined, [accountId]);
  return (
    <PlayerPresentationProvider accountId={accountId}>
      <div
        ref={probe}
        aria-hidden="true"
        className={styles.columnProbe}
        style={readerSurfaceStyle(profile)}
      />
      <WorkspaceStoreProvider
        initialState={props.initialState}
        columnWidthPx={columnWidthPx}
      >
        <WritingRuntime accountId={accountId}>
          <ChatWorkOwners />
          <WorkspaceEntryNotice failure={props.entryFailure} locationLinkFailure={props.locationLinkFailure} />
          <SignOutProvider>
            <MobileChromeProvider>
              {/* One Lectern owner wraps the workspace leaves and the player
                  runtime. The resource-action runtime reads every provider
                  above it and renders the overlays its verbs open. */}
              <MediaSummaryProvider key={accountId}>
                <LibraryOrderProvider>
                  <LecternProvider>
                    <LibraryPlacementControllerProvider>
                      <ShareControllerProvider>
                        <WorkspacePlayer accountId={accountId}>
                          <ResourceActionsProvider>
                            <AuthenticatedWorkspaceErrorBoundary>
                              <ResourceActionPresentation />
                              <MediaAdmissionsHost />
                              <ImportsProvider>
                                <MediaContinuationHost />
                                <WorkspacePresentationsProvider key={accountId} accountId={accountId}>
                                  <WorkspaceNavigation>
                                    <Nexus />
                                    <WorkspaceCanvas />
                                  </WorkspaceNavigation>
                                </WorkspacePresentationsProvider>
                              </ImportsProvider>
                            </AuthenticatedWorkspaceErrorBoundary>
                          </ResourceActionsProvider>
                        </WorkspacePlayer>
                      </ShareControllerProvider>
                    </LibraryPlacementControllerProvider>
                  </LecternProvider>
                </LibraryOrderProvider>
              </MediaSummaryProvider>
            </MobileChromeProvider>
          </SignOutProvider>
        </WritingRuntime>
      </WorkspaceStoreProvider>
    </PlayerPresentationProvider>
  );
}

function WorkspacePlayer({ accountId, children }: { accountId: string; children: ReactNode }) {
  const { show } = usePlayerPresentation();
  const onExplicitPlay = useCallback(() => {
    if (getBrowserViewportKind() === "desktop") show({ focus: false });
  }, [show]);
  return <GlobalPlayerProvider accountId={accountId} onExplicitPlay={onExplicitPlay}>{children}</GlobalPlayerProvider>;
}

function WorkspaceNavigation({ children }: { children: ReactNode }) {
  const { state, foregroundGeneration, pendingPaneFocus } = useWorkspaceStore();
  useActivityNavigation(foregroundGeneration, pendingPaneFocus);
  return <NavigationIdentity value={state.panes.find(pane => pane.id === state.active_primary_pane_id)!.current_visit.href}>{children}</NavigationIdentity>;
}

/** A route selects the shell composition before loading or mounting its reader. */
function WorkspaceCanvas() {
  const { state } = useWorkspaceStore();
  const isMobile = useIsMobileViewport();
  const active = state.panes.find(pane => pane.id === state.active_primary_pane_id);
  if (!active) throw new Error("workspace active pane is missing");
  const readerComposition = isMobile && resolvePaneRouteModel(active.current_visit.href).returnKind === "Reader";
  return <MobileReaderCompositionContext value={readerComposition}>
    <div className={styles.layout}>
      <AppNav />
      <main className={styles.main} data-reader-composition={readerComposition || undefined}>
        <WorkspaceHost />
        <GlobalPlayerSurfaces readerComposition={readerComposition} />
      </main>
    </div>
  </MobileReaderCompositionContext>;
}

/** The document owns live writing and its automatic-update hold; reads retain their existing receive owner. */
function WritingRuntime({ accountId, children }: { accountId: string; children: ReactNode }) {
  const runtime = useWritingRuntime(accountId);
  const receive = useWritingReceive(accountId);
  const { connection, probe_failure, probing } = receive.snapshot;
  useWorkspaceCondition("writing-update", !runtime.reloadHeld ? null : {
    needsAttention: true,
    priority: "Action",
    content: { tone: "Warning", title: "nexus was updated.", message: "finish saving before reloading. other unsaved changes will be lost." },
    announcement: "Polite",
    actions: [{ label: "reload app", onClick: () => { window.location.reload(); } }],
  });
  useWorkspaceCondition("writing-receive", connection.failure !== null ? {
    needsAttention: true,
    priority: "Action",
    content: {
      ...(apiTransportFeedback(connection.failure, "live updates are unavailable.") ?? {
        tone: "Warning", title: "live updates are unavailable.", message: "changes made elsewhere may not appear here.",
      }),
      requestId: connection.failure.requestId,
    },
    announcement: "Polite",
    actions: [{ label: "retry live updates", onClick: receive.reconnect, busy: connection.phase === "connecting" || connection.phase === "recovering" }],
  } : connection.phase === "recovering" ? {
    needsAttention: false,
    priority: "Status",
    content: { tone: "Neutral", title: "reconnecting live updates…" },
    announcement: "None",
  } : null);
  useWorkspaceCondition("writing-probe", probe_failure === null ? null : {
    needsAttention: true,
    priority: "Action",
    content: {
      ...(apiTransportFeedback(probe_failure, "some open content couldn’t refresh.") ?? {
        tone: "Warning", title: "some open content couldn’t refresh.",
      }),
      requestId: probe_failure.requestId,
    },
    announcement: "Polite",
    actions: [{ label: "try again", onClick: receive.retryProbe, busy: probing }],
  });
  return children;
}

function ChatWorkOwners() {
  useChatWorkOwners();
  return null;
}

const ENTRY_NOTICE = "workspace-entry-read";

function WorkspaceEntryNotice({ failure, locationLinkFailure }: { failure: { requestId?: string } | null; locationLinkFailure: "TooLong" | null }) {
  const host = useHostPolicy();
  const feedback = useFeedback();
  const reportedLocation = useRef(false);
  const { state } = useWorkspaceStore();
  const [pending, startTransition] = useTransition();
  const inFlight = useRef(false);
  const activePaneId = useRef(state.active_primary_pane_id);
  const retry = useCallback(() => {
    if (inFlight.current) return;
    inFlight.current = true;
    startTransition(() => host.recover());
  }, [host]);

  useEffect(() => {
    if (locationLinkFailure === null || reportedLocation.current) return;
    reportedLocation.current = true;
    feedback.offer({ key: "location-entry", announcement: "Polite", needsAttention: true, undo: null, onDismiss: null,
      content: { tone: "Warning", title: "this location link is too long" } });
  }, [feedback, locationLinkFailure]);

  useEffect(() => {
    if (!pending) inFlight.current = false;
  }, [pending]);

  activePaneId.current = state.active_primary_pane_id;
  useWorkspaceCondition(ENTRY_NOTICE, failure === null ? null : {
    needsAttention: true,
    priority: "Status",
    content: {
      tone: "Warning",
      title: "workspace update not confirmed",
      message: "your open workspace remains in this tab.",
      requestId: failure.requestId,
    },
    announcement: "Polite",
    actions: [{ label: "try again", busy: pending, onClick: retry }],
    returnFocus: () => document.getElementById("entry-failure")
      ?? findPaneLandmarkFocusTarget(activePaneId.current)
      ?? findPaneChromeFocusTarget(activePaneId.current),
  });
  return null;
}
