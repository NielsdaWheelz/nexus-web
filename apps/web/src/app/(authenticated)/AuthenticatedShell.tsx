"use client";

import { useEffect } from "react";
import AppNav from "@/components/appnav/AppNav";
import CommandPalette from "@/components/palette/CommandPalette";
import AddContentTray from "@/components/AddContentTray";
import WorkspaceHost from "@/components/workspace/WorkspaceHost";
import GlobalPlayerFooter from "@/components/GlobalPlayerFooter";
import { WebVitalsReporter } from "@/components/workspace/WebVitalsReporter";
import LocalVaultAutoSync from "./LocalVaultAutoSync";
import SessionRefresher from "@/lib/auth/SessionRefresher";
import UnauthenticatedApiBoundary from "@/lib/auth/UnauthenticatedApiBoundary";
import { GlobalPlayerProvider } from "@/lib/player/globalPlayer";
import { ReaderProvider } from "@/lib/reader/ReaderContext";
import { KeybindingsProvider } from "@/lib/keybindingsProvider";
import { RenderEnvironmentProvider } from "@/lib/renderEnvironment/provider";
import { WorkspaceStoreProvider } from "@/lib/workspace/store";
import { MobileChromeProvider } from "@/lib/workspace/mobileChrome";
import { useWorkspacePrimaryMetrics } from "@/lib/workspace/useWorkspacePrimaryMetrics";
import { getWorkspacePrimaryPanes, type WorkspaceState } from "@/lib/workspace/schema";
import { resolvePaneRouteModel, type PaneRouteId } from "@/lib/panes/paneRouteModel";
import { preloadPane } from "@/lib/panes/paneRenderRegistry";
import {
  BootstrapHydrationProvider,
  type DehydratedResources,
} from "@/lib/api/hydrationCache";
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
        <BootstrapHydrationProvider value={resources}>
          <KeybindingsProvider>
            <ReaderProvider initialProfile={readerProfile}>
              <AuthenticatedWorkspace initialState={initialState} />
            </ReaderProvider>
          </KeybindingsProvider>
        </BootstrapHydrationProvider>
      </UnauthenticatedApiBoundary>
    </RenderEnvironmentProvider>
  );
}

function AuthenticatedWorkspace({ initialState }: { initialState: WorkspaceState }) {
  const { workspacePrimaryMetrics, probe } = useWorkspacePrimaryMetrics();

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
      const { id } = resolvePaneRouteModel(pane.href);
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
      <WorkspaceStoreProvider
        workspacePrimaryMetrics={workspacePrimaryMetrics}
        initialState={initialState}
      >
        <MobileChromeProvider>
          <CommandPalette />
          <AddContentTray />
          <div className={styles.layout}>
            <AppNav />
            <main className={styles.main}>
              <GlobalPlayerProvider>
                <WorkspaceHost />
                <GlobalPlayerFooter />
              </GlobalPlayerProvider>
            </main>
          </div>
        </MobileChromeProvider>
      </WorkspaceStoreProvider>
    </>
  );
}
