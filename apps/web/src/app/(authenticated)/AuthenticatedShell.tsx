"use client";

import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
  type ReactNode,
} from "react";
import { SignOutProvider } from "@/components/appnav/AccountMenu";
import AppNav from "@/components/appnav/AppNav";
import { FeedbackProvider, FeedbackState, useFeedback, useWorkspaceCondition, type FeedbackAction } from "@/components/feedback/Feedback";
import Nexus from "@/components/nexus/Nexus";
import { downloadWriting } from "@/components/notes/NoteNotices";
import GlobalPlayerSurfaces from "@/components/player/GlobalPlayerSurfaces";
import WorkspaceHost from "@/components/workspace/WorkspaceHost";
import { AuthenticatedAccountProvider } from "@/lib/account/authenticatedAccount";
import type { AuthenticatedAccount } from "@/lib/account/contract";
import ResourceActionsProvider from "@/lib/actions/ResourceActionsProvider";
import { ServerSeedsProvider } from "@/lib/api/serverState";
import { useWritingReceive } from "@/lib/api/writingReceive";
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
import {
  readWriting,
  retryWritingStorage,
  subscribeWriting,
  writingHasMemoryOnlyChanges,
} from "@/lib/notes/journal";
import { useWritingRuntime } from "@/lib/notes/useWritingRuntime";
import { connectOffline } from "@/lib/offline/bridge";
import { activateTargetLink } from "@/lib/panes/targetLinkActivation";
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
import { useLatestWorkspace, useWorkspaceStore, WorkspaceStoreProvider } from "@/lib/workspace/store";
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
        <WritingRuntime accountId={accountId}>
          <WorkspaceEntryNotice failure={props.entryFailure} />
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
          </SignOutProvider>
        </WritingRuntime>
      </WorkspaceStoreProvider>
    </>
  );
}

/** Account-wide writing facts that need attention, as one comparable key, so that
 * ordinary checkpoints do not re-render the shell. */
function writingAttention(): string {
  const { storage_error, outbox, incompatible } = readWriting();
  return [
    storage_error === null ? "" : writingHasMemoryOnlyChanges() ? "memory" : "storage",
    outbox.some((row) => row.uncertain && row.blocked !== null) ? "parked" : "",
    incompatible.length > 0 ? "old" : "",
  ].join(":");
}

/**
 * This account's writing runtime gates every editor until its lease is held; a
 * failed start shows only its retry. The shell presents the account-wide
 * conditions and the writing stream. Ordinary status stays with its text.
 */
function WritingRuntime({ accountId, children }: { accountId: string; children: ReactNode }) {
  const runtime = useWritingRuntime(accountId);
  const latest = useLatestWorkspace();
  const receive = useWritingReceive(accountId);
  const feedback = useFeedback();
  const [storage, parked, old] = useSyncExternalStore(subscribeWriting, writingAttention, () => "::").split(":");
  const download: FeedbackAction = { label: "download writing", onClick: () => downloadWriting(feedback, accountId) };
  useWorkspaceCondition("writing-storage", storage === "" ? null : {
    priority: "Write",
    content: storage === "memory"
      ? { tone: "Danger", title: "recent changes are only in this tab.", message: "keep it open or download your writing." }
      : { tone: "Warning", title: "this device can’t keep writing right now.", message: "new changes will stay only in this tab." },
    announcement: "Polite",
    actions: [download, { label: "try again", onClick: () => void retryWritingStorage().catch(() => undefined) }],
  });
  useWorkspaceCondition("writing-halted", parked === "" && old === "" ? null : {
    priority: "Action",
    content: {
      tone: "Warning",
      title: "some writing isn’t syncing.",
      message: old !== ""
        ? "some was saved by another version of nexus. download or discard it in notes."
        : "a change couldn’t be confirmed. later changes wait until you review it in notes.",
    },
    announcement: "Polite",
    actions: [{
      label: "review in notes",
      href: "/notes",
      onActivate: (event) => activateTargetLink({
        event,
        runtime: { activateTarget: (request) => latest().activateWorkspaceTarget({ ...request, originPaneId: latest().state.active_primary_pane_id }) },
        target: { href: "/notes" },
      }),
    }],
  });
  useWorkspaceCondition("writing-update", !runtime.reloadHeld ? null : {
    priority: "Action",
    content: { tone: "Warning", title: "nexus was updated.", message: "download your writing, then reload." },
    announcement: "Polite",
    actions: [download, { label: "reload app", onClick: () => window.location.reload() }],
  });
  useWorkspaceCondition("writing-receive", receive.error === null ? null : {
    priority: "Status",
    content: { tone: "Warning", title: "updates from other tabs and devices are paused." },
    announcement: "Polite",
    actions: [{ label: "reconnect", onClick: receive.retry }],
  });
  if (runtime.state === "ready") return children;
  if (runtime.state === "starting") return null;
  return <FeedbackState
    content={{ tone: "Danger", title: "writing couldn’t start.", message: "nothing can be edited until it does. check your connection, then try again." }}
    announcement="Assertive"
    actions={[{ label: "try again", onClick: runtime.retry, busy: runtime.state === "retrying" }]}
  />;
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
