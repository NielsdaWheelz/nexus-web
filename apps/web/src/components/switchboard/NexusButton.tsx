"use client";

import { useLayoutEffect, useRef } from "react";
import AsterismMark from "@/components/AsterismMark";
import { useMobileViewport } from "@/lib/mobileViewport/MobileViewportProvider";
import {
  useMobileChrome,
  useMobileChromeSurface,
} from "@/lib/workspace/mobileChrome";
import {
  beginSwitchboardPerformance,
  NEXUS_OPEN_PERFORMANCE,
} from "@/lib/switchboard/performance";
import styles from "./switchboard.module.css";

export default function NexusButton({
  paneCount,
  switchboardOpen,
  onOpen,
}: {
  paneCount: number;
  switchboardOpen: boolean;
  onOpen: () => void;
}) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const mobileViewport = useMobileViewport();
  const { motionPhase } = useMobileChrome();
  useMobileChromeSurface(buttonRef, "NexusControl", true);
  useLayoutEffect(() => {
    const element = wrapperRef.current;
    if (switchboardOpen || !element) return;
    return mobileViewport.registerFixedObstruction("Nexus", element);
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
        ref={buttonRef}
        type="button"
        className={styles.nexusButton}
        aria-label={label}
        aria-haspopup="dialog"
        aria-hidden={motionInert || switchboardOpen || undefined}
        inert={motionInert || switchboardOpen || undefined}
        data-mobile-chrome-phase={motionPhase.kind}
        onClick={() => {
          beginSwitchboardPerformance(NEXUS_OPEN_PERFORMANCE);
          onOpen();
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
