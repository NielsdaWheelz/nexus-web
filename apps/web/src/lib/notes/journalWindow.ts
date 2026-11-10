"use client";

/** Date geometry and admission only. Outline sessions own their writing and rows. */
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import { usePaneBeforeLayout, type AnchorGeometry, type AnchorGeometryFrame } from "@/lib/workspace/paneReturnMemento";

export function useJournalWindow(dates: readonly string[], root: RefObject<HTMLDivElement | null>, indexState: "pending" | "ready" | "failed", overscan: 0 | 1) {
  const beforeLayout = usePaneBeforeLayout();
  const [, changed] = useState(0);
  const revision = useRef(0);
  const heights = useRef(new Map<string, number>());
  const elements = useRef(new Map<string, HTMLElement>());
  const admissions = useRef(new Map<string, "pending" | "ready" | "failed">());
  const demands = useRef(new Map<symbol, string>());
  const observer = useRef<ResizeObserver | null>(null);
  const frame = useRef<AnchorGeometryFrame | null>(null);
  const committed = useRef({ dates, tops: [] as number[], port: null as HTMLElement | null, origin: 0, revision: 0 });
  const scrollport = useCallback(() => root.current?.closest<HTMLElement>("[data-pane-content]") ?? null, [root]);
  const key = useCallback((index: number) => dates[index]!, [dates]);
  const virtualizer = useVirtualizer<HTMLElement, HTMLElement>({
    count: dates.length, getScrollElement: scrollport, getItemKey: key,
    estimateSize: index => heights.current.get(dates[index]) ?? 320,
    overscan,
    scrollMargin: committed.current.origin,
    rangeExtractor: range => [...new Set([...defaultRangeExtractor(range), ...[...demands.current.values()]
      .map(date => dates.indexOf(date)).filter(index => index >= 0)])].sort((a, b) => a - b),
    // All explicit positioning and size compensation belong to the pane memento.
    scrollToFn: () => {},
  });
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = () => false;
  virtualizer.getTotalSize();
  const slots = virtualizer.getVirtualItems();
  const tops: number[] = [];
  let height = 0;
  for (const date of dates) { tops.push(height); height += heights.current.get(date) ?? 320; }
  const port = scrollport();
  const origin = root.current && port
    ? root.current.getBoundingClientRect().top - port.getBoundingClientRect().top - port.clientTop + port.scrollTop : 0;
  const epoch = revision.current;

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
    refreshRange: () => changed(value => value + 1),
  }), []);

  useLayoutEffect(() => {
    if (!port || !root.current) return;
    const origin = root.current.getBoundingClientRect().top - port.getBoundingClientRect().top - port.clientTop + port.scrollTop;
    const mounted = new Set([...elements.current].filter(([, element]) => !element.hidden).map(([date]) => date));
    const proof = new Map(admissions.current);
    const byDate = new Map(dates.map((date, index) => [date, index]));
    frame.current = { revision: epoch, root: root.current, scrollport: port, origin, anchors: dates,
      firstVisible(top, bottom) {
        const index = dates.findIndex((_, index) => (tops[index + 1] ?? height) > top && tops[index] < bottom);
        return index < 0 ? null : { id: dates[index], offset: tops[index] };
      },
      position(date) {
        if (indexState === "failed") return { kind: "failed" };
        if (indexState === "pending") return { kind: "pending", estimate: null };
        const index = byDate.get(date);
        if (index === undefined) return { kind: "missing" };
        if (proof.get(date) === "failed") return { kind: "failed" };
        return mounted.has(date) && proof.get(date) === "ready" ? { kind: "ready", offset: tops[index] } : { kind: "pending", estimate: tops[index] };
      },
    };
    committed.current = { dates, tops, port, origin, revision: epoch };
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
      typography = readTypography();
      const finish = beforeLayout();
      flushSync(() => {
        heights.current.clear(); revision.current += 1;
        const measured: { index: number; height: number }[] = [];
        for (const [date, element] of elements.current) {
          if (element.hidden) continue;
          const index = committed.current.dates.indexOf(date), height = element.getBoundingClientRect().height;
          if (index >= 0 && height > 0) { heights.current.set(date, height); measured.push({ index, height }); }
        }
        virtualizer.measure();
        for (const { index, height } of measured) virtualizer.resizeItem(index, height);
        changed(value => value + 1);
      });
      finish();
    };
    const size = (entries: ResizeObserverEntry[]) => {
      const nextTypography = readTypography();
      if (typography !== null && nextTypography !== typography) invalidate();
      typography = nextTypography;
      const { dates } = committed.current;
      const updates: { index: number; date: string; height: number }[] = [];
      for (const entry of entries) {
        if (entry.target === root.current) {
          const next = entry.contentRect.width;
          if (width !== null && width !== next) invalidate();
          width = next;
          continue;
        }
        const element = entry.target as HTMLElement;
        const date = element.dataset.journalDate;
        if (!date || element.hidden) continue;
        const index = dates.indexOf(date), height = element.getBoundingClientRect().height;
        if (index >= 0 && height > 0 && heights.current.get(date) !== height) updates.push({ index, date, height });
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
    observer.current = new ResizeObserver(size);
    if (root.current) observer.current.observe(root.current);
    for (const element of elements.current.values()) observer.current.observe(element);
    document.fonts.addEventListener("loadingdone", invalidate);
    return () => {
      observer.current?.disconnect(); observer.current = null;
      document.fonts.removeEventListener("loadingdone", invalidate);
    };
  }, [beforeLayout, root, virtualizer, port]);
  const visible = port === null ? null : dates.find((date, index) => tops[index] + (heights.current.get(date) ?? 320) > port.scrollTop - origin) ?? null;
  return { geometry, measure, admit, dates: slots.map(slot => dates[slot.index]!), tops, height, visible };
}
