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
import { GlobalPlayerProvider } from "@/lib/player/globalPlayer";
import { ReaderProvider } from "@/lib/reader/ReaderContext";
import { WorkspaceStoreProvider } from "@/lib/workspace/store";
import { MobileChromeProvider } from "@/lib/workspace/mobileChrome";
import { useWorkspacePrimaryMetrics } from "@/lib/workspace/useWorkspacePrimaryMetrics";
import { resolvePaneRouteModel } from "@/lib/panes/paneRouteModel";
import { preloadPane } from "@/lib/panes/paneRenderRegistry";
import {
  BootstrapHydrationProvider,
  type DehydratedResources,
} from "@/lib/api/hydrationCache";
import type { ReaderProfile } from "@/lib/reader/types";
import styles from "./layout.module.css";

export default function AuthenticatedShell({
  initialHref,
  readerProfile,
  resources,
}: {
  initialHref: string;
  readerProfile: ReaderProfile;
  resources: DehydratedResources;
}) {
  return (
    <>
      <SessionRefresher />
      <LocalVaultAutoSync />
      <WebVitalsReporter />
      <BootstrapHydrationProvider value={resources}>
        <ReaderProvider initialProfile={readerProfile}>
          <AuthenticatedWorkspace initialHref={initialHref} />
        </ReaderProvider>
      </BootstrapHydrationProvider>
    </>
  );
}

function AuthenticatedWorkspace({ initialHref }: { initialHref: string }) {
  const { workspacePrimaryMetrics, probe } = useWorkspacePrimaryMetrics();

  // Warm the initial pane's chunk as soon as the shell mounts so its download
  // overlaps hydration instead of waiting for WorkspaceHost's Suspense to commit
  // (D-7). resolvePaneRouteModel is the same resolver the store uses, so this
  // targets exactly the pane that is about to render.
  useEffect(() => {
    const { id } = resolvePaneRouteModel(initialHref);
    if (id !== "unsupported") {
      preloadPane(id);
    }
  }, [initialHref]);

  return (
    <>
      {probe}
      <WorkspaceStoreProvider
        workspacePrimaryMetrics={workspacePrimaryMetrics}
        initialHref={initialHref}
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
