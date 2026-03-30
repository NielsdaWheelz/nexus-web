"use client";

import { Suspense, useState } from "react";
import { usePathname } from "next/navigation";
import Navbar from "@/components/Navbar";
import AuthenticatedWorkspaceHost from "@/components/AuthenticatedWorkspaceHost";
import SettingsWorkspaceHost from "@/components/workspace/SettingsWorkspaceHost";
import { ToastProvider } from "@/components/Toast";
import GlobalPlayerFooter from "@/components/GlobalPlayerFooter";
import { GlobalPlayerProvider } from "@/lib/player/globalPlayer";
import { PaneRootNavigationProvider } from "@/lib/panes/paneRuntime";
import { ReaderProvider } from "@/lib/reader";
import { WorkspaceStoreProvider } from "@/lib/workspace/store";
import styles from "./layout.module.css";

export default function AuthenticatedLayout() {
  const [navbarCollapsed, setNavbarCollapsed] = useState(false);
  const pathname = usePathname() ?? "";
  const settingsRouteActive = pathname === "/settings" || pathname.startsWith("/settings/");

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
                  <GlobalPlayerProvider>
                    {settingsRouteActive ? (
                      <SettingsWorkspaceHost />
                    ) : (
                      <AuthenticatedWorkspaceHost />
                    )}
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
