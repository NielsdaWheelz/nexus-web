"use client";

import {
  useCallback,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { handlePaneInternalAnchorClick } from "@/lib/panes/paneLinkNavigation";
import { usePaneRouter, usePaneRuntime } from "@/lib/panes/paneRuntime";
import styles from "./WorkspaceHost.module.css";

export default function PaneRouteBoundary({ children }: { children: ReactNode }) {
  const router = usePaneRouter();
  const paneRuntime = usePaneRuntime();
  const openInNewPane = paneRuntime?.openInNewPane;

  const handleClickCapture = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }
      const anchor = target.closest("a[href]");
      if (anchor instanceof HTMLAnchorElement) {
        handlePaneInternalAnchorClick(
          event,
          openInNewPane ? { router, openInNewPane } : null,
          anchor,
        );
      }
    },
    [openInNewPane, router],
  );

  return (
    <div className={styles.paneRouteBoundaryShell} onClickCapture={handleClickCapture}>
      {children}
    </div>
  );
}
