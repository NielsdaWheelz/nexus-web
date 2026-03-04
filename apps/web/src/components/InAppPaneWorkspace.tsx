"use client";

import Pane from "@/components/Pane";
import PaneRouteRenderer from "@/components/PaneRouteRenderer";
import { usePaneGraphStore } from "@/lib/panes/paneGraphStore";
import styles from "./InAppPaneWorkspace.module.css";

interface InAppPaneWorkspaceProps {
  children: React.ReactNode;
}

export default function InAppPaneWorkspace({ children }: InAppPaneWorkspaceProps) {
  const { panes, closePane, navigatePane, replacePane, openPane } = usePaneGraphStore();

  return (
    <div className={styles.workspace}>
      <div className={styles.primaryPane}>{children}</div>
      {panes.map((pane) => (
        <Pane
          key={pane.id}
          title={pane.title}
          defaultWidth={560}
          minWidth={360}
          maxWidth={1200}
          onClose={() => closePane(pane.id)}
          contentClassName={styles.paneContent}
        >
          <PaneRouteRenderer
            paneId={pane.id}
            href={pane.href}
            onNavigatePane={navigatePane}
            onReplacePane={replacePane}
            onOpenInNewPane={openPane}
          />
        </Pane>
      ))}
    </div>
  );
}
