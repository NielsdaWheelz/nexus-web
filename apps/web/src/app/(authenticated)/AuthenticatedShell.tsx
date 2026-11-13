"use client";

import { ACCOUNT_DAY_UNAVAILABLE } from "@/lib/notes/accountDay";
import { getDestination } from "@/lib/navigation/destinations";
import { assertNever } from "@/lib/assertNever";
import { NavigationIdentity } from "@/lib/host/policy";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { installedApp } from "@/lib/native/admission";
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
import { ServerArrivalsProvider } from "@/lib/api/serverState";
import { RecentProvider } from "@/lib/recent/store";
import { AuthoredProvider, useAuthoredSignIn } from "@/lib/authored/provider";
import UnauthenticatedApiBoundary from "@/lib/auth/UnauthenticatedApiBoundary";
import { ActivityCapture } from "@/lib/consumption/capture";
import { LibraryOrderProvider } from "@/lib/collections/order";
import { readerSurfaceStyle } from "@/lib/reader/typography";
import { ImportsProvider } from "@/lib/imports/ImportsProvider";
import { ImportIntakeHost, ImportIntakeProvider } from "@/lib/imports/intake";
import { LecternProvider } from "@/lib/lectern/lectern";
import { LibraryPlacementControllerProvider } from "@/lib/libraries/placementController";
import { MediaSummaryProvider } from "@/lib/media/MediaSummaryProvider";
import { MediaAdmissionsProvider, MediaAdmissionsHost } from "@/lib/media/admissions";
import MetadataOutcomeHost from "@/lib/media/MetadataOutcomeHost";
import { ChatSelectionProvider } from "@/lib/chat/selectionMemory";
import { useChatWorkOwners } from "@/lib/chat/drafts";
import { MobileChromeProvider } from "@/lib/mobileShell/chrome";
import { MobileViewportProvider } from "@/lib/mobileShell/viewport";
import { requestNexusOpen } from "@/lib/nexus/events";
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
import type { InitialPresentations } from "@/lib/workspace/presentationRead";
import { WorkspacePresentationsProvider } from "@/lib/workspace/presentations";
import { AuthenticatedWorkspaceErrorBoundary } from "./AuthenticatedWorkspaceErrorBoundary";
import styles from "./layout.module.css";

export default function AuthenticatedShell(props: {
  browserLifetime?: string;
  account: AuthenticatedAccount;
  readerProfile: ReaderProfile;
  renderEnvironment: RenderEnvironment;
  initialState: WorkspaceState;
  initialPresentations?: InitialPresentations;
  locationLinkFailure: "TooLong" | "CalendarUnavailable" | null;
}) {
  // The workspace signs in through the account's one sign-in owner, which ignores a press while
  // a sign-in runs and tells its result. That owner sits beneath the feedback provider, so the
  // workspace binds it here once the account opens. One value, so `fail` stays stable.
  const [signInBusy, setSignInBusy] = useState(false);
  const [{ shell, bindSignIn }] = useState(() => {
    let owner: (() => void) | null = null;
    const shell: Shell = { signIn: { label: "sign in", commandKey: "SignIn", run: () => owner?.() } };
    return { shell, bindSignIn: (signIn: (() => void) | null, busy: boolean) => { owner = signIn; setSignInBusy(busy); } };
  });
  const boundShell = useMemo(() => ({ ...shell, signInBusy }), [shell, signInBusy]);
  return (
    <AuthenticatedAccountProvider key={props.account.accountId} account={props.account}>
      <RenderEnvironmentProvider value={props.renderEnvironment}>
        <MobileViewportProvider>
          <FeedbackProvider shell={boundShell}>
            <AuthoredProvider accountId={props.account.accountId}>
              <RecentProvider accountId={props.account.accountId} browserLifetime={props.browserLifetime ?? null}>
                <UnauthenticatedApiBoundary>
                <DeviceSettingsProvider browserLifetime={props.browserLifetime ?? null}>
                  <MediaAdmissionsProvider accountId={props.account.accountId}>
                  <ImportIntakeProvider accountId={props.account.accountId}>
                    <ActivityCapture />
                    <ServerArrivalsProvider>
                      <ReaderProvider initialProfile={props.readerProfile}>
                        <Workspace accountId={props.account.accountId} initialState={props.initialState}
                          initialPresentations={props.initialPresentations} locationLinkFailure={props.locationLinkFailure} bindSignIn={bindSignIn} />
                      </ReaderProvider>
                    </ServerArrivalsProvider>
                  </ImportIntakeProvider>
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
  initialPresentations?: InitialPresentations;
  locationLinkFailure: "TooLong" | "CalendarUnavailable" | null;
  bindSignIn: (signIn: (() => void) | null, busy: boolean) => void;
}) {
  const { accountId, bindSignIn } = props;
  const { signIn, busy } = useAuthoredSignIn();
  useLayoutEffect(() => { bindSignIn(signIn, busy); }, [bindSignIn, signIn, busy]);
  useLayoutEffect(() => () => bindSignIn(null, false), [bindSignIn]);
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
                          <WorkspaceCanvas>{(player, readerComposition) => <AuthenticatedWorkspaceErrorBoundary>
                            <ChatSelectionProvider>
                              <ResourceActionPresentation />
                              <MediaAdmissionsHost />
                              <MetadataOutcomeHost />
                              <ImportsProvider>
                                <ImportIntakeHost openPage={openImportPage}>
                                  <MediaContinuationHost />
                                  <WorkspacePresentationsProvider key={accountId} accountId={accountId} initial={props.initialPresentations}>
                                    <WorkspaceNavigation>
                                      <Nexus />
                                      <div className={styles.layout}>
                                        <AppNav />
                                        <main className={styles.main} data-reader-composition={readerComposition || undefined}>
                                          <WorkspaceHost />
                                          {player}
                                        </main>
                                      </div>
                                    </WorkspaceNavigation>
                                  </WorkspacePresentationsProvider>
                                </ImportIntakeHost>
                              </ImportsProvider>
                            </ChatSelectionProvider>
                          </AuthenticatedWorkspaceErrorBoundary>}</WorkspaceCanvas>
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

/** A settled batch's `see`: the palette's import command, whichever page it opens. */
const openImportPage = () => requestNexusOpen({ kind: "QuickAction", actionId: "Nexus.Quick.Import" });

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
function WorkspaceCanvas({ children }: { children: (player: ReactNode, readerComposition: boolean) => ReactNode }) {
  const { state } = useWorkspaceStore();
  const isMobile = useIsMobileViewport();
  const active = state.panes.find(pane => pane.id === state.active_primary_pane_id);
  if (!active) throw new Error("workspace active pane is missing");
  const readerComposition = isMobile && resolvePaneRouteModel(active.current_visit.href).returnKind === "Reader";
  return <MobileReaderCompositionContext value={readerComposition}>
    <GlobalPlayerSurfaces readerComposition={readerComposition}>{player => children(player, readerComposition)}</GlobalPlayerSurfaces>
  </MobileReaderCompositionContext>;
}

function ChatWorkOwners() {
  useChatWorkOwners();
  return null;
}

/** A link the workspace could not open is a discrete outcome: the workspace opened without it. */
function WorkspaceEntryNotice({ locationLinkFailure }: { locationLinkFailure: "TooLong" | "CalendarUnavailable" | null }) {
  const { say } = useOutcome();
  const reported = useRef(false);
  useEffect(() => {
    if (locationLinkFailure === null || reported.current) return;
    reported.current = true;
    switch (locationLinkFailure) {
      case "TooLong": say({ fact: "this link is too long to open." }); return;
      case "CalendarUnavailable": {
        const account = getDestination("account");
        say({ fact: ACCOUNT_DAY_UNAVAILABLE }, [{ label: account.label, href: account.href }]);
        return;
      }
      default: assertNever(locationLinkFailure);
    }
  }, [say, locationLinkFailure]);
  return null;
}
