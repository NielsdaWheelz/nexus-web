"use client";

/** Nothing to show yet, in the empty region. Six hairlines that css alone brings in, so a fast
 * read paints nothing; it unmounts the frame content lands. The active region says `opening` once.
 *
 * A region is its explicit object, else its modal, else the source its pane shows, else the host, so a navigation begins a
 * new wait whatever stood before it. A region carries a wait across a handoff: a ruling that
 * mounts within a frame of another leaving the region continues the clock of the one that left
 * last, whatever else stands there, so a cold open that passes through several reads fades in once
 * and shows `still opening` 8s after it began. Any other ruling keeps its own clock, so a fast read
 * beside one standing paints nothing. While any of a region's rulings stand, it says `opening`
 * once; a region with none standing and none just left has ended its wait. */
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { paneSourceKey, usePaneRuntime } from "@/lib/panes/paneRuntime";
import { OverlayContext } from "@/lib/ui/overlay";
import { Announcement } from "./Announcement";
import { useActiveRegion } from "./stage";
import styles from "./Ruling.module.css";

const OPENING_MS = 2000;
/** A ruling that left longer ago than this is no handoff, frame or no frame: a hidden document
 * runs no frames. It is the css's 200ms delay, so a ruling that continues a clock it should not
 * have still paints nothing as it mounts. */
const STALE_MS = 200;
/** A region's standing rulings, whether it said `opening`, and, until the next frame, the clock of
 * the ruling that left it last and when that one left. */
type Wait = { said: boolean; rulings: number; left: { start: number; at: number } | null };
const waits = new Map<object | string, Wait>();
const HOST = {};

/** A distinct object inside a pane or modal owns its own wait and sequential read handoffs. */
export const RulingRegion = createContext<string | null>(null);

export function Ruling() {
  const overlay = useContext(OverlayContext);
  const runtime = usePaneRuntime();
  const region = useContext(RulingRegion) ?? overlay ?? (runtime ? paneSourceKey(runtime) : HOST);
  const active = useActiveRegion();
  const element = useRef<HTMLDivElement>(null);
  const joined = useRef<{ wait: Wait; start: number } | null>(null);
  const [opening, setOpening] = useState<object | null>(null);
  useLayoutEffect(() => {
    const now = performance.now();
    const prior = waits.get(region);
    const handoff = prior?.left && now - prior.left.at <= STALE_MS ? prior.left : null;
    const wait: Wait = prior !== undefined && (prior.rulings > 0 || handoff !== null) ? prior : { said: false, rulings: 0, left: null };
    const start = handoff?.start ?? now;
    wait.rulings += 1;
    waits.set(region, wait);
    joined.current = { wait, start };
    element.current?.style.setProperty("--ruling-elapsed", `${now - start}ms`);
    return () => {
      const left = { start, at: performance.now() };
      wait.rulings -= 1;
      wait.left = left;
      requestAnimationFrame(() => {
        if (wait.left !== left) return;
        wait.left = null;
        if (wait.rulings === 0 && waits.get(region) === wait) waits.delete(region);
      });
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
