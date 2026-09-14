"use client";

import { useEffect, useState } from "react";
import AppNav from "@/components/appnav/AppNav";
import Nexus from "@/components/nexus/Nexus";
import WorkspaceHost from "@/components/workspace/WorkspaceHost";
import GlobalPlayerSurfaces from "@/components/player/GlobalPlayerSurfaces";
import LecternMutationNotice from "@/components/LecternMutationNotice";
import { WebVitalsReporter } from "@/components/workspace/WebVitalsReporter";
import LocalVaultAutoSync from "./LocalVaultAutoSync";
import DownloadsSurface from "@/components/offlineMedia/DownloadsSurface";
import UnauthenticatedApiBoundary from "@/lib/auth/UnauthenticatedApiBoundary";
import { GlobalPlayerProvider } from "@/lib/player/globalPlayer";
import { OfflineMediaProvider } from "@/lib/offlineMedia/OfflineMediaProvider";
import { OfflineReadingProvider } from "@/lib/offlineReading/OfflineReadingProvider";
import { ImportsProvider } from "@/lib/imports/ImportsProvider";
import { LecternProvider } from "@/lib/lectern/LecternProvider";
import { CompletionUndoFeedbackOwner } from "@/lib/lectern/useCompletionUndo";
import { WalknoteSessionProvider } from "@/lib/walknotes/walknoteSession";
import { ReaderProvider } from "@/lib/reader/ReaderContext";
import { ReaderProfileSaveFeedback } from "@/lib/reader/ReaderProfileSaveFeedback";
import { KeybindingsProvider } from "@/lib/keybindingsProvider";
import { RenderEnvironmentProvider } from "@/lib/renderEnvironment/provider";
import ActivityCaptureLifecycle from "@/lib/consumption/ActivityCaptureLifecycle";
import { WorkspaceStoreProvider } from "@/lib/workspace/store";
import WorkspaceSessionSync from "@/lib/workspace/WorkspaceSessionSync";
import { HostedReaderProgressProvider } from "@/lib/reader/HostedReaderProgressProvider";
import { READER_CAPACITY } from "@/lib/reader/readerCapacity";
import { ArtworkProvider, ArtworkFailureNotice } from "@/lib/media/ArtworkProvider";
import { ARTWORK_CAPACITY } from "@/lib/media/artworkCapacity";
import WorkspaceRecovery from "@/lib/workspace/WorkspaceRecovery";
import { PaneReturnMementoProvider } from "@/lib/workspace/paneReturnMemento";
import { MobileChromeProvider } from "@/lib/workspace/mobileChrome";
import { MobileViewportProvider } from "@/lib/mobileViewport/MobileViewportProvider";
import { useWorkspacePrimaryMetrics } from "@/lib/workspace/useWorkspacePrimaryMetrics";
import type { WorkspaceState } from "@/lib/workspace/schema";
import {
  ResourceCacheProvider,
  type DehydratedResources,
} from "@/lib/api/resourceCache";
import type { ReaderProfile } from "@/lib/reader/types";
import type { RenderEnvironment } from "@/lib/renderEnvironment/types";
import { LibraryPlacementControllerProvider } from "@/lib/libraries/placementController";
import { ShareControllerProvider } from "@/lib/sharing/controller";
import { ResourceActionRuntimeProvider } from "@/lib/actions/resourceActionRuntime";
import {
  ResourceActionOverlays,
  ResourceOverlaysProvider,
} from "@/lib/resources/resourceOverlaysController";
import styles from "./layout.module.css";
import {
  AuthenticatedAccountProvider,
  type AuthenticatedAccount,
} from "@/lib/account/authenticatedAccount";

export default function AuthenticatedShell({
  account,
  readerProfile,
  renderEnvironment,
  initialState,
  entryHref,
  resources,
}: {
  account: AuthenticatedAccount;
  readerProfile: ReaderProfile;
  renderEnvironment: RenderEnvironment;
  initialState: WorkspaceState;
  entryHref: string | null;
  resources: DehydratedResources;
}) {
  return (
    <AuthenticatedAccountProvider account={account}>
      <RenderEnvironmentProvider value={renderEnvironment}>
        <UnauthenticatedApiBoundary>
          <ActivityCaptureLifecycle accountId={account.accountId} />
          <LocalVaultAutoSync />
          <WebVitalsReporter />
          <ResourceCacheProvider key={account.accountId} value={resources} publicationLimits={READER_CAPACITY.cache}>
            <ArtworkProvider key={account.accountId} limits={ARTWORK_CAPACITY}>
            <KeybindingsProvider>
              <ReaderProvider initialProfile={readerProfile}>
                <ReaderProfileSaveFeedback />
                <ArtworkFailureNotice />
                <AuthenticatedWorkspace
                  key={account.accountId}
                  accountId={account.accountId}
                  initialState={initialState}
                  entryHref={entryHref}
                />
              </ReaderProvider>
            </KeybindingsProvider>
            </ArtworkProvider>
          </ResourceCacheProvider>
        </UnauthenticatedApiBoundary>
      </RenderEnvironmentProvider>
    </AuthenticatedAccountProvider>
  );
}

function AuthenticatedWorkspace({
  accountId,
  initialState,
  entryHref,
}: {
  accountId: string;
  initialState: WorkspaceState;
  entryHref: string | null;
}) {
  const { workspacePrimaryMetrics, probe } = useWorkspacePrimaryMetrics();

  // Interactivity fact for the workspace root: absent in server HTML, stamped
  // by the first client commit. Input dispatched before hydration lands on
  // dead SSR markup (React re-renders over it), so anything driving the UI
  // programmatically must be able to await this.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    setHydrated(true);
  }, []);

  return (
    <>
      {probe}
      <WorkspaceRecovery accountId={accountId} initialState={initialState} entryHref={entryHref} metrics={workspacePrimaryMetrics}>
        {(restoredState, recovered) => <PaneReturnMementoProvider>
        <WorkspaceStoreProvider
          workspacePrimaryMetrics={workspacePrimaryMetrics}
          initialState={restoredState}
        >
          <HostedReaderProgressProvider accountId={accountId}>
          <WorkspaceSessionSync accountId={accountId} recovered={recovered} />
          <MobileViewportProvider>
            <MobileChromeProvider>
              {/* One Lectern owner wraps the workspace leaves and player
                  runtime: LecternProvider -> GlobalPlayerProvider -> workspace
                  + the shell-owned player surfaces. */}
              <LecternProvider>
                <CompletionUndoFeedbackOwner />
                <LibraryPlacementControllerProvider>
                  <ShareControllerProvider>
                    <OfflineReadingProvider accountId={accountId}>
                    <OfflineMediaProvider accountId={accountId}>
                      {/* One Downloads surface above both offline
                          capabilities: it renders whenever audio or reading is
                          Ready, so a device that only connected one of them
                          still has somewhere to see, retry and remove its
                          downloads. */}
                      <DownloadsSurface />
                      {/* The resource-action runtime reads Lectern, offline
                          media, share, library-placement, resource overlays,
                          workspace, and feedback from these ancestors and owns
                          the shared snapshot cache / busy state / dispatch for
                          every resource dropdown in the workspace subtree
                          below. ResourceOverlaysProvider is an ancestor so the
                          runtime can call its openers; ResourceActionOverlays
                          renders the single overlay copy deep inside the player
                          runtime and a synthetic pane-visit scope. */}
                      <ResourceOverlaysProvider>
                        <GlobalPlayerProvider accountId={accountId}>
                          <ResourceActionRuntimeProvider>
                            <ImportsProvider>
                              <Nexus />
                              <ResourceActionOverlays />
                              <div
                                className={styles.layout}
                                data-hydrated={hydrated || undefined}
                              >
                                <AppNav />
                                <main className={styles.main}>
                                  <WalknoteSessionProvider>
                                    <WorkspaceHost />
                                    <LecternMutationNotice />
                                    <GlobalPlayerSurfaces />
                                  </WalknoteSessionProvider>
                                </main>
                              </div>
                            </ImportsProvider>
                          </ResourceActionRuntimeProvider>
                        </GlobalPlayerProvider>
                      </ResourceOverlaysProvider>
                    </OfflineMediaProvider>
                    </OfflineReadingProvider>
                  </ShareControllerProvider>
                </LibraryPlacementControllerProvider>
              </LecternProvider>
            </MobileChromeProvider>
          </MobileViewportProvider>
          </HostedReaderProgressProvider>
        </WorkspaceStoreProvider>
      </PaneReturnMementoProvider>}
      </WorkspaceRecovery>
    </>
  );
}
