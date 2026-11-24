"use client";

import { useCallback, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";
import { paneVisibleBand } from "@/lib/panes/paneScroll";
import type { DailyIndexResult } from "@nexus/authored/types";
import { usePaneBeforeLayout, type AnchorGeometry, type AnchorGeometryFrame } from "@/lib/workspace/paneReturnMemento";

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

export interface JournalOrder {
  count: number;
  observation: string | null;
  dates: readonly string[];
  dateAt(rank: number): string | undefined;
  rankOf(date: string): number | null;
}

/** A large description carries the whole civil order as occupied days per month.
 * Bit zero is the first day. Both month records and days order newest first. */
export function journalOrder(description: Extract<DailyIndexResult, {kind: "description"}> | null): JournalOrder {
  const count = description?.total ?? 0;
  const dates = description?.items.map(day => day.local_date) ?? [];
  if (description === null || dates.length === count) {
    const ranks = new Map(dates.map((date, rank) => [date, rank]));
    return {count, observation: null, dates, dateAt: rank => dates[rank], rankOf: date => ranks.get(date) ?? null};
  }
  const bitCount = (mask: number) => {
    let count = 0;
    for (; mask !== 0; mask &= mask - 1) count++;
    return count;
  };
  let start = 0;
  const months = description.months.map(([month, mask]) => {
    const entry = {month, mask, start};
    start += bitCount(mask);
    return entry;
  });
  if (start !== count) throw new Error("journal date description has inconsistent extent");
  const byMonth = new Map(months.map(entry => [entry.month, entry]));
  const dateAt = (rank: number) => {
    if (rank < 0 || rank >= count) return undefined;
    let low = 0, high = months.length;
    while (low + 1 < high) {
      const middle = (low + high) >>> 1;
      if (months[middle].start <= rank) low = middle; else high = middle;
    }
    const {month, start, mask} = months[low];
    let rest = mask;
    for (let skip = start; skip < rank; skip++) rest ^= 1 << (31 - Math.clz32(rest));
    return `${month}-${String(32 - Math.clz32(rest)).padStart(2, "0")}`;
  };
  let complete: string[] | null = null;
  return {count, observation: JSON.stringify(description.months), dateAt,
    get dates() { return complete ??= Array.from({length: count}, (_, rank) => dateAt(rank)!); },
    rankOf(date) {
      const entry = byMonth.get(date.slice(0, 7));
      const day = Number(date.slice(8));
      if (entry === undefined || !Number.isInteger(day) || day < 1 || day > 31) return null;
      const bit = 1 << (day - 1);
      return (entry.mask & bit) === 0 ? null : entry.start + bitCount(entry.mask & ~(bit | (bit - 1)));
    },
  };
}

/** The reservations define date placement and reading order. */
export function useJournalWindow(order: JournalOrder, root: RefObject<HTMLDivElement | null>, index: "pending" | "ready" | "failed",
  overscan: 0 | 1, typography: object, held: boolean) {
  const beforeLayout = usePaneBeforeLayout();
  const [sizes, setSizes] = useState<ReadonlyMap<string, number>>(() => new Map());
  const prefix = useMemo(() => {
    const measured = new Map<number, number>();
    for (const [date, height] of sizes) {
      const rank = order.rankOf(date);
      if (rank !== null) measured.set(rank, height);
    }
    let height = 0;
    const tops = Array.from({length: order.count}, (_, rank) => {
      const top = height;
      height += measured.get(rank) ?? JOURNAL_DAY_ESTIMATE;
      return top;
    });
    return { tops, height };
  }, [order, sizes]);
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
  const current = useRef({ order, prefix, sizes });
  const heldLayout = useRef(held);
  const settleMeasurements = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    const released = heldLayout.current && !held;
    heldLayout.current = held;
    if (released) queueMicrotask(() => { if (!heldLayout.current) settleMeasurements.current?.(); });
  }, [held]);
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
    if (current.current.prefix !== prefix || current.current.order !== order) geometryRevision.current++;
    current.current = { order, prefix, sizes };
    const origin = feed.getBoundingClientRect().top - port.getBoundingClientRect().top - port.clientTop + port.scrollTop;
    const day = [...nodes.current.values()].find(node => !node.hidden);
    const spacing = day?.firstElementChild ? parseFloat(getComputedStyle(day.firstElementChild).paddingBottom) : 0;
    frame.current = {
      revision: geometryRevision.current, observation: order.observation ?? undefined, root: feed, scrollport: port, origin,
      get anchors() { return order.dates; },
      firstVisible(top, bottom) {
        let rank = Math.max(0, before(prefix.tops, top));
        if (top >= (prefix.tops[rank + 1] ?? prefix.height) - spacing) rank++;
        const date = order.dateAt(rank);
        return date !== undefined && prefix.tops[rank] < bottom ? { id: date, offset: prefix.tops[rank] } : null;
      },
      position(date) {
        const rank = order.rankOf(date);
        if (rank === null) {
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
      const { order, sizes } = current.current;
      const moving = heldLayout.current;
      const updates = new Map<string, number>();
      if (reset && moving) { resetOnRest = true; return; }
      if (reset) deferred.current.clear();
      for (const element of entries) {
        const measurement = natural.current.get(element);
        if (measurement === undefined) continue;
        const { date, complete } = measurement;
        if (order.rankOf(date) === null) continue;
        const measured = element.getBoundingClientRect().height;
        if (measured <= 0) continue;
        const height = complete ? measured : Math.max(measured, sizes.get(date) ?? JOURNAL_DAY_ESTIMATE);
        if (moving) {
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
    settleMeasurements.current = () => {
      if (resetOnRest) {
        resetOnRest = false;
        fonts();
        return;
      }
      if (!deferred.current.size) return;
      const updates = new Map(deferred.current);
      deferred.current.clear();
      publish(updates);
    };
    return () => {
      settleMeasurements.current = null;
      if (restyle !== null) cancelAnimationFrame(restyle);
      resize.disconnect();
      observer.current = null;
      document.fonts.removeEventListener("loadingdone", fonts);
      port.removeEventListener("scroll", readViewport);
    };
  }, [root, beforeLayout, readViewport, typography]);

  const first = Math.max(0, before(prefix.tops, viewport.from));
  let last = Math.min(order.count - 1, Math.max(first, before(prefix.tops, viewport.until)));
  if (prefix.tops[last] === viewport.until) last--;
  const visible = viewport.until > 0 && viewport.from < prefix.height
    ? Array.from({length: Math.max(0, last - first + 1)}, (_, index) => order.dateAt(first + index)!) : [];
  const reading = viewport.from >= 0 ? visible[0] ?? null : null;
  const requested = useMemo(() => new Set([...demands.values()].map(({ date }) => date)), [demands]);
  const bodies = useMemo(() => new Set([...demands.values()].filter(request => request.descendant).map(({ date }) => date)), [demands]);
  const start = Math.max(0, first - overscan), end = Math.min(order.count, last + 1 + overscan);
  const nearby = Array.from({length: Math.max(0, end - start)}, (_, index) => order.dateAt(start + index)!);
  const openingPresent = opening !== null && order.rankOf(opening) !== null;
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
      for (let rank = Math.max(0, before(prefix.tops, from)); rank < order.count && prefix.tops[rank] < until; rank++) {
        const date = order.dateAt(rank)!;
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
  }, [opening, order, prefix, root]);
  useLayoutEffect(() => { nudge.current?.(); }, [viewport]);

  return { ...prefix, sizes, viewport, visible, reading, nearby, requested, bodies, opening, geometry, article, measure, begin, release, settle, descendant };
}
