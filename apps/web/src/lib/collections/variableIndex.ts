"use client";

import {useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, type RefObject} from "react";
import {defaultRangeExtractor, measureElement, observeElementOffset, useVirtualizer} from "@tanstack/react-virtual";
import type {RankedIndex} from "./measuredIndexWindow";
import {writeScrollPosition} from "./scrollMotion";
import {CompanionScrollMotion, usePaneAnchorGeometry, usePaneScrollMotion, type AnchorGeometry, type AnchorGeometryFrame, type ReturnOrder} from "@/lib/workspace/paneReturnMemento";

type CompanionLanding = {
  port: HTMLElement;
  input: number;
  rank: number;
  line: number;
  order: ReturnOrder;
  release: (() => void) | null;
  proof?: {revision: string; id?: string; unpin?: () => void};
};

export function useVariableIndex({scope, ids: incoming, list, estimate, pinned, ranked: incomingRanked, windowed: requestedWindow, companionRevision}: {
  scope: string;
  ids: readonly string[];
  list: RefObject<HTMLUListElement | null>;
  estimate: number;
  pinned: ReadonlySet<string>;
  ranked?: Omit<RankedIndex, "heads">;
  windowed: boolean;
  companionRevision?: {shown: string | null; live: string | null};
}) {
  const motion = usePaneScrollMotion();
  const companion = useContext(CompanionScrollMotion);
  const position = companionRevision === undefined ? null : companion?.position ?? null;
  const held = motion !== "still";
  const previous = useRef({scope, ids: incoming, ranked: incomingRanked, windowed: requestedWindow});
  const presentation = useMemo(() => {
    const before = previous.current;
    const sameRankedRevision = before.ranked !== undefined && before.ranked.revision === incomingRanked?.revision;
    if (held && before.scope === scope && (before.ranked?.count ?? before.ids.length) > 0 && !sameRankedRevision &&
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
  const landing = useRef<CompanionLanding | null>(null);
  const companionOrder = useRef<(() => void) | undefined>(undefined);
  const leftObservation = useRef<string | undefined>(undefined);
  const wasHeld = useRef(held);
  const [demands, setDemands] = useState<ReadonlyMap<symbol, string>>(() => new Map());
  const demand = useCallback((id: string) => {
    const token = Symbol();
    setDemands(previous => new Map(previous).set(token, id));
    return () => setDemands(previous => {const next = new Map(previous); next.delete(token); return next;});
  }, []);
  const forgetLanding = useCallback(() => {
    const current = landing.current;
    if (current === null) return;
    landing.current = null;
    current.proof?.unpin?.();
    current.release?.();
  }, []);
  useLayoutEffect(() => () => {
    forgetLanding();
    companionOrder.current?.();
    companionOrder.current = undefined;
    leftObservation.current = undefined;
    frame.current = null;
  }, [forgetLanding, scope]);
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
  const mayAdjustCompanion = () => {
    const pending = landing.current;
    return !held && (pending === null || pending.input !== position?.current.input);
  };
  const index = useVirtualizer<HTMLElement, HTMLLIElement>({
    count, enabled: windowed, getScrollElement: getPort,
    anchorTo: origin?.companion && position === null ? "end" : "start",
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
    observeElementOffset(instance, observe) {
      const port = instance.scrollElement;
      if (port !== null) observe(port.scrollTop, false);
      return observeElementOffset(instance, observe);
    },
    scrollToFn(offset, {adjustments = 0, behavior}, instance) {
      const port = instance.scrollElement;
      if (mayAdjustCompanion() && port?.hasAttribute("data-companion-scrollport"))
        writeScrollPosition(port, offset + adjustments, behavior);
    },
  });
  // The pane memento reconciles its own port. A companion measures and corrects its own landing.
  index.shouldAdjustScrollPositionOnItemSizeChange = (slot, _delta, instance) => {
    const port = instance.scrollElement;
    return mayAdjustCompanion() && port?.hasAttribute("data-companion-scrollport") === true && slot.end <= port.scrollTop + 0.5;
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
  const element = useCallback((id: string) => list.current?.querySelector<HTMLElement>(
    `[data-collection-row-id="${CSS.escape(id)}"]`) ?? null, [list]);
  useLayoutEffect(() => {
    const before = frame.current;
    const root = list.current, port = index.scrollElement;
    const order = windowed && root && port ? ranked?.returnOrder : undefined;
    if (position !== null && companionRevision !== undefined) {
      const companionPort = getPort();
      const input = position.current.input;
      const live = companionRevision.live;
      const previous = landing.current;
      if (previous !== null && (held || previous.port !== companionPort || previous.input !== input ||
        previous.release === null && previous.proof?.revision !== live))
        forgetLanding();
      if (!held && landing.current === null && live !== null && live !== before?.observation &&
        before?.returnOrder && before.scrollport === companionPort &&
        (wasHeld.current || leftObservation.current !== before.observation)) {
        leftObservation.current = before.observation;
        const top = (wasHeld.current ? position.current.settledTop ?? companionPort.scrollTop : companionPort.scrollTop) - before.origin;
        const slot = before.landing?.(top, top + companionPort.clientHeight);
        if (slot) landing.current = {port: companionPort, input, rank: slot.rank, line: companionPort.clientTop + slot.offset - top,
          order: before.returnOrder, release: before.returnOrder.retain()};
      }
      if (before?.returnOrder !== order) {
        const retain = order?.retain();
        companionOrder.current?.();
        companionOrder.current = retain;
      }
      const saved = landing.current;
      if (saved !== null && live !== null) {
        if (saved.proof?.revision !== live) {
          saved.proof?.unpin?.();
          const proof: NonNullable<CompanionLanding["proof"]> = {revision: live};
          saved.proof = proof;
          const current = () => landing.current === saved && saved.proof === proof && saved.input === position.current.input;
          void saved.order.land(saved.rank, live, () => true).then(id => {
            if (!current() || id === undefined) return;
            if (id === null) {forgetLanding(); return;}
            proof.id = id;
            proof.unpin = demand(id);
          }, () => {if (current()) forgetLanding();});
        }
        const id = saved.proof.id;
        const row = id === undefined || companionRevision.shown !== live ? null : element(id);
        const box = row?.getBoundingClientRect();
        if (box && box.height > 0) {
          // The admitted row owns the eye line while rich measurements catch up.
          const delta = box.top - saved.port.getBoundingClientRect().top - saved.line;
          if (Math.abs(delta) > 0.5) writeScrollPosition(saved.port, saved.port.scrollTop + delta);
          saved.release?.();
          saved.release = null;
        }
      }
    }
    wasHeld.current = held;
    if (!windowed || !root || !port) {frame.current = null; return;}
    if (revision.current.measurements !== measurements) revision.current = {measurements, count: revision.current.count + 1};
    function rankAt(top: number) {
      let lo = 0, hi = measurements.length;
      while (lo < hi) {
        const middle = (lo + hi) >>> 1;
        if (measurements[middle]!.end - margin <= top) lo = middle + 1;
        else hi = middle;
      }
      return lo;
    }
    frame.current = {revision: revision.current.count, observation: publishedRevision ?? undefined,
      returnOrder: order, root, scrollport: port, origin: margin, anchors: ids,
      firstVisible(top, bottom) {
        for (let rank = rankAt(top); rank < measurements.length; rank++) {
          const offset = measurements[rank]!.start - margin;
          if (offset >= bottom) break;
          const id = idAt(rank);
          if (id !== undefined) return {id, offset};
        }
        return null;
      },
      landing(top, bottom) {
        if (ranked?.returnOrder === undefined) return null;
        const rank = rankAt(top), slot = measurements[rank];
        if (slot === undefined || slot.start - margin >= bottom) return null;
        return {rank, id: idAt(rank), offset: slot.start - margin};
      },
      position(id) {
        const rank = rankOf(id);
        if (rank === undefined) return ranked?.failed ? {kind: "failed"} : {kind: "pending", estimate: null};
        const slot = rank === null ? null : measurements[rank];
        return slot ? {kind: "ready", offset: slot.start - margin} : {kind: "missing"};
      }};
  });
  const geometry = useMemo<AnchorGeometry>(() => ({read: () => frame.current, layoutReady: () => true, demand, element}), [demand, element]);
  usePaneAnchorGeometry({scope, geometry: windowed && position === null ? geometry : null,
    ready: !windowed || ranked?.returnOrder !== undefined || slots.length > 0});
  const viewport = origin !== null && index.range !== null && index.scrollRect !== null
    ? {first: index.range.startIndex, height: index.scrollRect.height} : null;
  return {slots, height, windowed, count, viewport, measure: windowed ? index.measureElement : undefined};
}
