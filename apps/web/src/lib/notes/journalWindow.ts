"use client";

/** Date geometry and admission only. Outline sessions own their writing and rows. */
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";
import type {DailyIndexResult} from "@nexus/authored/types";
import { defaultRangeExtractor, observeElementOffset, useVirtualizer } from "@tanstack/react-virtual";
import { usePaneBeforeLayout, type AnchorGeometry, type AnchorGeometryFrame } from "@/lib/workspace/paneReturnMemento";

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
  return {count, observation: JSON.stringify(description.months), dates,
    dateAt(rank) {
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
    },
    rankOf(date) {
      const entry = byMonth.get(date.slice(0, 7));
      const day = Number(date.slice(8));
      if (entry === undefined || !Number.isInteger(day) || day < 1 || day > 31) return null;
      const bit = 1 << (day - 1);
      return (entry.mask & bit) === 0 ? null : entry.start + bitCount(entry.mask & ~(bit | (bit - 1)));
    },
  };
}

export function useJournalWindow(order: JournalOrder, root: RefObject<HTMLDivElement | null>, indexState: "pending" | "ready" | "failed",
  overscan: 0 | 1, held: boolean, requestedDates: readonly string[], request?: (ranks: readonly number[], dates: readonly string[]) => void) {
  const beforeLayout = usePaneBeforeLayout();
  const [, changed] = useState(0);
  const revision = useRef(0);
  const heldLayout = useRef(held);
  const pendingInvalidation = useRef(false);
  const sweep = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    const released = heldLayout.current && !held;
    heldLayout.current = held;
    if (!released) return;
    queueMicrotask(() => { if (!heldLayout.current) sweep.current?.(); });
  }, [held]);
  const heights = useRef(new Map<string, number>());
  const elements = useRef(new Map<string, HTMLElement>());
  const admissions = useRef(new Map<string, "pending" | "ready" | "failed">());
  const demands = useRef(new Map<symbol, string>());
  const observer = useRef<ResizeObserver | null>(null);
  const syncOffset = useRef<(() => void) | null>(null);
  const frame = useRef<AnchorGeometryFrame | null>(null);
  const committed = useRef({ rankOf: order.rankOf, origin: 0, revision: 0 });
  const measuredObservation = useRef(order.observation);
  const sizes = new Map<number, number>();
  for (const [date, height] of heights.current) {
    const rank = order.rankOf(date);
    if (rank === null) continue;
    sizes.set(rank, height);
  }
  const scrollport = useCallback(() => root.current?.closest<HTMLElement>("[data-pane-content]") ?? null, [root]);
  const compactDates = order.observation === null ? order.dates : null;
  const key = useCallback((rank: number) => compactDates?.[rank] ?? rank, [compactDates]);
  const wanted = [...new Set([...demands.current.values(), ...requestedDates])];
  const virtualizer = useVirtualizer<HTMLElement, HTMLElement>({
    count: order.count, getScrollElement: scrollport, getItemKey: key,
    estimateSize: rank => sizes.get(rank) ?? 320,
    overscan,
    scrollMargin: committed.current.origin,
    rangeExtractor: range => [...new Set([...defaultRangeExtractor(range), ...wanted.flatMap(date => {
      const rank = order.rankOf(date);
      return rank === null ? [] : [rank];
    })])].sort((a, b) => a - b),
    observeElementOffset: (instance, receive) => {
      const release = observeElementOffset(instance, receive);
      const sync = () => { const element = instance.scrollElement; if (element !== null) receive(element.scrollTop, false); };
      syncOffset.current = sync;
      return () => { if (syncOffset.current === sync) syncOffset.current = null; release?.(); };
    },
    // All explicit positioning and size compensation belong to the pane memento.
    scrollToFn: () => {},
  });
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = () => false;
  virtualizer.getTotalSize();
  const slots = virtualizer.getVirtualItems();
  const dates = slots.flatMap(slot => {
    const date = order.dateAt(slot.index);
    return date === undefined ? [] : [date];
  });
  useLayoutEffect(() => {
    request?.(slots.flatMap(slot => [slot.index - 1, slot.index, slot.index + 1].filter(rank => rank >= 0)), wanted);
  });
  const tops: number[] = [];
  let height = 0;
  for (let rank = 0; rank < order.count; rank++) {
    tops.push(height);
    height += sizes.get(rank) ?? 320;
  }
  const port = scrollport();
  const origin = root.current && port
    ? root.current.getBoundingClientRect().top - port.getBoundingClientRect().top - port.clientTop + port.scrollTop : 0;
  const epoch = revision.current;
  const day = [...elements.current.values()].find(element => !element.hidden);
  const trailing = day === undefined ? 0 : parseFloat(getComputedStyle(day).paddingBottom);
  // Day spacing occupies layout, but cannot be the reader's eye-line anchor.
  const firstVisible = (top: number, bottom: number) => {
    let low = 0, high = order.count;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if ((tops[middle + 1] ?? height) - trailing <= top) low = middle + 1;
      else high = middle;
    }
    const date = order.dateAt(low);
    return date !== undefined && tops[low] < bottom ? {id: date, offset: tops[low]} : null;
  };

  const measure = useCallback((date: string, element: HTMLElement | null) => {
    const previous = elements.current.get(date);
    if (previous === element) return;
    if (previous) observer.current?.unobserve(previous);
    if (element === null) elements.current.delete(date);
    else { elements.current.set(date, element); observer.current?.observe(element); }
  }, []);
  const admit = useCallback((date: string, state: "pending" | "ready" | "failed") => {
    if (admissions.current.get(date) === state) return;
    admissions.current.set(date, state); changed(value => value + 1);
  }, []);
  const geometry = useMemo<AnchorGeometry>(() => ({
    read: () => frame.current,
    layoutReady() {
      // A changed article and its new date prefix are one pane layout change.
      if (committed.current.revision !== revision.current) return false;
      for (const [date, element] of elements.current) {
        if (element.hidden) continue;
        const height = element.getBoundingClientRect().height;
        if (height > 0 && heights.current.get(date) !== height) return false;
      }
      return true;
    },
    demand(date) {
      const owner = Symbol();
      demands.current.set(owner, date);
      changed(value => value + 1);
      return () => { if (demands.current.delete(owner)) changed(value => value + 1); };
    },
    element: date => elements.current.get(date) ?? null,
    // The pane writes before scroll delivery; admit dates from its actual offset.
    refreshRange() {
      syncOffset.current?.();
      const current = frame.current;
      if (current === null) return;
      const {root, scrollport, origin} = current;
      const top = root.getBoundingClientRect().top - scrollport.getBoundingClientRect().top - scrollport.clientTop + scrollport.scrollTop;
      if (top !== origin) changed(value => value + 1);
    },
  }), []);

  useLayoutEffect(() => {
    if (!port || !root.current) return;
    const origin = root.current.getBoundingClientRect().top - port.getBoundingClientRect().top - port.clientTop + port.scrollTop;
    const mounted = new Set([...elements.current].filter(([, element]) => !element.hidden).map(([date]) => date));
    const proof = new Map(admissions.current);
    if (measuredObservation.current !== order.observation) {
      virtualizer.measure();
      for (const [rank, size] of sizes) virtualizer.resizeItem(rank, size);
    }
    measuredObservation.current = order.observation;
    frame.current = { revision: epoch, observation: order.observation ?? undefined, root: root.current, scrollport: port, origin,
      anchors: order.observation === null ? order.dates : dates,
      firstVisible,
      position(date) {
        if (indexState === "failed") return { kind: "failed" };
        if (indexState === "pending") return { kind: "pending", estimate: null };
        const index = order.rankOf(date);
        if (index === null) return {kind: "missing"};
        if (proof.get(date) === "failed") return { kind: "failed" };
        return mounted.has(date) && proof.get(date) === "ready" ? { kind: "ready", offset: tops[index] } : { kind: "pending", estimate: tops[index] };
      },
    };
    committed.current = {rankOf: order.rankOf, origin, revision: epoch};
  });
  useLayoutEffect(() => {
    let width: number | null = null;
    let typography: string | null = null, writingTypography = "";
    const font = (element: Element) => {
      const style = getComputedStyle(element);
      return [style.fontFamily, style.fontSize, style.fontWeight, style.lineHeight, style.letterSpacing];
    };
    const readTypography = () => {
      const node = root.current;
      if (node === null) return null;
      const heading = node.querySelector("h2"), writing = node.querySelector('[data-reference-editor^="outline:"]');
      if (writing !== null) writingTypography = JSON.stringify(font(writing));
      return JSON.stringify([font(node), heading === null ? null : font(heading), writingTypography]);
    };
    const invalidate = () => {
      if (heldLayout.current) { pendingInvalidation.current = true; return; }
      pendingInvalidation.current = false;
      typography = readTypography();
      const finish = beforeLayout();
      flushSync(() => {
        heights.current.clear(); revision.current += 1;
        const measured: { index: number; height: number }[] = [];
        for (const [date, element] of elements.current) {
          if (element.hidden) continue;
          const index = committed.current.rankOf(date), height = element.getBoundingClientRect().height;
          if (index !== null && height > 0) {
            heights.current.set(date, height);
            measured.push({ index, height });
          }
        }
        virtualizer.measure();
        for (const { index, height } of measured) virtualizer.resizeItem(index, height);
        changed(value => value + 1);
      });
      finish();
    };
    const size = (entries: ResizeObserverEntry[]) => {
      if (!heldLayout.current && pendingInvalidation.current) invalidate();
      const nextTypography = readTypography();
      if (typography !== null && nextTypography !== typography) invalidate();
      typography = nextTypography;
      for (const entry of entries) if (entry.target === root.current) {
        const next = entry.contentRect.width;
        if (width !== null && width !== next) invalidate();
        width = next;
      }
      update(entries.flatMap(entry => entry.target !== root.current ? [entry.target as HTMLElement] : []));
    };
    const update = (nodes: Iterable<HTMLElement>) => {
      if (heldLayout.current) return;
      const { rankOf } = committed.current;
      const updates: { index: number; date: string; height: number }[] = [];
      for (const element of nodes) {
        const date = element.dataset.journalDate;
        if (!date || element.hidden) continue;
        const index = rankOf(date), height = element.getBoundingClientRect().height;
        if (index !== null && height > 0 && heights.current.get(date) !== height) updates.push({ index, date, height });
      }
      if (updates.length === 0) return;
      const finish = beforeLayout();
      flushSync(() => {
        for (const update of updates) {
          heights.current.set(update.date, update.height);
          virtualizer.resizeItem(update.index, update.height);
        }
        revision.current += 1;
        changed(value => value + 1);
      });
      finish();
    };
    sweep.current = () => {
      if (pendingInvalidation.current) invalidate();
      else update(elements.current.values());
    };
    observer.current = new ResizeObserver(size);
    if (root.current) observer.current.observe(root.current);
    for (const element of elements.current.values()) observer.current.observe(element);
    document.fonts.addEventListener("loadingdone", invalidate);
    return () => {
      observer.current?.disconnect(); observer.current = null; sweep.current = null;
      document.fonts.removeEventListener("loadingdone", invalidate);
    };
  }, [beforeLayout, root, virtualizer, port]);
  const visible = port === null ? null : firstVisible(port.scrollTop - origin, port.scrollTop - origin + port.clientHeight)?.id ?? null;
  return {geometry, measure, admit, dates, tops, height, visible};
}
