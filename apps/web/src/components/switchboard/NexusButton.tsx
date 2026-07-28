"use client";

import { useLayoutEffect, useRef } from "react";
import AsterismMark from "@/components/AsterismMark";
import { useMobileViewport } from "@/lib/mobileViewport/MobileViewportProvider";
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
  const ref = useRef<HTMLButtonElement>(null);
  const mobileViewport = useMobileViewport();
  useLayoutEffect(() => {
    const element = ref.current;
    if (switchboardOpen || !element) return;
    return mobileViewport.registerFixedObstruction("Nexus", element);
  }, [mobileViewport, switchboardOpen]);
  const label =
    paneCount === 1 ? "Open Nexus, 1 tab" : `Open Nexus, ${paneCount} tabs`;
  return (
    <button
      ref={ref}
      type="button"
      className={styles.nexusButton}
      aria-label={label}
      aria-haspopup="dialog"
      aria-hidden={switchboardOpen || undefined}
      inert={switchboardOpen || undefined}
      onClick={() => {
        beginSwitchboardPerformance(NEXUS_OPEN_PERFORMANCE);
        onOpen();
      }}
    >
      <AsterismMark size={22} />
      <span aria-hidden="true">{paneCount}</span>
    </button>
  );
}
