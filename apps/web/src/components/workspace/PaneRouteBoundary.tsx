"use client";

import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import { usePaneRuntime } from "@/lib/panes/paneRuntime";
import { activateTargetAnchor } from "@/lib/panes/targetLinkActivation";
import styles from "./WorkspaceHost.module.css";

/** Every in-app link clicked inside a pane goes through the workspace. */
export default function PaneRouteBoundary({ children }: { children: ReactNode }) {
  const runtime = usePaneRuntime();
  const activate = (event: MouseEvent<HTMLDivElement> | KeyboardEvent<HTMLDivElement>) => {
    const anchor =
      event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (anchor instanceof HTMLAnchorElement) {
      activateTargetAnchor({ event, runtime, anchor });
    }
  };
  return (
    <div className={styles.paneRouteBoundaryShell} onClickCapture={activate} onKeyDownCapture={activate}>
      {children}
    </div>
  );
}
