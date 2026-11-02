"use client";

/** Nothing to show yet, in the empty region. Six hairlines that css alone brings in, so a fast
 * read paints nothing; it unmounts the frame content lands. The active region says `opening` once. */
import { useEffect, useState } from "react";
import { Announcement, useActiveRegion } from "./Feedback";
import styles from "./Ruling.module.css";

const OPENING_MS = 2000;
/** Several rulings in one region open together and say so once. */
let lastOpening = Number.NEGATIVE_INFINITY;

export function Ruling() {
  const active = useActiveRegion();
  const [opening, setOpening] = useState<object | null>(null);
  const said = opening !== null;
  useEffect(() => {
    if (!active || said) return;
    const timer = setTimeout(() => {
      if (performance.now() - lastOpening < OPENING_MS) return;
      lastOpening = performance.now();
      setOpening({});
    }, OPENING_MS);
    return () => clearTimeout(timer);
  }, [active, said]);
  return <>
    <div className={styles.ruling} aria-hidden="true"><span className={styles.still}>still opening</span></div>
    <Announcement text={opening ? "opening" : ""} level="Polite" occurrence={opening ?? undefined} />
  </>;
}
