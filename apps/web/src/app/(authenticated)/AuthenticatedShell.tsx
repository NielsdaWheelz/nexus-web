"use client";

import { Suspense } from "react";
import AppNav from "@/components/appnav/AppNav";
import CommandPalette from "@/components/CommandPalette";
import AddContentTray from "@/components/AddContentTray";
import WorkspaceHost from "@/components/workspace/WorkspaceHost";
import GlobalPlayerFooter from "@/components/GlobalPlayerFooter";
import LocalVaultAutoSync from "./LocalVaultAutoSync";
import SessionRefresher from "@/lib/auth/SessionRefresher";
import { GlobalPlayerProvider } from "@/lib/player/globalPlayer";
import { ReaderProvider } from "@/lib/reader/ReaderContext";
import { WorkspaceStoreProvider } from "@/lib/workspace/store";
import { MobileChromeProvider } from "@/lib/workspace/mobileChrome";
import { useWorkspacePrimaryMetrics } from "@/lib/workspace/useWorkspacePrimaryMetrics";
import styles from "./layout.module.css";

export default function AuthenticatedShell() {
  return (
    <>
      <SessionRefresher />
      <LocalVaultAutoSync />
      <ReaderProvider>
        <AuthenticatedWorkspace />
      </ReaderProvider>
    </>
  );
}

function AuthenticatedWorkspace() {
  const { workspacePrimaryMetrics, probe } = useWorkspacePrimaryMetrics();

  return (
    <Suspense fallback={null}>
      {probe}
      {workspacePrimaryMetrics ? (
        <WorkspaceStoreProvider workspacePrimaryMetrics={workspacePrimaryMetrics}>
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
      ) : null}
    </Suspense>
  );
}
