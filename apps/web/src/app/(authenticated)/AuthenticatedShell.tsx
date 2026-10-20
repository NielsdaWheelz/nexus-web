"use client";

import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useTransition,
} from "react";
import AppNav from "@/components/appnav/AppNav";
import { FeedbackProvider, useWorkspaceCondition } from "@/components/feedback/Feedback";
import Nexus from "@/components/nexus/Nexus";
import GlobalPlayerSurfaces from "@/components/player/GlobalPlayerSurfaces";
import WorkspaceHost from "@/components/workspace/WorkspaceHost";
import { AuthenticatedAccountProvider } from "@/lib/account/authenticatedAccount";
import type { AuthenticatedAccount } from "@/lib/account/contract";
import ResourceActionsProvider from "@/lib/actions/ResourceActionsProvider";
import { ServerSeedsProvider } from "@/lib/api/serverState";
import UnauthenticatedApiBoundary from "@/lib/auth/UnauthenticatedApiBoundary";
import { ActivityCapture } from "@/lib/consumption/capture";
import { LibraryOrderProvider } from "@/lib/collections/order";
import { readerSurfaceStyle } from "@/lib/documentReader/DocumentReader";
import { ImportsProvider } from "@/lib/imports/ImportsProvider";
import { LecternProvider } from "@/lib/lectern/lectern";
import { LibraryPlacementControllerProvider } from "@/lib/libraries/placementController";
import { MediaSummaryProvider } from "@/lib/media/MediaSummaryProvider";
import { AdmissionRecoveryProvider, AdmissionRecoveryHost } from "@/lib/media/AdmissionRecoveryProvider";
import { MobileChromeProvider } from "@/lib/mobileShell/chrome";
import { MobileViewportProvider } from "@/lib/mobileShell/viewport";
import { connectOffline } from "@/lib/offline/bridge";
import { GlobalPlayerProvider } from "@/lib/player/playerRuntime";
import {
  ReaderProvider,
  useReaderContext,
  type ReaderProfile,
} from "@/lib/reader/ReaderContext";
import { RenderEnvironmentProvider } from "@/lib/renderEnvironment/provider";
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
import styles from "./layout.module.css";

const returnWorkspaceFocus = () => document.getElementById("entry-failure") ?? findActivePaneLandmarkFocusTarget();

export default function AuthenticatedShell(props: {
  account: AuthenticatedAccount;
  readerProfile: ReaderProfile;
  renderEnvironment: RenderEnvironment;
  initialState: WorkspaceState;
  seeds: Record<string, Record<string, unknown>>;
  entryFailure: { requestId?: string } | null;
}) {
  return (
    <AuthenticatedAccountProvider key={props.account.accountId} account={props.account}>
      <RenderEnvironmentProvider value={props.renderEnvironment}>
        <UnauthenticatedApiBoundary>
          <MobileViewportProvider>
            <FeedbackProvider returnFocus={returnWorkspaceFocus}>
              <AdmissionRecoveryProvider accountId={props.account.accountId}>
                <ActivityCapture />
                <ServerSeedsProvider seeds={props.seeds}>
                  <ReaderProvider initialProfile={props.readerProfile}>
                    <Workspace
                      accountId={props.account.accountId}
                      initialState={props.initialState}
                      entryFailure={props.entryFailure}
                    />
                  </ReaderProvider>
                </ServerSeedsProvider>
              </AdmissionRecoveryProvider>
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
  entryFailure: { requestId?: string } | null;
}) {
  const { accountId } = props;
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
  // Binds Android's offline store to this account.
  useEffect(() => connectOffline(accountId), [accountId]);
  return (
    <>
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
        <WorkspaceEntryNotice failure={props.entryFailure} />
        <MobileChromeProvider>
          {/* One Lectern owner wraps the workspace leaves and the player
              runtime. The resource-action runtime reads every provider
              above it and renders the overlays its verbs open. */}
          <MediaSummaryProvider key={accountId}>
            <LibraryOrderProvider>
              <LecternProvider>
                <LibraryPlacementControllerProvider>
                  <ShareControllerProvider>
                    <GlobalPlayerProvider accountId={accountId}>
                      <ResourceActionsProvider>
                        <AdmissionRecoveryHost />
                        <ImportsProvider>
                          <WorkspacePresentationsProvider key={accountId} accountId={accountId}>
                            <Nexus />
                            <div className={styles.layout}>
                              <AppNav />
                              <main className={styles.main}>
                                <WorkspaceHost />
                                <GlobalPlayerSurfaces />
                              </main>
                            </div>
                          </WorkspacePresentationsProvider>
                        </ImportsProvider>
                      </ResourceActionsProvider>
                    </GlobalPlayerProvider>
                  </ShareControllerProvider>
                </LibraryPlacementControllerProvider>
              </LecternProvider>
            </LibraryOrderProvider>
          </MediaSummaryProvider>
        </MobileChromeProvider>
      </WorkspaceStoreProvider>
    </>
  );
}

const ENTRY_NOTICE = "workspace-entry-read";

function WorkspaceEntryNotice({ failure }: { failure: { requestId?: string } | null }) {
  const router = useRouter();
  const { state } = useWorkspaceStore();
  const [pending, startTransition] = useTransition();
  const inFlight = useRef(false);
  const activePaneId = useRef(state.active_primary_pane_id);
  const retry = useCallback(() => {
    if (inFlight.current) return;
    inFlight.current = true;
    startTransition(() => router.refresh());
  }, [router]);

  useEffect(() => {
    if (!pending) inFlight.current = false;
  }, [pending]);

  activePaneId.current = state.active_primary_pane_id;
  useWorkspaceCondition(ENTRY_NOTICE, failure === null ? null : {
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
