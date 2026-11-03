"use client";

/** Nothing to show yet, in the empty region. Six hairlines that css alone brings in, so a fast
 * read paints nothing; it unmounts the frame content lands. The active region says `opening` once.
 *
 * A region (its modal, else its pane, else the host) has one wait: every ruling in it, and one
 * that mounts within a frame of the last leaving, shows that wait's clock. So a cold open that
 * passes through several reads is one wait: it fades in once, says `opening` once, and shows
 * `still opening` 8s after it began. */
import { useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { usePaneRuntime } from "@/lib/panes/paneRuntime";
import { OverlayContext } from "@/lib/ui/overlay";
import { Announcement, useActiveRegion } from "./Feedback";
import styles from "./Ruling.module.css";

const OPENING_MS = 2000;
type Wait = { start: number; said: boolean; rulings: number; ending: number | null };
const waits = new Map<object | string, Wait>();
const HOST = {};

export function Ruling() {
  const overlay = useContext(OverlayContext);
  const paneId = usePaneRuntime()?.paneId ?? null;
  const region = overlay ?? paneId ?? HOST;
  const active = useActiveRegion();
  const element = useRef<HTMLDivElement>(null);
  const joined = useRef<Wait | null>(null);
  const [opening, setOpening] = useState<object | null>(null);
  useLayoutEffect(() => {
    const wait = waits.get(region) ?? { start: performance.now(), said: false, rulings: 0, ending: null };
    if (wait.ending !== null) cancelAnimationFrame(wait.ending);
    wait.ending = null;
    wait.rulings += 1;
    waits.set(region, wait);
    joined.current = wait;
    element.current?.style.setProperty("--ruling-elapsed", `${performance.now() - wait.start}ms`);
    return () => {
      wait.rulings -= 1;
      if (wait.rulings === 0) wait.ending = requestAnimationFrame(() => waits.delete(region));
    };
  }, [region]);
  useEffect(() => {
    const wait = joined.current;
    if (!active || wait === null || wait.said) return;
    const timer = setTimeout(() => {
      if (wait.said) return;
      wait.said = true;
      setOpening({});
    }, OPENING_MS - (performance.now() - wait.start));
    return () => clearTimeout(timer);
  }, [active, region]);
  return <>
    <div ref={element} className={styles.ruling} aria-hidden="true"><span className={styles.still}>still opening</span></div>
    <Announcement text={opening ? "opening" : ""} level="Polite" occurrence={opening ?? undefined} />
  </>;
}
