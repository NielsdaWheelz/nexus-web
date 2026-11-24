"use client";

import { useCallback, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";
import { paneVisibleBand } from "@/lib/panes/paneScroll";
import { usePaneBeforeLayout, usePaneScrollMotion, type AnchorGeometry, type AnchorGeometryFrame } from "@/lib/workspace/paneReturnMemento";

export const JOURNAL_DAY_ESTIMATE = 320;

function before(tops: readonly number[], offset: number): number {
  let lo = 0, hi = tops.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (tops[mid] <= offset) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

/** Reservations determine the archive's positions. The same prefix serves
 * mounting, the reading date and the pane's explicit return geometry. */
export function useJournalWindow(dates: readonly string[], root: RefObject<HTMLDivElement | null>, index: "pending" | "ready" | "failed", overscan: 0 | 1, typography: object) {
  const beforeLayout = usePaneBeforeLayout();
  const motion = usePaneScrollMotion();
  const [sizes, setSizes] = useState<ReadonlyMap<string, number>>(() => new Map());
  const prefix = useMemo(() => {
    const ranks = new Map<string, number>();
    let height = 0;
    const tops = dates.map((date, rank) => {
      ranks.set(date, rank);
      const top = height;
      height += sizes.get(date) ?? JOURNAL_DAY_ESTIMATE;
      return top;
    });
    return { ranks, tops, height };
  }, [dates, sizes]);
  const nodes = useRef(new Map<string, HTMLElement>());
  const natural = useRef(new Map<HTMLElement, { date: string; complete: boolean }>());
  const observer = useRef<ResizeObserver | null>(null);
  const deferred = useRef(new Map<string, number>());
  const style = useRef(typography);
  const frame = useRef<AnchorGeometryFrame | null>(null);
  const [demands, setDemands] = useState<ReadonlyMap<symbol, { date: string; descendant: boolean }>>(() => new Map());
  const descendants = useRef(new Map<string, "pending" | "ready" | "failed">());
  const [viewport, setViewport] = useState({ origin: 0, from: 0, until: 0 });
  const [opening, setOpening] = useState<string | null>(null);
  const started = useRef(new Set<string>());
  const nudge = useRef<(() => void) | null>(null);
  const current = useRef({ prefix, sizes });
  const geometryRevision = useRef(0);

  const readViewport = useCallback(() => {
    const feed = root.current;
    const port = feed?.closest<HTMLElement>("[data-pane-content]");
    if (!feed || !port) return;
    const box = feed.getBoundingClientRect(), band = paneVisibleBand(port);
    const origin = box.top - port.getBoundingClientRect().top - port.clientTop + port.scrollTop;
    const from = band.top - box.top, until = band.bottom - box.top;
    setViewport(old => old.origin === origin && old.from === from && old.until === until ? old : { origin, from, until });
  }, [root]);
  const geometry = useMemo<AnchorGeometry>(() => ({
    read: () => frame.current,
    layoutReady: () => true,
    demand(date, descendant = false) {
      const token = Symbol();
      setDemands(old => new Map(old).set(token, { date, descendant }));
      return () => setDemands(old => {
        const next = new Map(old);
        next.delete(token);
        return next;
      });
    },
    descendantState: date => descendants.current.get(date) ?? "pending",
    element: date => nodes.current.get(date) ?? null,
    refreshRange: readViewport,
  }), [readViewport]);
  const article = useCallback((date: string, element: HTMLElement | null) => {
    if (element === null) nodes.current.delete(date);
    else nodes.current.set(date, element);
  }, []);
  const measure = useCallback((date: string, element: HTMLElement, complete: boolean) => {
    natural.current.set(element, { date, complete });
    observer.current?.observe(element);
    return () => { natural.current.delete(element); observer.current?.unobserve(element); };
  }, []);
  const begin = useCallback((date: string) => { started.current.add(date); }, []);
  const release = useCallback((date: string) => {
    started.current.delete(date);
    descendants.current.delete(date);
    nudge.current?.();
  }, []);
  const descendant = useCallback((date: string, state: "pending" | "ready" | "failed") => {
    descendants.current.set(date, state);
  }, []);

  const settle = useCallback((date: string) => { setOpening(old => old === date ? null : old); }, []);

  useLayoutEffect(() => {
    const feed = root.current;
    const port = feed?.closest<HTMLElement>("[data-pane-content]");
    if (!feed || !port) return;
    if (current.current.prefix !== prefix) geometryRevision.current++;
    current.current = { prefix, sizes };
    const origin = feed.getBoundingClientRect().top - port.getBoundingClientRect().top - port.clientTop + port.scrollTop;
    frame.current = {
      revision: geometryRevision.current, root: feed, scrollport: port, origin, anchors: dates,
      firstVisible(top, bottom) {
        const rank = Math.max(0, before(prefix.tops, top));
        return rank < dates.length && top < prefix.height && prefix.tops[rank] < bottom
          ? { id: dates[rank], offset: prefix.tops[rank] }
          : null;
      },
      position(date) {
        const rank = prefix.ranks.get(date);
        if (rank === undefined) {
          if (index === "pending") return { kind: "pending", estimate: null };
          return { kind: index === "failed" ? "failed" : "missing" };
        }
        const offset = prefix.tops[rank];
        const node = nodes.current.get(date);
        return { kind: node && !node.hidden ? "ready" : "reserved", offset };
      },
    };
    readViewport();
  });

  useLayoutEffect(() => {
    const feed = root.current;
    const port = feed?.closest<HTMLElement>("[data-pane-content]");
    if (!feed || !port) return;
    let width = feed.getBoundingClientRect().width;
    let resetOnRest = false;
    const publish = (updates: ReadonlyMap<string, number>, reset = false) => {
      const finish = beforeLayout();
      flushSync(() => {
        setSizes(old => {
          const next = reset ? new Map<string, number>() : new Map(old);
          for (const [date, height] of updates) next.set(date, height);
          return next;
        });
      });
      finish();
    };
    const update = (entries: Iterable<HTMLElement>, reset = false) => {
      const { prefix, sizes } = current.current;
      const line = paneVisibleBand(port).top - feed.getBoundingClientRect().top;
      const moving = motion.moving();
      const updates = new Map<string, number>();
      if (reset && moving) { resetOnRest = true; return; }
      if (reset) deferred.current.clear();
      for (const element of entries) {
        const measurement = natural.current.get(element);
        if (measurement === undefined) continue;
        const { date, complete } = measurement;
        const rank = prefix.ranks.get(date);
        if (rank === undefined) continue;
        const measured = element.getBoundingClientRect().height;
        if (measured <= 0) continue;
        const height = complete ? measured : Math.max(measured, sizes.get(date) ?? JOURNAL_DAY_ESTIMATE);
        if (moving && prefix.tops[rank] < line) {
          deferred.current.set(date, height);
        } else {
          deferred.current.delete(date);
          if (reset || (sizes.get(date) ?? JOURNAL_DAY_ESTIMATE) !== height) updates.set(date, height);
        }
      }
      if (reset || updates.size) publish(updates, reset);
    };
    const resize = new ResizeObserver(entries => {
      const next = feed.getBoundingClientRect().width;
      const changed = width !== next;
      width = next;
      update(changed ? natural.current.keys() : entries.map(entry => entry.target as HTMLElement), changed);
      readViewport();
    });
    observer.current = resize;
    resize.observe(feed);
    resize.observe(port);
    if (feed.parentElement) resize.observe(feed.parentElement);
    for (const element of natural.current.keys()) resize.observe(element);
    const fonts = () => update(natural.current.keys(), true);
    const restyle = style.current === typography ? null : requestAnimationFrame(fonts);
    style.current = typography;
    document.fonts.addEventListener("loadingdone", fonts);
    port.addEventListener("scroll", readViewport, { passive: true });
    const onRest = motion.onRest(() => {
      if (resetOnRest) {
        resetOnRest = false;
        fonts();
        return;
      }
      if (!deferred.current.size) return;
      const updates = new Map(deferred.current);
      deferred.current.clear();
      publish(updates);
    });
    return () => {
      onRest();
      if (restyle !== null) cancelAnimationFrame(restyle);
      resize.disconnect();
      observer.current = null;
      document.fonts.removeEventListener("loadingdone", fonts);
      port.removeEventListener("scroll", readViewport);
    };
  }, [root, motion, beforeLayout, readViewport, typography]);

  const first = Math.max(0, before(prefix.tops, viewport.from));
  let last = Math.max(first, before(prefix.tops, viewport.until));
  if (prefix.tops[last] === viewport.until) last--;
  const visible = viewport.until > 0 && viewport.from < prefix.height ? dates.slice(first, last + 1) : [];
  const reading = viewport.from >= 0 ? visible[0] ?? null : null;
  const requested = useMemo(() => new Set([...demands.values()].map(({ date }) => date)), [demands]);
  const bodies = useMemo(() => new Set([...demands.values()].filter(request => request.descendant).map(({ date }) => date)), [demands]);
  const nearby = dates.slice(Math.max(0, first - overscan), last + 1 + overscan);
  const openingPresent = opening !== null && prefix.ranks.has(opening);
  useLayoutEffect(() => {
    if (opening !== null && !openingPresent) settle(opening);
  }, [opening, openingPresent, settle]);

  // Re-sample the live coordinates rather than chasing a queue of past dates.
  // The second frame runs even if no more scroll events arrive.
  useLayoutEffect(() => {
    if (opening !== null) return;
    const candidate = () => {
      const feed = root.current;
      if (!feed) return null;
      const port = feed.closest<HTMLElement>("[data-pane-content]");
      if (!port) return null;
      const box = feed.getBoundingClientRect(), band = paneVisibleBand(port);
      const from = band.top - box.top, until = band.bottom - box.top;
      if (until <= 0 || from >= prefix.height) return null;
      for (let rank = Math.max(0, before(prefix.tops, from)); rank < dates.length && prefix.tops[rank] < until; rank++) {
        const date = dates[rank];
        if (nodes.current.has(date) && !started.current.has(date)) return date;
      }
      return null;
    };
    let sample: number | null = null;
    const schedule = () => {
      if (sample !== null) return;
      sample = requestAnimationFrame(() => {
        sample = null;
        const date = candidate();
        if (date === null) return;
        sample = requestAnimationFrame(() => {
          sample = null;
          if (candidate() === date) setOpening(date);
          else schedule();
        });
      });
    };
    nudge.current = schedule;
    schedule();
    return () => {
      if (sample !== null) cancelAnimationFrame(sample);
      nudge.current = null;
    };
  }, [opening, dates, prefix, root]);
  useLayoutEffect(() => { nudge.current?.(); }, [viewport]);

  return { ...prefix, sizes, viewport, visible, reading, nearby, requested, bodies, opening, geometry, article, measure, begin, release, settle, descendant };
}
