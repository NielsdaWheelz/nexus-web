"use client";

/** Large, explicitly uniform index rows. CSS owns equal row geometry; one actual
 * border box supplies its fractional height. This owner measures and mounts sparse
 * ranks only. Pane mementos own scrolling, anchors and focus recovery. */
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { windowRange, windowRanks } from "./collectionWindow";
import { scrollFrame } from "./scrollFrame";

import type { ReturnOrder } from "@/lib/workspace/paneReturnMemento";

export const INDEX_WINDOW_THRESHOLD = 200;
export type IndexGeometry = "UniformIndex";
/** A complete extent, with identities materialized only for the demanded ranks.
 * An unknown rank resolves on demand; a null rank is a proved absence. */
export interface RankedIndex {
  readonly count: number;
  readonly revision: string;
  readonly failed: boolean;
  readonly heads: ReadonlyMap<number, string>;
  readonly returnOrder?: ReturnOrder;
  idAt(rank: number): string | undefined;
  rankOf(id: string): number | null | undefined;
  request(ranks: readonly number[], ids: readonly string[]): void;
}
export interface IndexWindowSlot {
  readonly id: string | undefined;
  readonly headId: string | undefined;
  readonly index: number;
  readonly gapBeforePx: number;
}
export type IndexWindowPlan =
  | { readonly kind: "Intrinsic"; readonly slots: readonly IndexWindowSlot[] }
  | { readonly kind: "Measure"; readonly sampleId: string }
  | { readonly kind: "Ready"; readonly epoch: number; readonly height: number;
      readonly slots: readonly IndexWindowSlot[]; readonly tailGapPx: number; readonly totalHeight: number };
export interface IndexWindowFrame {
  readonly scopeKey: string;
  readonly ids: readonly string[];
  readonly count: number;
  readonly revision: string | null;
  readonly returnOrder?: ReturnOrder;
  readonly failed: boolean;
  idAt(rank: number): string | undefined;
  readonly epoch: number;
  readonly height: number;
  readonly totalHeight: number;
  rowTop(index: number): number;
  rankAt(top: number): number;
  position(id: string): number | null | undefined;
  readonly list: HTMLUListElement;
  readonly scrollport: HTMLElement;
  /** Origin in the owning scrollport's content coordinates, read from current layout. */
  readonly listTop: number;
}
export interface MeasuredIndexWindow {
  readonly plan: IndexWindowPlan;
  readonly interact: (id: string) => void;
  readonly pin: (id: string) => () => void;
  readonly rowElement: (id: string) => HTMLElement | null;
  readonly refreshRange: () => void;
  readonly readGeometry: () => IndexWindowFrame | null;
}
interface HeldRow {
  readonly id: string;
  readonly neighbors: readonly string[];
}
interface Demand {
  readonly scopeKey: string;
  readonly sticky: HeldRow | null;
  readonly pins: ReadonlyMap<symbol, HeldRow>;
}
interface Extent {
  readonly totalHeight: number;
  rowTop(index: number): number;
  rankAt(top: number): number;
}
interface View {
  readonly scopeKey: string;
  readonly height: number;
  readonly headHeights: ReadonlyMap<string, number>;
  readonly width: number;
  readonly epoch: number;
  readonly start: number;
  readonly end: number;
}
interface Committed {
  readonly geometry: IndexGeometry | null;
  readonly scopeKey: string;
  readonly ids: readonly string[];
  readonly count: number;
  readonly rankOf: RankedIndex["rankOf"];
  readonly idAt: RankedIndex["idAt"];
  readonly revision: string | null;
  readonly returnOrder?: ReturnOrder;
  readonly failed: boolean;
  readonly list: HTMLUListElement | null;
  readonly port: HTMLElement | null;
  readonly view: View | null;
  readonly headIds: readonly string[];
  readonly extent: Extent | null;
}

function indexExtent(count: number, height: number, heads: ReadonlyMap<number, string>,
  headHeights: ReadonlyMap<string, number>): Extent {
  let headHeight = 0;
  const heights = [...heads].map(([rank, id]) => {
    headHeight += headHeights.get(id) ?? 0;
    return {rank, height: headHeight};
  });
  const rowTop = (index: number) => {
    let start = 0;
    let end = heights.length;
    while (start < end) {
      const middle = Math.floor((start + end) / 2);
      if (heights[middle].rank <= index) start = middle + 1;
      else end = middle;
    }
    return index * height + (heights[start - 1]?.height ?? 0);
  };
  return {
    totalHeight: count * height + headHeight, rowTop,
    rankAt(top) {
      if (heights.length === 0) return Math.max(0, Math.min(count, Math.floor(top / height)));
      let start = 0;
      let end = count;
      while (start < end) {
        const middle = Math.floor((start + end) / 2);
        if (rowTop(middle) + height <= top) start = middle + 1;
        else end = middle;
      }
      return start;
    },
  };
}

function neighbors(idAt: RankedIndex["idAt"], index: number | null | undefined): readonly string[] {
  if (index == null) return [];
  return [idAt(index - 1), idAt(index), idAt(index + 1)].filter(id => id !== undefined);
}

/** A removed owner advances through its previous full order, never through the
 * mounted subset. This is also how a sticky dialog source preserves its successor. */
function surviving(row: HeldRow, before: readonly string[], byId: ReadonlyMap<string, number>): string | null {
  if (byId.has(row.id)) return row.id;
  for (let index = before.indexOf(row.id) + 1; index < before.length; index += 1) {
    if (byId.has(before[index])) return before[index];
  }
  return null;
}

export function useMeasuredIndexWindow({ scopeKey, ids, headIds, ranked, hold, geometry, listRef, scrollport }: {
  readonly scopeKey: string;
  readonly ids: readonly string[];
  readonly headIds: readonly string[];
  readonly ranked?: RankedIndex;
  readonly hold: boolean;
  readonly geometry: IndexGeometry | null;
  readonly listRef: RefObject<HTMLUListElement | null>;
  readonly scrollport: () => HTMLElement | null;
}): MeasuredIndexWindow {
  const count = ranked?.count ?? ids.length;
  const enabled = geometry === "UniformIndex" && count > INDEX_WINDOW_THRESHOLD;
  const sparse = ranked !== undefined;
  const byId = useMemo(() => new Map(sparse ? [] : ids.map((id, index) => [id, index])), [ids, sparse]);
  const rankOf: RankedIndex["rankOf"] = ranked?.rankOf ?? (id => byId.get(id) ?? null);
  const idAt: RankedIndex["idAt"] = ranked?.idAt ?? (index => ids[index]);
  const heads = useMemo(() => ranked?.heads ?? new Map(headIds.map(id => [byId.get(id)!, id])),
    [ranked?.heads, byId, headIds]);
  const [view, setView] = useState<View | null>(null);
  const [demand, setDemand] = useState<Demand>({ scopeKey, sticky: null, pins: new Map() });
  const committed = useRef<Committed | null>(null);
  const work = useRef<((height: number | null, measureHeads?: boolean) => void) | null>(null);
  const sample = useRef<HTMLElement | null>(null);
  const observer = useRef<ResizeObserver | null>(null);
  const headSamples = useRef<HTMLElement[]>([]);
  const activeView = enabled && view?.scopeKey === scopeKey ? view : null;
  const height = activeView?.height ?? null;
  const headHeights = activeView?.headHeights ?? null;
  const extent = useMemo(() => height === null || headHeights === null ? null :
    indexExtent(count, height, heads, headHeights), [count, height, heads, headHeights]);
  const previous = committed.current;
  const pinnedRanks: number[] = [];
  const retainedRanks: number[] = [];
  const wantedIds = new Set<string>();
  const retainedId = (row: HeldRow) => {
    if (ranked === undefined) return surviving(row, previous?.scopeKey === scopeKey ? previous.ids : ids, byId);
    wantedIds.add(row.id);
    for (const id of row.neighbors) wantedIds.add(id);
    return row.id;
  };
  if (demand.scopeKey === scopeKey) {
    const held = [...demand.pins.values(), ...(demand.sticky === null ? [] : [demand.sticky])];
    for (const row of held) {
      const id = retainedId(row);
      const rank = id === null ? null : rankOf(id);
      if (rank != null) pinnedRanks.push(rank);
      // Original neighbors survive a same-view removal; current neighbors are
      // added by windowRanks. No publication accumulates a trail of old neighbors.
      for (const neighbor of row.neighbors) {
        const index = rankOf(neighbor);
        if (index != null) retainedRanks.push(index);
      }
    }
  }
  let plan: IndexWindowPlan;
  let wantedRanks: readonly number[] = [];
  if (!enabled) {
    plan = { kind: "Intrinsic", slots: ids.map((id, index) => ({ id, index, headId: heads.get(index), gapBeforePx: 0 })) };
  } else if (activeView === null || extent === null) {
    plan = { kind: "Measure", sampleId: idAt(0) ?? ids[0] };
  } else {
    const ranks = windowRanks({ start: Math.min(activeView.start, count), end: Math.min(activeView.end, count),
      count, pinnedRanks, retainedRanks });
    wantedRanks = ranks.demand;
    let paintedEnd = 0;
    const slots = ranks.rows.map(({ index }) => {
      const id = idAt(index), headId = heads.get(index);
      const top = extent.rowTop(index);
      const headHeight = headId === undefined ? 0 : activeView.headHeights.get(headId) ?? 0;
      const gapBeforePx = Math.max(0, top - headHeight - paintedEnd);
      paintedEnd = top + activeView.height;
      return { id, headId, index, gapBeforePx };
    });
    plan = { kind: "Ready", epoch: activeView.epoch, height: activeView.height, slots,
      tailGapPx: Math.max(0, extent.totalHeight - paintedEnd), totalHeight: extent.totalHeight };
  }

  const interact = useCallback((id: string) => {
    const current = committed.current;
    const index = current?.rankOf(id);
    if (current === null || current.geometry === null || current.count <= INDEX_WINDOW_THRESHOLD || index == null) return;
    const sticky = { id, neighbors: neighbors(current.idAt, index) };
    setDemand(before => before.scopeKey === current.scopeKey && before.sticky?.id === id ? before : {
      scopeKey: current.scopeKey, sticky, pins: before.scopeKey === current.scopeKey ? before.pins : new Map(),
    });
  }, []);
  const pin = useCallback((id: string) => {
    const current = committed.current;
    const index = current?.rankOf(id);
    if (current === null || current.geometry === null || current.count <= INDEX_WINDOW_THRESHOLD || index === null) return () => {};
    const token = Symbol();
    setDemand(before => ({ scopeKey: current.scopeKey,
      sticky: before.scopeKey === current.scopeKey ? before.sticky : null,
      pins: new Map(before.scopeKey === current.scopeKey ? before.pins : []).set(token, { id, neighbors: neighbors(current.idAt, index) }),
    }));
    return () => setDemand(before => {
      if (!before.pins.has(token)) return before;
      const pins = new Map(before.pins);
      pins.delete(token);
      return { ...before, pins };
    });
  }, []);
  const refreshRange = useCallback(() => work.current?.(null), []);
  const rowElement = useCallback((id: string) => {
    const list = committed.current?.list;
    if (!list?.isConnected) return null;
    for (const row of list.querySelectorAll<HTMLElement>("[data-collection-row-id]")) {
      if (row.dataset.collectionRowId === id) return row;
    }
    return null;
  }, []);
  const readGeometry = useCallback((): IndexWindowFrame | null => {
    const current = committed.current;
    if (current === null || current.view === null || current.extent === null || current.list === null || current.port === null) return null;
    const { list, port, extent, view: measured, rankOf, idAt, count, revision, returnOrder, failed } = current;
    return { ...extent, scopeKey: current.scopeKey, ids: current.ids, idAt, count, revision, returnOrder, failed, epoch: measured.epoch, height: measured.height, list,
      position(id) {
        const index = rankOf(id);
        return index == null ? index : extent.rowTop(index);
      },
      scrollport: port, listTop: list.getBoundingClientRect().top - port.getBoundingClientRect().top - port.clientTop + port.scrollTop };
  }, []);

  // Ordinary/sortable markup can replace the list ref without changing inputs.
  // Rebind each committed node; unchanged demand/geometry setters retain state.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const list = listRef.current;
    const port = enabled ? scrollport() : null;
    if (!enabled) setView(null);
    setDemand(before => {
      if (before.scopeKey !== scopeKey) return { scopeKey, sticky: null, pins: new Map() };
      const normalize = (row: HeldRow): HeldRow | null => {
        const id = retainedId(row);
        return id === null ? null : id === row.id ? row : { ...row, id };
      };
      const sticky = before.sticky === null ? null : normalize(before.sticky);
      const pins = new Map<symbol, HeldRow>();
      let changed = sticky !== before.sticky;
      for (const [token, row] of before.pins) {
        const retained = normalize(row);
        if (retained !== row) changed = true;
        if (retained !== null) pins.set(token, retained);
      }
      return changed ? { scopeKey, sticky, pins } : before;
    });
    committed.current = { geometry, scopeKey, ids, count, idAt, rankOf, revision: ranked?.revision ?? null, returnOrder: ranked?.returnOrder, failed: ranked?.failed ?? false,
      list, port, view: activeView, headIds, extent };
    ranked?.request(wantedRanks, [...wantedIds]);
    if (previous?.list !== list) {
      if (previous?.list) observer.current?.unobserve(previous.list);
      if (list !== null) observer.current?.observe(list);
    }
    const nextSample = enabled ? list?.querySelector<HTMLElement>("[data-collection-row-id]") ?? null : null;
    if (sample.current !== nextSample) {
      if (sample.current !== null) observer.current?.unobserve(sample.current);
      sample.current = nextSample;
      if (nextSample !== null) observer.current?.observe(nextSample);
    }
    if (previous?.list !== list || previous.headIds !== headIds || (previous.port === null) !== (port === null)) {
      const samples = enabled && list !== null
        ? [...list.querySelectorAll<HTMLElement>("[data-index-head-sample]")] : [];
      const next = new Set(samples), before = new Set(headSamples.current);
      for (const element of before) if (!next.has(element)) observer.current?.unobserve(element);
      for (const element of next) if (!before.has(element)) observer.current?.observe(element);
      headSamples.current = samples;
    }
    work.current = (measuredHeight, measureHeads = false) => {
      const current = committed.current;
      if (!enabled || current?.list !== list || list === null || port === null || sample.current === null) return;
      const rowHeight = hold && current.view !== null ? current.view.height :
        measuredHeight ?? current.view?.height ?? sample.current.getBoundingClientRect().height;
      if (rowHeight <= 0 || port.clientHeight === 0) return;
      const previousHeads = current.view?.headHeights ?? null;
      let measured = previousHeads ?? new Map<string, number>();
      if (!hold && measureHeads || previousHeads === null || previous?.headIds !== headIds) {
        const next = new Map(headSamples.current.map(element => [element.dataset.indexHeadSample!, element.getBoundingClientRect().height]));
        if (next.size !== headIds.length || headIds.some(id => !next.has(id))) return;
        if (previousHeads === null || next.size !== previousHeads.size || [...next].some(([id, size]) => previousHeads.get(id) !== size)) {
          measured = next;
        }
      }
      const currentExtent = current.extent !== null && previousHeads === measured && rowHeight === current.view?.height
        ? current.extent : indexExtent(count, rowHeight, heads, measured);
      const listTop = list.getBoundingClientRect().top - port.getBoundingClientRect().top - port.clientTop + port.scrollTop;
      const top = port.scrollTop - listTop;
      const viewport = port.clientHeight;
      const bounds = measured.size === 0 ? windowRange({ top, viewport, height: rowHeight, count })
        : { start: currentExtent.rankAt(top - viewport), end: Math.min(count, currentExtent.rankAt(top + 2 * viewport) + 1) };
      setView(before => {
        const sameScope = before?.scopeKey === scopeKey;
        const sameGeometry = sameScope && before.height === rowHeight && before.width === list.clientWidth && before.headHeights === measured;
        if (sameGeometry && before.start === bounds.start && before.end === bounds.end) return before;
        return { scopeKey, height: rowHeight, headHeights: measured, width: list.clientWidth,
          epoch: sameGeometry ? before.epoch : (before?.epoch ?? 0) + 1, ...bounds };
      });
    };
    work.current(null);
  });

  useLayoutEffect(() => {
    const port = committed.current?.port;
    const list = listRef.current;
    if (!enabled || port === null || port === undefined || list === null) return;
    const resize = new ResizeObserver(changes => {
      const row = changes.find(change => change.target === sample.current);
      // Publication runs through React's normal scheduling, outside this resize
      // broadcast; Measure -> Ready changes the observed list's own height.
      work.current?.(row?.borderBoxSize[0]?.blockSize ?? null, true);
    });
    observer.current = resize;
    resize.observe(port);
    resize.observe(list);
    if (sample.current !== null) resize.observe(sample.current);
    for (const element of headSamples.current) resize.observe(element);
    const frame = scrollFrame([port], () => work.current?.(null));
    return () => {
      frame.stop();
      resize.disconnect();
      observer.current = null;
    };
  }, [enabled, scopeKey, listRef, scrollport]);
  useLayoutEffect(() => () => { committed.current = null; work.current = null; }, []);
  return { plan, interact, pin, rowElement, readGeometry, refreshRange };
}
