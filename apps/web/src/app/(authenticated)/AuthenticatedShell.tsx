"use client";

import { Suspense, useState, type Dispatch, type SetStateAction } from "react";
import Navbar from "@/components/Navbar";
import CommandPalette from "@/components/CommandPalette";
import AddContentTray from "@/components/AddContentTray";
import WorkspaceHost from "@/components/workspace/WorkspaceHost";
import GlobalPlayerFooter from "@/components/GlobalPlayerFooter";
import LocalVaultAutoSync from "./LocalVaultAutoSync";
import SessionRefresher from "@/lib/auth/SessionRefresher";
import { GlobalPlayerProvider } from "@/lib/player/globalPlayer";
import { ReaderProvider } from "@/lib/reader/ReaderContext";
import { WorkspaceStoreProvider } from "@/lib/workspace/store";
import { useWorkspacePrimaryMetrics } from "@/lib/workspace/useWorkspacePrimaryMetrics";
import styles from "./layout.module.css";

export default function AuthenticatedShell() {
  const [navbarCollapsed, setNavbarCollapsed] = useState(false);

  return (
    <>
      <SessionRefresher />
      <LocalVaultAutoSync />
      <ReaderProvider>
        <AuthenticatedWorkspace
          navbarCollapsed={navbarCollapsed}
          setNavbarCollapsed={setNavbarCollapsed}
        />
      </ReaderProvider>
    </>
  );
}

function AuthenticatedWorkspace({
  navbarCollapsed,
  setNavbarCollapsed,
}: {
  navbarCollapsed: boolean;
  setNavbarCollapsed: Dispatch<SetStateAction<boolean>>;
}) {
  const { workspacePrimaryMetrics, probe } = useWorkspacePrimaryMetrics();

  return (
    <Suspense fallback={null}>
      {probe}
      {workspacePrimaryMetrics ? (
        <WorkspaceStoreProvider workspacePrimaryMetrics={workspacePrimaryMetrics}>
          <CommandPalette />
          <AddContentTray />
          <div
            className={`${styles.layout} ${navbarCollapsed ? styles.navCollapsed : ""}`}
          >
            <Navbar onToggle={setNavbarCollapsed} />
            <main className={styles.main}>
              <GlobalPlayerProvider>
                <WorkspaceHost />
                <GlobalPlayerFooter />
              </GlobalPlayerProvider>
            </main>
          </div>
        </WorkspaceStoreProvider>
      ) : null}
    </Suspense>
  );
}
