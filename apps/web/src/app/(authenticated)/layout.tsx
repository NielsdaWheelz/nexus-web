"use client";

import { Suspense, useState } from "react";
import Navbar from "@/components/Navbar";
import InAppPaneWorkspace from "@/components/InAppPaneWorkspace";
import { ToastProvider } from "@/components/Toast";
import { PaneGraphProvider } from "@/lib/panes/paneGraphStore";
import { PaneRootNavigationProvider } from "@/lib/panes/paneRuntime";
import { ReaderProvider } from "@/lib/reader";
import styles from "./layout.module.css";

export default function AuthenticatedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [navbarCollapsed, setNavbarCollapsed] = useState(false);

  return (
    <ToastProvider>
      <ReaderProvider>
        <Suspense fallback={null}>
          <PaneRootNavigationProvider>
            <PaneGraphProvider>
              <div
                className={`${styles.layout} ${navbarCollapsed ? styles.navCollapsed : ""}`}
              >
                <Navbar onToggle={setNavbarCollapsed} />
                <main className={styles.main}>
                  <InAppPaneWorkspace>{children}</InAppPaneWorkspace>
                </main>
              </div>
            </PaneGraphProvider>
          </PaneRootNavigationProvider>
        </Suspense>
      </ReaderProvider>
    </ToastProvider>
  );
}
