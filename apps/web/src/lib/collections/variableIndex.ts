"use client";

import {useCallback, useLayoutEffect, useMemo, useRef, useState, type RefObject} from "react";
import {defaultRangeExtractor, measureElement, useVirtualizer} from "@tanstack/react-virtual";
import type {RankedIndex} from "./measuredIndexWindow";
import {writeScrollPosition} from "./scrollMotion";
import {usePaneAnchorGeometry, usePaneScrollMotion, type AnchorGeometry, type AnchorGeometryFrame} from "@/lib/workspace/paneReturnMemento";

export function useVariableIndex({scope, ids: incoming, list, estimate, pinned, ranked: incomingRanked, windowed: requestedWindow}: {
  scope: string;
  ids: readonly string[];
  list: RefObject<HTMLUListElement | null>;
  estimate: number;
  pinned: ReadonlySet<string>;
  ranked?: Omit<RankedIndex, "heads">;
  windowed: boolean;
}) {
  const motion = usePaneScrollMotion();
  const held = motion !== "still";
  const previous = useRef({scope, ids: incoming, ranked: incomingRanked, windowed: requestedWindow});
  const presentation = useMemo(() => {
    const before = previous.current;
    const sameRankedRevision = before.ranked !== undefined && before.ranked.revision === incomingRanked?.revision;
    if (held && before.scope === scope && before.ids.length > 0 && !sameRankedRevision &&
      !(motion === "travel" && before.ranked === undefined && incomingRanked === undefined &&
        incoming.length > before.ids.length && before.ids.every((id, rank) => incoming[rank] === id))) {
      return before;
    }
    return {scope, ids: incoming, ranked: incomingRanked, windowed: requestedWindow};
  }, [scope, incoming, incomingRanked, requestedWindow, held, motion]);
  const {ids, ranked, windowed} = presentation;
  const count = ranked?.count ?? ids.length;
  useLayoutEffect(() => {previous.current = presentation;}, [presentation]);
  const frame = useRef<AnchorGeometryFrame | null>(null);
  const [demands, setDemands] = useState<ReadonlyMap<symbol, string>>(() => new Map());
  const [origin, setOrigin] = useState<{offset: number; companion: boolean} | null>(null);
  const margin = origin?.offset ?? 0;
  const keyIds = ranked === undefined ? ids : null;
  const byId = useMemo(() => new Map(keyIds?.map((id, rank) => [id, rank])), [keyIds]);
  const rankOf = ranked?.rankOf ?? ((id: string) => byId.get(id) ?? null);
  const idAt = ranked?.idAt ?? ((rank: number) => ids[rank]);
  const pins = [...pinned, ...demands.values()];
  const getPort = useCallback(() =>
    list.current?.closest<HTMLElement>("[data-pane-content], [data-companion-scrollport]") ?? null, [list]);
  useLayoutEffect(() => {
    if (!windowed) return;
    const root = list.current, port = getPort();
    if (!root || !port) return;
    const companion = port.hasAttribute("data-companion-scrollport");
    const read = () => {
      const offset = root.getBoundingClientRect().top - port.getBoundingClientRect().top - port.clientTop + port.scrollTop;
      setOrigin(previous => previous?.offset === offset && previous.companion === companion ? previous : {offset, companion});
    };
    read();
    const resize = new ResizeObserver(read);
    // A preceding section can move the list without resizing the list or its port.
    for (let node: HTMLElement | null = root; node !== null; node = node.parentElement) {
      resize.observe(node);
      if (node === port) break;
    }
    return () => resize.disconnect();
  }, [getPort, count, list, windowed]);

  const getItemKey = useCallback((rank: number) => keyIds?.[rank] ?? rank, [keyIds]);
  const index = useVirtualizer<HTMLElement, HTMLLIElement>({
    count, enabled: windowed, getScrollElement: getPort,
    anchorTo: origin?.companion ? "end" : "start",
    getItemKey, estimateSize: () => estimate, scrollMargin: margin, overscan: 4,
    rangeExtractor(range) {
      const ranks = new Set(defaultRangeExtractor(range));
      for (const id of pins) {
        const rank = rankOf(id);
        if (rank != null) ranks.add(rank);
      }
      return [...ranks].sort((a, b) => a - b);
    },
    measureElement: (element, entry, instance) => held
      ? instance.itemSizeCache.get(getItemKey(instance.indexFromElement(element))) ?? estimate
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
  const virtual = windowed ? index.getVirtualItems() : [];
  const slots = windowed ? virtual.flatMap(slot => {
    const id = idAt(slot.index);
    return id === undefined ? [] : [{id, rank: slot.index, top: slot.start - margin, size: held ? slot.size : undefined}];
  }) : ids.map((id, rank) => ({id, rank, top: undefined, size: undefined}));
  useLayoutEffect(() => { ranked?.request(virtual.map(slot => slot.index), pins); });
  const publishedRevision = ranked?.revision ?? null;
  const measuredRevision = useRef(publishedRevision);
  useLayoutEffect(() => {
    const previous = measuredRevision.current;
    measuredRevision.current = publishedRevision;
    if (previous === null || publishedRevision === null || previous === publishedRevision) return;
    index.measure();
    for (const row of list.current?.querySelectorAll<HTMLLIElement>(":scope > li[data-index]") ?? []) {
      index.resizeItem(index.indexFromElement(row), row.offsetHeight);
    }
  }, [index, list, publishedRevision]);
  const height = windowed ? index.getTotalSize() : undefined;
  const measurements = index.measurementsCache;
  const revision = useRef({measurements, count: 0});
  useLayoutEffect(() => {
    const root = list.current, port = index.scrollElement;
    if (!windowed || !root || !port) {frame.current = null; return;}
    if (revision.current.measurements !== measurements) revision.current = {measurements, count: revision.current.count + 1};
    frame.current = {revision: revision.current.count, observation: publishedRevision ?? undefined, root, scrollport: port, origin: margin, anchors: ids,
      firstVisible(top, bottom) {
        let lo = 0, hi = measurements.length;
        while (lo < hi) {
          const middle = (lo + hi) >>> 1;
          if (measurements[middle]!.end - margin <= top) lo = middle + 1;
          else hi = middle;
        }
        for (let rank = lo; rank < measurements.length; rank++) {
          const offset = measurements[rank]!.start - margin;
          if (offset >= bottom) break;
          const id = idAt(rank);
          if (id !== undefined) return {id, offset};
        }
        return null;
      },
      position(id) {
        const rank = rankOf(id);
        if (rank === undefined) return ranked?.failed ? {kind: "failed"} : {kind: "pending", estimate: null};
        const slot = rank === null ? null : measurements[rank];
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
  }), [list]);
  usePaneAnchorGeometry({scope, geometry: windowed ? geometry : null, ready: !windowed || slots.length > 0});
  const viewport = origin !== null && index.range !== null && index.scrollRect !== null
    ? {first: index.range.startIndex, height: index.scrollRect.height} : null;
  return {slots, height, windowed, count, viewport, measure: windowed ? index.measureElement : undefined};
}
