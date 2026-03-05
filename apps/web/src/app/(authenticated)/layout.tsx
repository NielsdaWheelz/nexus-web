"use client";

import { Suspense, useState } from "react";
import Navbar from "@/components/Navbar";
import AuthenticatedWorkspaceHost from "@/components/AuthenticatedWorkspaceHost";
import { ToastProvider } from "@/components/Toast";
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
              <div
                className={`${styles.layout} ${navbarCollapsed ? styles.navCollapsed : ""}`}
              >
                <Navbar onToggle={setNavbarCollapsed} />
                <main className={styles.main}>
                  <AuthenticatedWorkspaceHost />
                </main>
              </div>
            </WorkspaceStoreProvider>
          </PaneRootNavigationProvider>
        </Suspense>
      </ReaderProvider>
    </ToastProvider>
  );
}
