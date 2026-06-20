"use client";

import {
  useCallback,
  type FocusEvent as ReactFocusEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { handlePaneInternalAnchorClick } from "@/lib/panes/paneLinkNavigation";
import { usePaneRouter, usePaneRuntime } from "@/lib/panes/paneRuntime";
import { usePaneWarm } from "@/lib/panes/paneWarm";
import styles from "./WorkspaceHost.module.css";

export default function PaneRouteBoundary({ children }: { children: ReactNode }) {
  const router = usePaneRouter();
  const paneRuntime = usePaneRuntime();
  const openInNewPane = paneRuntime?.openInNewPane;
  const warmPane = usePaneWarm();

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

  // Prefetch-on-intent: warm the target pane's chunk + data the moment the pointer or
  // keyboard focus reaches any in-pane anchor, so the click/Enter opens warm. Mirrors
  // the click delegate (capture-phase + closest("a[href]")), covering every in-pane
  // link — ResourceRow, prose, media cards, anchor-form citations — at once.
  const handleIntentCapture = useCallback(
    (event: ReactMouseEvent<HTMLDivElement> | ReactFocusEvent<HTMLDivElement>) => {
      if (!(event.target instanceof Element)) {
        return;
      }
      const anchor = event.target.closest("a[href]");
      if (!(anchor instanceof HTMLAnchorElement)) {
        return;
      }
      const href = anchor.getAttribute("href");
      if (href && !href.startsWith("#")) {
        warmPane(href);
      }
    },
    [warmPane],
  );

  return (
    <div
      className={styles.paneRouteBoundaryShell}
      onClickCapture={handleClickCapture}
      onMouseOverCapture={handleIntentCapture}
      onFocusCapture={handleIntentCapture}
    >
      {children}
    </div>
  );
}
