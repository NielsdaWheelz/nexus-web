"use client";

import type { MouseEvent, ReactNode } from "react";
import { usePaneRuntime } from "@/lib/panes/paneRuntime";
import { activateTargetAnchor } from "@/lib/panes/targetLinkActivation";
import styles from "./WorkspaceHost.module.css";

/** Every in-app link clicked inside a pane goes through the workspace. */
export default function PaneRouteBoundary({ children }: { children: ReactNode }) {
  const runtime = usePaneRuntime();
  const onClickCapture = (event: MouseEvent<HTMLDivElement>) => {
    const anchor =
      event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (anchor instanceof HTMLAnchorElement) {
      activateTargetAnchor({ event, runtime, anchor });
    }
  };
  return (
    <div className={styles.paneRouteBoundaryShell} onClickCapture={onClickCapture}>
      {children}
    </div>
  );
}
