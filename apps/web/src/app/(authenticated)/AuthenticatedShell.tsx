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
import { useFeedback } from "@/components/feedback/Feedback";
import Nexus from "@/components/nexus/Nexus";
import GlobalPlayerSurfaces from "@/components/player/GlobalPlayerSurfaces";
import WorkspaceHost from "@/components/workspace/WorkspaceHost";
import { AuthenticatedAccountProvider } from "@/lib/account/authenticatedAccount";
import type { AuthenticatedAccount } from "@/lib/account/contract";
import ResourceActionsProvider from "@/lib/actions/ResourceActionsProvider";
import { ServerSeedsProvider } from "@/lib/api/serverState";
import UnauthenticatedApiBoundary from "@/lib/auth/UnauthenticatedApiBoundary";
import { ActivityCapture } from "@/lib/consumption/capture";
import { CollectionOrderProvider } from "@/lib/collections/CollectionOrderProvider";
import { readerSurfaceStyle } from "@/lib/documentReader/DocumentReader";
import { ImportsProvider } from "@/lib/imports/ImportsProvider";
import { LecternProvider } from "@/lib/lectern/lectern";
import { LibraryPlacementControllerProvider } from "@/lib/libraries/placementController";
import { MediaSummaryProvider } from "@/lib/media/MediaSummaryProvider";
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
  findPaneChromeFocusTarget,
  findPaneLandmarkFocusTarget,
} from "@/lib/workspace/paneDom";
import { estimatePrimaryWidthPx } from "@/lib/workspace/paneSizing";
import { useWorkspaceStore, WorkspaceStoreProvider } from "@/lib/workspace/store";
import styles from "./layout.module.css";

export default function AuthenticatedShell(props: {
  account: AuthenticatedAccount;
  readerProfile: ReaderProfile;
  renderEnvironment: RenderEnvironment;
  initialState: WorkspaceState;
  seeds: Record<string, Record<string, unknown>>;
  entryFailure: { requestId?: string } | null;
}) {
  return (
    <AuthenticatedAccountProvider account={props.account}>
      <RenderEnvironmentProvider value={props.renderEnvironment}>
        <UnauthenticatedApiBoundary>
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
        <MobileViewportProvider>
          <MobileChromeProvider>
            {/* One Lectern owner wraps the workspace leaves and the player
                runtime. The resource-action runtime reads every provider
                above it and renders the overlays its verbs open. */}
            <MediaSummaryProvider key={accountId}>
              <CollectionOrderProvider>
              <LecternProvider>
                <LibraryPlacementControllerProvider>
                  <ShareControllerProvider>
                    <GlobalPlayerProvider accountId={accountId}>
                      <ResourceActionsProvider>
                        <ImportsProvider>
                          <Nexus />
                          <div className={styles.layout}>
                            <AppNav />
                            <main className={styles.main}>
                              <WorkspaceHost />
                              <GlobalPlayerSurfaces />
                            </main>
                          </div>
                        </ImportsProvider>
                      </ResourceActionsProvider>
                    </GlobalPlayerProvider>
                  </ShareControllerProvider>
                </LibraryPlacementControllerProvider>
              </LecternProvider>
              </CollectionOrderProvider>
            </MediaSummaryProvider>
          </MobileChromeProvider>
        </MobileViewportProvider>
      </WorkspaceStoreProvider>
    </>
  );
}

const ENTRY_NOTICE = "workspace-entry-read";

function WorkspaceEntryNotice({ failure }: { failure: { requestId?: string } | null }) {
  const router = useRouter();
  const { publish, resolve } = useFeedback();
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

  useEffect(() => {
    if (failure === null) return;
    publish({
      kind: "Persistent",
      key: ENTRY_NOTICE,
      content: {
        tone: "Warning",
        title: "workspace update wasn’t confirmed",
        message: "your open workspace is still available.",
        requestId: failure.requestId,
      },
      announcement: "Polite",
      actions: [{ label: "try again", busy: pending, onClick: retry }],
      // Both entry defect boundaries expose this terminal focus destination.
      returnFocus: () => document.getElementById("entry-failure")
        ?? findPaneLandmarkFocusTarget(activePaneId.current)
        ?? findPaneChromeFocusTarget(activePaneId.current),
    });
  }, [failure, pending, publish, retry]);

  useLayoutEffect(() => {
    // Keep the removal target current without republishing a dismissed notice.
    activePaneId.current = state.active_primary_pane_id;
    if (failure === null) resolve(ENTRY_NOTICE);
  }, [failure, resolve, state.active_primary_pane_id]);

  // A keyed update keeps the existing notice and button. Only unmount cleans it up.
  useEffect(() => () => resolve(ENTRY_NOTICE), [resolve]);
  return null;
}
