"use client";

/** Nothing to show yet, in the empty region. Six hairlines that css alone brings in, so a fast
 * read paints nothing; it unmounts the frame content lands. The active region says `opening` once. */
import { useContext, useEffect, useState } from "react";
import { usePaneRuntime } from "@/lib/panes/paneRuntime";
import { OverlayContext, topModal } from "@/lib/ui/overlay";
import { Announcement } from "./Feedback";
import { StageContext } from "./stage";
import styles from "./Ruling.module.css";

const OPENING_MS = 2000;
/** Several rulings in one region open together and say so once. */
let lastOpening = Number.NEGATIVE_INFINITY;

export function Ruling() {
  const stage = useContext(StageContext);
  const overlay = useContext(OverlayContext);
  const paneId = usePaneRuntime()?.paneId ?? null;
  const [opening, setOpening] = useState<object | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => {
      const modal = topModal();
      const active = overlay ? overlay === modal : modal === null && (paneId === null || stage?.activePane() === paneId);
      if (!active || performance.now() - lastOpening < OPENING_MS) return;
      lastOpening = performance.now();
      setOpening({});
    }, OPENING_MS);
    return () => clearTimeout(timer);
  }, [stage, overlay, paneId]);
  return <>
    <div className={styles.ruling} aria-hidden="true"><span className={styles.still}>still opening</span></div>
    <Announcement text={opening ? "opening" : ""} level="Polite" occurrence={opening ?? undefined} />
  </>;
}
