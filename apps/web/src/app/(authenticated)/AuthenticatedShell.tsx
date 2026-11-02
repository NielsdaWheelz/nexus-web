"use client";

import { NavigationIdentity } from "@/lib/host/policy";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { installedApp } from "@/lib/native/admission";
import { sessionSignIn } from "@/lib/native/client";
import { DeviceSettingsProvider } from "@/lib/native/settingsRefresh";
import { SignOutProvider } from "@/components/appnav/AccountMenu";
import AppNav from "@/components/appnav/AppNav";
import { FeedbackProvider, useOutcome } from "@/components/feedback/Feedback";
import type { Shell } from "@/components/feedback/stage";
import Nexus from "@/components/nexus/Nexus";
import GlobalPlayerSurfaces from "@/components/player/GlobalPlayerSurfaces";
import WorkspaceHost from "@/components/workspace/WorkspaceHost";
import { MobileReaderCompositionContext } from "@/components/workspace/PaneShell";
import { AuthenticatedAccountProvider } from "@/lib/account/authenticatedAccount";
import type { AuthenticatedAccount } from "@/lib/account/contract";
import ResourceActionsProvider, { ResourceActionPresentation } from "@/lib/actions/ResourceActionsProvider";
import { MediaContinuationHost } from "@/lib/actions/mediaContinuation";
import { ServerSeedsProvider } from "@/lib/api/serverState";
import { RecentProvider } from "@/lib/recent/store";
import { AuthoredProvider } from "@/lib/authored/provider";
import UnauthenticatedApiBoundary from "@/lib/auth/UnauthenticatedApiBoundary";
import { loginPath, parseReturnTarget } from "@/lib/auth/urls";
import { ActivityCapture } from "@/lib/consumption/capture";
import { LibraryOrderProvider } from "@/lib/collections/order";
import { readerSurfaceStyle } from "@/lib/reader/typography";
import { ImportsProvider } from "@/lib/imports/ImportsProvider";
import { LecternProvider } from "@/lib/lectern/lectern";
import { LibraryPlacementControllerProvider } from "@/lib/libraries/placementController";
import { MediaSummaryProvider } from "@/lib/media/MediaSummaryProvider";
import { MediaAdmissionsProvider, MediaAdmissionsHost } from "@/lib/media/admissions";
import { ChatSelectionProvider } from "@/lib/chat/selectionMemory";
import { useChatWorkOwners } from "@/lib/chat/drafts";
import { MobileChromeProvider } from "@/lib/mobileShell/chrome";
import { MobileViewportProvider } from "@/lib/mobileShell/viewport";
import { connectLocalContent } from "@/lib/offline/localContent";
import { connectListening } from "@/lib/consumption/listening";
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
import { estimatePrimaryWidthPx } from "@/lib/workspace/paneSizing";
import { useWorkspaceStore, WorkspaceStoreProvider } from "@/lib/workspace/store";
import { WorkspacePresentationsProvider } from "@/lib/workspace/presentations";
import { AuthenticatedWorkspaceErrorBoundary } from "./AuthenticatedWorkspaceErrorBoundary";
import styles from "./layout.module.css";

/** The workspace signs in: a browser leaves for login and comes back here, an installed app asks
 * its shell. One value, so `fail` stays stable. */
const SHELL: Shell = {
  signIn: {
    label: "sign in", commandKey: "SignIn",
    run: () => {
      if (installedApp) void sessionSignIn().catch(reportError);
      else window.location.assign(loginPath(parseReturnTarget(`${window.location.pathname}${window.location.search}`)));
    },
  },
};

export default function AuthenticatedShell(props: {
  browserLifetime?: string;
  account: AuthenticatedAccount;
  readerProfile: ReaderProfile;
  renderEnvironment: RenderEnvironment;
  initialState: WorkspaceState;
  seeds: Record<string, Record<string, unknown>>;
  /** Until L7: both producers pass null. */
  entryFailure: { requestId?: string } | null;
  locationLinkFailure: "TooLong" | null;
}) {
  return (
    <AuthenticatedAccountProvider key={props.account.accountId} account={props.account}>
      <RenderEnvironmentProvider value={props.renderEnvironment}>
        <MobileViewportProvider>
          <FeedbackProvider shell={SHELL}>
            <AuthoredProvider accountId={props.account.accountId}>
              <RecentProvider accountId={props.account.accountId} browserLifetime={props.browserLifetime ?? null}>
                <UnauthenticatedApiBoundary>
                <DeviceSettingsProvider>
                  <MediaAdmissionsProvider accountId={props.account.accountId}>
                    <ActivityCapture />
                    <ServerSeedsProvider seeds={props.seeds}>
                      <ReaderProvider initialProfile={props.readerProfile}>
                        <Workspace accountId={props.account.accountId} initialState={props.initialState}
                          locationLinkFailure={props.locationLinkFailure} />
                      </ReaderProvider>
                    </ServerSeedsProvider>
                  </MediaAdmissionsProvider>
                </DeviceSettingsProvider>
                </UnauthenticatedApiBoundary>
              </RecentProvider>
            </AuthoredProvider>
          </FeedbackProvider>
        </MobileViewportProvider>
      </RenderEnvironmentProvider>
    </AuthenticatedAccountProvider>
  );
}

function Workspace(props: {
  accountId: string;
  initialState: WorkspaceState;
  locationLinkFailure: "TooLong" | null;
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
        <ChatWorkOwners />
        <WorkspaceEntryNotice locationLinkFailure={props.locationLinkFailure} />
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
                            <ChatSelectionProvider>
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
                            </ChatSelectionProvider>
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
  const { state } = useWorkspaceStore();
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

function ChatWorkOwners() {
  useChatWorkOwners();
  return null;
}

/** A link the workspace could not open is a discrete outcome: the workspace opened without it. */
function WorkspaceEntryNotice({ locationLinkFailure }: { locationLinkFailure: "TooLong" | null }) {
  const { say } = useOutcome();
  const reported = useRef(false);
  useEffect(() => {
    if (locationLinkFailure === null || reported.current) return;
    reported.current = true;
    say({ fact: "couldn’t open this link.", reason: "it’s too long." });
  }, [say, locationLinkFailure]);
  return null;
}
