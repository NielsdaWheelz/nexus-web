"use client";

import {
  useCallback,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { activateTargetAnchor } from "@/lib/panes/targetLinkActivation";
import {
  usePaneRuntime,
  useRecordPaneNavigationModality,
} from "@/lib/panes/paneRuntime";
import { usePaneWarmOnIntent } from "@/lib/panes/paneWarm";
import styles from "./WorkspaceHost.module.css";
import { pointerModality } from "@/lib/ui/pointerModality";

export default function PaneRouteBoundary({ children }: { children: ReactNode }) {
  const paneRuntime = usePaneRuntime();
  const activateTarget = paneRuntime?.activateTarget ?? null;
  const handleIntentCapture = usePaneWarmOnIntent();
  const recordNavigationModality = useRecordPaneNavigationModality();
  const isActivationTarget = useCallback((target: EventTarget | null) => {
    if (!(target instanceof Element)) {
      return false;
    }
    return Boolean(
      target.closest(
        'a[href], button, input, select, textarea, [role="button"], [role="link"], [role="menuitem"], [tabindex]',
      ),
    );
  }, []);

  const handleClickCapture = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }
      if (isActivationTarget(target)) {
        recordNavigationModality(pointerModality(event));
      }
      const anchor = target.closest("a[href]");
      if (anchor instanceof HTMLAnchorElement) {
        activateTargetAnchor({
          event,
          runtime: activateTarget ? { activateTarget } : null,
          anchor,
        });
      }
    },
    [activateTarget, isActivationTarget, recordNavigationModality],
  );
  const handlePointerDownCapture = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (isActivationTarget(event.target)) {
        recordNavigationModality("Pointer");
      }
    },
    [isActivationTarget, recordNavigationModality],
  );
  const handleKeyDownCapture = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (
        (event.key === "Enter" || event.key === " ") &&
        isActivationTarget(event.target)
      ) {
        recordNavigationModality("Keyboard");
      }
    },
    [isActivationTarget, recordNavigationModality],
  );

  return (
    <div
      className={styles.paneRouteBoundaryShell}
      onClickCapture={handleClickCapture}
      onPointerDownCapture={handlePointerDownCapture}
      onKeyDownCapture={handleKeyDownCapture}
      onMouseOverCapture={handleIntentCapture}
      onFocusCapture={handleIntentCapture}
    >
      {children}
    </div>
  );
}
