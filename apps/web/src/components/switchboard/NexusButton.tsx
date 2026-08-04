"use client";

import { useCallback, useLayoutEffect, useRef } from "react";
import { flushSync } from "react-dom";
import AsterismMark from "@/components/AsterismMark";
import { useMobileViewport } from "@/lib/mobileViewport/MobileViewportProvider";
import {
  useMobileChrome,
  useMobileChromeSurface,
} from "@/lib/workspace/mobileChrome";
import {
  beginNexusPerformance,
  NEXUS_OPEN_PERFORMANCE,
} from "@/lib/nexus/performance";
import styles from "./switchboard.module.css";

export default function NexusButton({
  paneCount,
  switchboardOpen,
  onOpen,
  onButtonNodeChange,
}: {
  paneCount: number;
  switchboardOpen: boolean;
  onOpen: (opener: HTMLButtonElement) => void;
  onButtonNodeChange?: (node: HTMLButtonElement | null) => void;
}) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const setButtonRef = useCallback(
    (node: HTMLButtonElement | null) => {
      buttonRef.current = node;
      onButtonNodeChange?.(node);
    },
    [onButtonNodeChange],
  );
  const mobileViewport = useMobileViewport();
  const { motionPhase } = useMobileChrome();
  useMobileChromeSurface(buttonRef, "NexusControl", true);
  useLayoutEffect(() => {
    const element = wrapperRef.current;
    if (switchboardOpen || !element) return;
    return mobileViewport.registerBottomSurface("Nexus", element);
  }, [mobileViewport, switchboardOpen]);
  const label =
    paneCount === 1 ? "Open Nexus, 1 tab" : `Open Nexus, ${paneCount} tabs`;
  const motionInert =
    motionPhase.kind !== "Visible" && motionPhase.kind !== "Pinned";
  return (
    <div
      ref={wrapperRef}
      className={styles.nexusWrapper}
      data-testid="nexus-wrapper"
    >
      <button
        ref={setButtonRef}
        data-nexus-return-focus
        type="button"
        className={styles.nexusButton}
        aria-label={label}
        aria-haspopup="dialog"
        aria-hidden={motionInert || switchboardOpen || undefined}
        inert={motionInert || switchboardOpen || undefined}
        data-switchboard-open={switchboardOpen || undefined}
        data-mobile-chrome-phase={motionPhase.kind}
        onClick={(event) => {
          beginNexusPerformance(NEXUS_OPEN_PERFORMANCE);
          flushSync(() => onOpen(event.currentTarget));
        }}
      >
        <span className={styles.nexusFace}>
          <AsterismMark className={styles.nexusMark} size={20} />
        </span>
        <span className={styles.nexusCount} aria-hidden="true">
          {paneCount}
        </span>
      </button>
    </div>
  );
}
