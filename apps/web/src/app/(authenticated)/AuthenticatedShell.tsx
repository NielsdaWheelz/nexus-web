"use client";

import { useEffect, useState } from "react";
import AppNav from "@/components/appnav/AppNav";
import Launcher from "@/components/launcher/Launcher";
import WorkspaceHost from "@/components/workspace/WorkspaceHost";
import GlobalPlayerFooter from "@/components/GlobalPlayerFooter";
import LecternMutationNotice from "@/components/LecternMutationNotice";
import { WebVitalsReporter } from "@/components/workspace/WebVitalsReporter";
import LocalVaultAutoSync from "./LocalVaultAutoSync";
import SessionRefresher from "@/lib/auth/SessionRefresher";
import UnauthenticatedApiBoundary from "@/lib/auth/UnauthenticatedApiBoundary";
import { GlobalPlayerProvider } from "@/lib/player/globalPlayer";
import { LecternProvider } from "@/lib/lectern/LecternProvider";
import { WalknoteSessionProvider } from "@/lib/walknotes/walknoteSession";
import { ReaderProvider } from "@/lib/reader/ReaderContext";
import { ReaderProfileSaveFeedback } from "@/lib/reader/ReaderProfileSaveFeedback";
import { KeybindingsProvider } from "@/lib/keybindingsProvider";
import { RenderEnvironmentProvider } from "@/lib/renderEnvironment/provider";
import { WorkspaceStoreProvider } from "@/lib/workspace/store";
import { PaneReturnMementoProvider } from "@/lib/workspace/paneReturnMemento";
import { MobileChromeProvider } from "@/lib/workspace/mobileChrome";
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
import styles from "./layout.module.css";

export default function AuthenticatedShell({
  readerProfile,
  renderEnvironment,
  initialState,
  resources,
}: {
  readerProfile: ReaderProfile;
  renderEnvironment: RenderEnvironment;
  initialState: WorkspaceState;
  resources: DehydratedResources;
}) {
  return (
    <RenderEnvironmentProvider value={renderEnvironment}>
      <UnauthenticatedApiBoundary>
        <SessionRefresher />
        <LocalVaultAutoSync />
        <WebVitalsReporter />
        <ResourceCacheProvider value={resources}>
          <KeybindingsProvider>
            <ReaderProvider initialProfile={readerProfile}>
              <ReaderProfileSaveFeedback />
              <AuthenticatedWorkspace initialState={initialState} />
            </ReaderProvider>
          </KeybindingsProvider>
        </ResourceCacheProvider>
      </UnauthenticatedApiBoundary>
    </RenderEnvironmentProvider>
  );
}

function AuthenticatedWorkspace({ initialState }: { initialState: WorkspaceState }) {
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
          <MobileChromeProvider>
            {/* One Lectern owner wraps the Launcher/workspace leaves and the player
                session (spec §3 architecture): LecternProvider -> leaves ->
                GlobalPlayerProvider -> WorkspaceHost + GlobalPlayerFooter. */}
            <LecternProvider>
              <Launcher />
              <div className={styles.layout} data-hydrated={hydrated || undefined}>
                <AppNav />
                <main className={styles.main}>
                  <GlobalPlayerProvider>
                    <WalknoteSessionProvider>
                      <WorkspaceHost />
                      <LecternMutationNotice />
                      <GlobalPlayerFooter />
                    </WalknoteSessionProvider>
                  </GlobalPlayerProvider>
                </main>
              </div>
            </LecternProvider>
          </MobileChromeProvider>
        </WorkspaceStoreProvider>
      </PaneReturnMementoProvider>
    </>
  );
}
