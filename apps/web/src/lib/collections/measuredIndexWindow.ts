"use client";

/** Large, explicitly uniform index rows. CSS owns equal row geometry; one actual
 * border box supplies its fractional height. This owner measures and mounts sparse
 * ranks only. Pane mementos own scrolling, anchors and focus recovery. */
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";
import { windowRange, windowRanks } from "./collectionWindow";

export const INDEX_WINDOW_THRESHOLD = 200;
export type IndexGeometry = "UniformIndex";
export interface IndexWindowSlot {
  readonly id: string;
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
  readonly epoch: number;
  readonly height: number;
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
interface View {
  readonly scopeKey: string;
  readonly height: number;
  readonly width: number;
  readonly epoch: number;
  readonly start: number;
  readonly end: number;
}
interface Committed {
  readonly geometry: IndexGeometry | null;
  readonly scopeKey: string;
  readonly ids: readonly string[];
  readonly byId: ReadonlyMap<string, number>;
  readonly list: HTMLUListElement | null;
  readonly port: HTMLElement | null;
  readonly view: View | null;
}

function neighbors(ids: readonly string[], index: number): readonly string[] {
  return ids.slice(Math.max(0, index - 1), index + 2);
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

export function useMeasuredIndexWindow({ scopeKey, ids, geometry, listRef, scrollport }: {
  readonly scopeKey: string;
  readonly ids: readonly string[];
  readonly geometry: IndexGeometry | null;
  readonly listRef: RefObject<HTMLUListElement | null>;
  readonly scrollport: () => HTMLElement | null;
}): MeasuredIndexWindow {
  const enabled = geometry === "UniformIndex" && ids.length > INDEX_WINDOW_THRESHOLD;
  const byId = useMemo(() => new Map(ids.map((id, index) => [id, index])), [ids]);
  const [view, setView] = useState<View | null>(null);
  const [demand, setDemand] = useState<Demand>({ scopeKey, sticky: null, pins: new Map() });
  const committed = useRef<Committed | null>(null);
  const work = useRef<((height: number | null) => void) | null>(null);
  const sample = useRef<HTMLElement | null>(null);
  const observer = useRef<ResizeObserver | null>(null);
  const activeView = enabled && view?.scopeKey === scopeKey ? view : null;
  const previous = committed.current;
  const pinnedRanks: number[] = [];
  const retainedRanks: number[] = [];
  if (demand.scopeKey === scopeKey) {
    const held = [...demand.pins.values(), ...(demand.sticky === null ? [] : [demand.sticky])];
    for (const row of held) {
      const id = surviving(row, previous?.scopeKey === scopeKey ? previous.ids : ids, byId);
      if (id !== null) pinnedRanks.push(byId.get(id)!);
      // Original neighbors survive a same-view removal; current neighbors are
      // added by windowRanks. No publication accumulates a trail of old neighbors.
      for (const neighbor of row.neighbors) {
        const index = byId.get(neighbor);
        if (index !== undefined) retainedRanks.push(index);
      }
    }
  }
  let plan: IndexWindowPlan;
  if (!enabled) {
    plan = { kind: "Intrinsic", slots: ids.map((id, index) => ({ id, index, gapBeforePx: 0 })) };
  } else if (activeView === null) {
    plan = { kind: "Measure", sampleId: ids[0] };
  } else {
    const ranks = windowRanks({ start: Math.min(activeView.start, ids.length), end: Math.min(activeView.end, ids.length),
      count: ids.length, pinnedRanks, retainedRanks });
    const slots = ranks.rows.map(({ index, gap }) => ({ id: ids[index], index, gapBeforePx: gap * activeView.height }));
    plan = { kind: "Ready", epoch: activeView.epoch, height: activeView.height, slots,
      tailGapPx: (ids.length - (slots.at(-1)?.index ?? -1) - 1) * activeView.height,
      totalHeight: ids.length * activeView.height };
  }

  const interact = useCallback((id: string) => {
    const current = committed.current;
    const index = current?.byId.get(id);
    if (current === null || current.geometry === null || current.ids.length <= INDEX_WINDOW_THRESHOLD || index === undefined) return;
    const sticky = { id, neighbors: neighbors(current.ids, index) };
    setDemand(before => before.scopeKey === current.scopeKey && before.sticky?.id === id ? before : {
      scopeKey: current.scopeKey, sticky, pins: before.scopeKey === current.scopeKey ? before.pins : new Map(),
    });
  }, []);
  const pin = useCallback((id: string) => {
    const current = committed.current;
    const index = current?.byId.get(id);
    if (current === null || current.geometry === null || current.ids.length <= INDEX_WINDOW_THRESHOLD || index === undefined) return () => {};
    const token = Symbol();
    setDemand(before => ({ scopeKey: current.scopeKey,
      sticky: before.scopeKey === current.scopeKey ? before.sticky : null,
      pins: new Map(before.scopeKey === current.scopeKey ? before.pins : []).set(token, { id, neighbors: neighbors(current.ids, index) }),
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
    if (current === null || current.view === null || current.list === null || current.port === null) return null;
    const { list, port, view: measured } = current;
    return { scopeKey: current.scopeKey, ids: current.ids, epoch: measured.epoch, height: measured.height, list,
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
        const id = surviving(row, previous?.scopeKey === scopeKey ? previous.ids : ids, byId);
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
    committed.current = { geometry, scopeKey, ids, byId, list, port, view: activeView };
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
    work.current = height => {
      const current = committed.current;
      if (!enabled || current?.list !== list || list === null || port === null || sample.current === null) return;
      const measuredHeight = height ?? current.view?.height ?? null;
      if (measuredHeight === null || measuredHeight <= 0 || port.clientHeight === 0) return;
      const listTop = list.getBoundingClientRect().top - port.getBoundingClientRect().top - port.clientTop + port.scrollTop;
      const bounds = windowRange({ top: port.scrollTop - listTop, viewport: port.clientHeight,
        height: measuredHeight, count: ids.length });
      setView(before => {
        const sameScope = before?.scopeKey === scopeKey;
        const sameGeometry = sameScope && before.height === measuredHeight && before.width === list.clientWidth;
        if (sameGeometry && before.start === bounds.start && before.end === bounds.end) return before;
        return { scopeKey, height: measuredHeight, width: list.clientWidth,
          epoch: sameGeometry ? before.epoch : (before?.epoch ?? 0) + 1, ...bounds };
      });
    };
    work.current(null);
  });

  useLayoutEffect(() => {
    const port = committed.current?.port;
    const list = listRef.current;
    if (!enabled || port === null || port === undefined || list === null) return;
    let frame: number | null = null;
    const resize = new ResizeObserver(changes => {
      const row = changes.find(change => change.target === sample.current);
      // Publication runs through React's normal scheduling, outside this resize
      // broadcast; Measure -> Ready changes the observed list's own height.
      work.current?.(row?.borderBoxSize[0]?.blockSize ?? null);
    });
    observer.current = resize;
    resize.observe(port);
    resize.observe(list);
    if (sample.current !== null) resize.observe(sample.current);
    const scroll = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        flushSync(() => work.current?.(null));
      });
    };
    port.addEventListener("scroll", scroll, { passive: true });
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      port.removeEventListener("scroll", scroll);
      resize.disconnect();
      observer.current = null;
    };
  }, [enabled, scopeKey, listRef, scrollport]);
  useLayoutEffect(() => () => { committed.current = null; work.current = null; }, []);
  return { plan, interact, pin, rowElement, readGeometry, refreshRange };
}
