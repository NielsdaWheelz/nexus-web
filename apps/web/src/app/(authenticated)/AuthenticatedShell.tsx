"use client";

import { useEffect, useState } from "react";
import AppNav from "@/components/appnav/AppNav";
import Nexus from "@/components/nexus/Nexus";
import WorkspaceHost from "@/components/workspace/WorkspaceHost";
import GlobalPlayerSurfaces from "@/components/player/GlobalPlayerSurfaces";
import LecternMutationNotice from "@/components/LecternMutationNotice";
import { WebVitalsReporter } from "@/components/workspace/WebVitalsReporter";
import LocalVaultAutoSync from "./LocalVaultAutoSync";
import UnauthenticatedApiBoundary from "@/lib/auth/UnauthenticatedApiBoundary";
import { GlobalPlayerProvider } from "@/lib/player/globalPlayer";
import { OfflineMediaProvider } from "@/lib/offlineMedia/OfflineMediaProvider";
import { LecternProvider } from "@/lib/lectern/LecternProvider";
import { CompletionUndoFeedbackOwner } from "@/lib/lectern/useCompletionUndo";
import { WalknoteSessionProvider } from "@/lib/walknotes/walknoteSession";
import { ReaderProvider } from "@/lib/reader/ReaderContext";
import { ReaderProfileSaveFeedback } from "@/lib/reader/ReaderProfileSaveFeedback";
import { KeybindingsProvider } from "@/lib/keybindingsProvider";
import { RenderEnvironmentProvider } from "@/lib/renderEnvironment/provider";
import ActivityCaptureLifecycle from "@/lib/consumption/ActivityCaptureLifecycle";
import { WorkspaceStoreProvider } from "@/lib/workspace/store";
import { PaneReturnMementoProvider } from "@/lib/workspace/paneReturnMemento";
import { MobileChromeProvider } from "@/lib/workspace/mobileChrome";
import { MobileViewportProvider } from "@/lib/mobileViewport/MobileViewportProvider";
import { useWorkspacePrimaryMetrics } from "@/lib/workspace/useWorkspacePrimaryMetrics";
import { getWorkspacePrimaryPanes, type WorkspaceState } from "@/lib/workspace/schema";
import { resolvePaneRouteModel, type PaneRouteId } from "@/lib/panes/paneRouteModel";
import { preloadPane } from "@/lib/panes/paneRenderRegistry";
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
  resources,
}: {
  account: AuthenticatedAccount;
  readerProfile: ReaderProfile;
  renderEnvironment: RenderEnvironment;
  initialState: WorkspaceState;
  resources: DehydratedResources;
}) {
  return (
    <AuthenticatedAccountProvider account={account}>
      <RenderEnvironmentProvider value={renderEnvironment}>
        <UnauthenticatedApiBoundary>
          <ActivityCaptureLifecycle />
          <LocalVaultAutoSync />
          <WebVitalsReporter />
          <ResourceCacheProvider value={resources}>
            <KeybindingsProvider>
              <ReaderProvider initialProfile={readerProfile}>
                <ReaderProfileSaveFeedback />
                <AuthenticatedWorkspace
                  accountId={account.accountId}
                  initialState={initialState}
                />
              </ReaderProvider>
            </KeybindingsProvider>
          </ResourceCacheProvider>
        </UnauthenticatedApiBoundary>
      </RenderEnvironmentProvider>
    </AuthenticatedAccountProvider>
  );
}

function AuthenticatedWorkspace({
  accountId,
  initialState,
}: {
  accountId: string;
  initialState: WorkspaceState;
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

  // Warm every restored visible pane's chunk as soon as the shell mounts so the downloads
  // overlap hydration instead of waiting for each WorkspaceHost Suspense to commit (D-7).
  // resolvePaneRouteModel is the same resolver the store uses, so this targets exactly the
  // panes about to render.
  useEffect(() => {
    const ids = new Set<PaneRouteId>();
    for (const pane of getWorkspacePrimaryPanes(initialState)) {
      if (pane.visibility !== "visible") {
        continue;
      }
      const { id } = resolvePaneRouteModel(pane.currentVisit.href);
      if (id !== "unsupported") {
        ids.add(id);
      }
    }
    for (const id of ids) {
      preloadPane(id);
    }
  }, [initialState]);

  return (
    <>
      {probe}
      <PaneReturnMementoProvider>
        <WorkspaceStoreProvider
          workspacePrimaryMetrics={workspacePrimaryMetrics}
          initialState={initialState}
        >
          <MobileViewportProvider>
            <MobileChromeProvider>
              {/* One Lectern owner wraps the workspace leaves and player
                  runtime: LecternProvider -> GlobalPlayerProvider -> workspace
                  + the shell-owned player surfaces. */}
              <LecternProvider>
                <CompletionUndoFeedbackOwner />
                <LibraryPlacementControllerProvider>
                  <ShareControllerProvider>
                    <OfflineMediaProvider accountId={accountId}>
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
                          </ResourceActionRuntimeProvider>
                        </GlobalPlayerProvider>
                      </ResourceOverlaysProvider>
                    </OfflineMediaProvider>
                  </ShareControllerProvider>
                </LibraryPlacementControllerProvider>
              </LecternProvider>
            </MobileChromeProvider>
          </MobileViewportProvider>
        </WorkspaceStoreProvider>
      </PaneReturnMementoProvider>
    </>
  );
}
