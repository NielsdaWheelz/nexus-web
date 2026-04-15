"use client";

import { Suspense, useState } from "react";
import Navbar from "@/components/Navbar";
import CommandPalette from "@/components/CommandPalette";
import IngestionTray from "@/components/IngestionTray";
import WorkspaceHost from "@/components/workspace/WorkspaceHost";
import { ToastProvider } from "@/components/Toast";
import GlobalPlayerFooter from "@/components/GlobalPlayerFooter";
import { GlobalPlayerProvider } from "@/lib/player/globalPlayer";
import { PaneRootNavigationProvider } from "@/lib/panes/paneRuntime";
import { ReaderProvider } from "@/lib/reader";
import { WorkspaceStoreProvider } from "@/lib/workspace/store";
import styles from "./layout.module.css";

export default function AuthenticatedLayout() {
  const [navbarCollapsed, setNavbarCollapsed] = useState(false);

  return (
    <ToastProvider>
      <ReaderProvider>
        <Suspense fallback={null}>
          <PaneRootNavigationProvider>
            <WorkspaceStoreProvider>
              <CommandPalette />
              <IngestionTray />
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
          </PaneRootNavigationProvider>
        </Suspense>
      </ReaderProvider>
    </ToastProvider>
  );
}
