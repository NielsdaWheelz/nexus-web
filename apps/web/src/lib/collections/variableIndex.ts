"use client";

import {useCallback, useLayoutEffect, useMemo, useRef, useState, type RefObject} from "react";
import {defaultRangeExtractor, measureElement, useVirtualizer} from "@tanstack/react-virtual";
import {writeScrollPosition} from "./scrollMotion";
import {usePaneAnchorGeometry, usePaneScrollMotion, type AnchorGeometry, type AnchorGeometryFrame} from "@/lib/workspace/paneReturnMemento";

export function useVariableIndex({scope, ids: incoming, list, estimate, pinned, windowed}: {
  scope: string;
  ids: readonly string[];
  list: RefObject<HTMLUListElement | null>;
  estimate: number;
  pinned: ReadonlySet<string>;
  windowed: boolean;
}) {
  const motion = usePaneScrollMotion();
  const held = motion !== "still";
  const previous = useRef(incoming);
  const ids = useMemo(() => {
    const before = previous.current;
    if (!windowed || !held || before.length === 0 || motion === "travel" &&
      incoming.length > before.length && before.every((id, index) => incoming[index] === id)) return incoming;
    return before;
  }, [incoming, windowed, held, motion]);
  useLayoutEffect(() => {previous.current = ids;}, [ids]);
  const frame = useRef<AnchorGeometryFrame | null>(null);
  const [demands, setDemands] = useState<ReadonlyMap<symbol, string>>(() => new Map());
  const [origin, setOrigin] = useState<number | null>(null);
  const margin = origin ?? 0;
  const byId = useMemo(() => new Map(ids.map((id, rank) => [id, rank])), [ids]);
  const getPort = useCallback(() => {
    for (let node = list.current?.parentElement; node; node = node.parentElement) {
      if (node.matches("[data-pane-content], [data-companion-scrollport]") ||
        node.scrollHeight > node.clientHeight && /^(auto|scroll)$/u.test(getComputedStyle(node).overflowY)) return node;
    }
    return null;
  }, [list]);
  useLayoutEffect(() => {
    if (!windowed) return;
    const root = list.current, port = getPort();
    if (!root || !port) return;
    const read = () => setOrigin(root.getBoundingClientRect().top - port.getBoundingClientRect().top - port.clientTop + port.scrollTop);
    read();
    const resize = new ResizeObserver(read);
    // A preceding section can move the list without resizing the list or its port.
    for (let node: HTMLElement | null = root; node !== null; node = node.parentElement) {
      resize.observe(node);
      if (node === port) break;
    }
    return () => resize.disconnect();
  }, [getPort, ids.length, list, windowed]);

  const index = useVirtualizer<HTMLElement, HTMLLIElement>({
    count: ids.length, enabled: windowed, getScrollElement: getPort,
    getItemKey: rank => ids[rank]!, estimateSize: () => estimate, scrollMargin: margin, overscan: 4,
    rangeExtractor(range) {
      const ranks = new Set(defaultRangeExtractor(range));
      for (const id of [...pinned, ...demands.values()]) {
        const rank = byId.get(id);
        if (rank !== undefined) ranks.add(rank);
      }
      return [...ranks].sort((a, b) => a - b);
    },
    measureElement: (element, entry, instance) => held
      ? instance.itemSizeCache.get(ids[instance.indexFromElement(element)]!) ?? estimate
      : measureElement(element, entry, instance),
    scrollToFn(offset, {adjustments}, instance) {
      const port = instance.scrollElement;
      if (adjustments !== undefined && port?.hasAttribute("data-companion-scrollport")) writeScrollPosition(port, offset + adjustments);
    },
  });
  // The pane memento reconciles its own port. A companion measures and corrects its own landing.
  index.shouldAdjustScrollPositionOnItemSizeChange = (slot, _delta, instance) => {
    const port = instance.scrollElement;
    return !held && port?.hasAttribute("data-companion-scrollport") === true && slot.end <= port.scrollTop + 0.5;
  };
  const slots = windowed ? index.getVirtualItems().map(slot => ({
    id: ids[slot.index]!, rank: slot.index, top: slot.start - margin, size: held ? slot.size : undefined,
  })) : ids.map((id, rank) => ({id, rank, top: undefined, size: undefined}));
  const height = windowed ? index.getTotalSize() : undefined;
  const measurements = index.measurementsCache;
  const revision = useRef({measurements, count: 0});
  useLayoutEffect(() => {
    const root = list.current, port = index.scrollElement;
    if (!windowed || !root || !port) {frame.current = null; return;}
    if (revision.current.measurements !== measurements) revision.current = {measurements, count: revision.current.count + 1};
    frame.current = {revision: revision.current.count, root, scrollport: port, origin: margin, anchors: ids,
      firstVisible(top, bottom) {
        let lo = 0, hi = measurements.length;
        while (lo < hi) {
          const middle = (lo + hi) >>> 1;
          if (measurements[middle]!.end - margin <= top) lo = middle + 1;
          else hi = middle;
        }
        const item = measurements[lo];
        return item && item.start - margin < bottom ? {id: ids[lo]!, offset: item.start - margin} : null;
      },
      position(id) {
        const rank = byId.get(id);
        const slot = rank === undefined ? null : measurements[rank];
        return slot ? {kind: "ready", offset: slot.start - margin} : {kind: "missing"};
      }};
  });
  const geometry = useMemo<AnchorGeometry>(() => ({
    read: () => frame.current,
    layoutReady: () => true,
    demand(id) {
      const token = Symbol();
      setDemands(previous => new Map(previous).set(token, id));
      return () => setDemands(previous => {const next = new Map(previous); next.delete(token); return next;});
    },
    element: id => list.current?.querySelector<HTMLElement>(`[data-collection-row-id="${CSS.escape(id)}"]`) ?? null,
    refreshRange: () => index.getVirtualItems(),
  }), [index, list]);
  usePaneAnchorGeometry({scope, geometry: windowed ? geometry : null, ready: !windowed || slots.length > 0});
  const viewport = origin !== null && index.range !== null && index.scrollRect !== null
    ? {first: index.range.startIndex, height: index.scrollRect.height} : null;
  return {slots, height, count: ids.length, viewport, measure: windowed ? index.measureElement : undefined};
}
