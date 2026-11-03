"use client";

/** Nothing to show yet, in the empty region. Six hairlines that css alone brings in, so a fast
 * read paints nothing; it unmounts the frame content lands. The active region says `opening` once.
 *
 * A region is its modal, else the source its pane shows, else the host, so a navigation begins a
 * new wait whatever stood before it. A region carries a wait across a handoff: a ruling that
 * mounts within a frame of the region's last one leaving continues that one's clock, so a cold
 * open that passes through several reads fades in once and shows `still opening` 8s after it
 * began. A ruling that mounts beside one still standing keeps its own clock, so a fast read there
 * paints nothing. While any of a region's rulings stand, it says `opening` once. */
import { useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { paneSourceKey, usePaneRuntime } from "@/lib/panes/paneRuntime";
import { OverlayContext } from "@/lib/ui/overlay";
import { Announcement, useActiveRegion } from "./Feedback";
import styles from "./Ruling.module.css";

const OPENING_MS = 2000;
/** A region's standing rulings, whether it said `opening`, and, for a frame after the last of
 * them left, that one's clock and the frame that ends the offer. */
type Wait = { said: boolean; rulings: number; ending: { start: number; frame: number } | null };
const waits = new Map<object | string, Wait>();
const HOST = {};

export function Ruling() {
  const overlay = useContext(OverlayContext);
  const runtime = usePaneRuntime();
  const region = overlay ?? (runtime ? paneSourceKey(runtime) : HOST);
  const active = useActiveRegion();
  const element = useRef<HTMLDivElement>(null);
  const joined = useRef<{ wait: Wait; start: number } | null>(null);
  const [opening, setOpening] = useState<object | null>(null);
  useLayoutEffect(() => {
    const wait = waits.get(region) ?? { said: false, rulings: 0, ending: null };
    const start = wait.ending?.start ?? performance.now();
    if (wait.ending !== null) cancelAnimationFrame(wait.ending.frame);
    wait.ending = null;
    wait.rulings += 1;
    waits.set(region, wait);
    joined.current = { wait, start };
    element.current?.style.setProperty("--ruling-elapsed", `${performance.now() - start}ms`);
    return () => {
      wait.rulings -= 1;
      if (wait.rulings === 0) wait.ending = { start, frame: requestAnimationFrame(() => waits.delete(region)) };
    };
  }, [region]);
  useEffect(() => {
    if (!active || joined.current === null || joined.current.wait.said) return;
    const { wait, start } = joined.current;
    const timer = setTimeout(() => {
      if (wait.said) return;
      wait.said = true;
      setOpening({});
    }, OPENING_MS - (performance.now() - start));
    return () => clearTimeout(timer);
  }, [active, region]);
  return <>
    <div ref={element} className={styles.ruling} aria-hidden="true"><span className={styles.still}>still opening</span></div>
    <Announcement text={opening ? "opening" : ""} level="Polite" occurrence={opening ?? undefined} />
  </>;
}
