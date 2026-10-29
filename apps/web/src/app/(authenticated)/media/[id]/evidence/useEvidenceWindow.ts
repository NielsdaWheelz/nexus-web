"use client";

// Geometry for this pane's root occurrences only. Data, folds and editors stay
// with their existing owners; gaps never instantiate a resource row.
import {useCallback, useLayoutEffect, useRef, useState, type RefObject} from "react";
import {flushSync} from "react-dom";

export interface EvidenceSlot {key: string; estimate: number}
interface Anchor {key: string; offset: number}

export function useEvidenceWindow({scope, slots, aligned, placements, demand, focused, root, port, outer}: {
  scope: string | null;
  slots: readonly EvidenceSlot[];
  aligned: boolean;
  placements: readonly string[];
  demand: string | null;
  focused: string | null;
  root: RefObject<HTMLDivElement | null>;
  port: RefObject<HTMLDivElement | null>;
  outer: RefObject<HTMLDivElement | null>;
}) {
  const [pins, setPins] = useState<ReadonlyMap<symbol, string>>(() => new Map());
  const [sticky, setSticky] = useState<string | null>(null);
  const [selection, setSelection] = useState<readonly string[]>([]);
  const [frame, setFrame] = useState({top: 0, bottom: 900, revision: 0});
  const geometry = useRef({scope, metrics: "", heights: new Map<string, number>()});
  const anchor = useRef<Anchor | null>(null);
  const correction = useRef<Anchor | null>(null);
  const previous = useRef(slots);
  const held = new Set([...pins.values(), ...selection, ...[focused, demand, sticky, ...(aligned ? [] : [anchor.current?.key ?? null])].filter(key => key !== null)]);
  const heights = geometry.current.scope === scope ? geometry.current.heights : new Map<string, number>();
  const offsets = [0];
  for (const slot of slots) offsets.push(offsets.at(-1)! + (slot.estimate === 0 ? 0 : heights.get(slot.key) ?? slot.estimate));
  const admitted = new Set(aligned ? placements : []);
  let gap = 0;
  const rendered: {key: string; gap: number}[] = [];
  for (let index = 0; index < slots.length; index++) {
    const slot = slots[index];
    // One viewport above and below amortizes remounts without admitting detail owners.
    if (held.has(slot.key) || slot.estimate > 0 && offsets[index + 1] >= frame.top - (frame.bottom - frame.top) && offsets[index] <= frame.bottom + (frame.bottom - frame.top)) {
      admitted.add(slot.key);
    }
    if (admitted.has(slot.key)) {rendered.push({key: slot.key, gap}); gap = 0;}
    else gap += offsets[index + 1] - offsets[index];
  }
  const interact = useCallback((key: string) => setSticky(key), []);
  const pin = useCallback((key: string) => {
    const token = Symbol();
    setPins(current => new Map(current).set(token, key));
    return () => setPins(current => {const next = new Map(current); next.delete(token); return next;});
  }, []);
  const capture = useCallback(() => {
    const list = root.current, scroll = port.current, outside = outer.current;
    if (!list || !scroll || !outside || aligned) return;
    const top = Math.max(scroll.getBoundingClientRect().top, outside.getBoundingClientRect().top);
    const row = [...list.querySelectorAll<HTMLElement>("[data-group]:not([hidden])")].find(node => node.getBoundingClientRect().bottom > top);
    if (row?.dataset.group) anchor.current = {key: row.dataset.group, offset: row.getBoundingClientRect().top - scroll.getBoundingClientRect().top};
  }, [aligned, outer, port, root]);

  // Rebind only admitted boxes. A resize may change a gap before the current row;
  // correct the same identity/offset after React commits the new geometry.
  useLayoutEffect(() => {
    const list = root.current, scroll = port.current, outside = outer.current;
    if (!list || !scroll || !outside) return;
    if (geometry.current.scope !== scope) {
      geometry.current = {scope, metrics: "", heights: new Map()};
      anchor.current = null;
      correction.current = null;
    }
    const available = new Set(slots.map(slot => slot.key));
    if (anchor.current && !available.has(anchor.current.key)) {
      const index = previous.current.findIndex(slot => slot.key === anchor.current!.key);
      const successor = previous.current.slice(index + 1).find(slot => available.has(slot.key));
      anchor.current = successor ? {...anchor.current, key: successor.key} : null;
    }
    if (previous.current !== slots && !aligned) correction.current = anchor.current;
    previous.current = slots;
    if (correction.current && !aligned && demand === null) {
      const saved = correction.current;
      const row = list.querySelector<HTMLElement>(`[data-window-key="${CSS.escape(saved.key)}"]`);
      if (row) scroll.scrollTop += row.getBoundingClientRect().top - scroll.getBoundingClientRect().top - saved.offset;
      correction.current = null;
    }
    let animation: number | null = null;
    const measure = () => {
      animation = null;
      const measured = geometry.current;
      let changed = false;
      const metrics = JSON.stringify([list.clientWidth, getComputedStyle(list).font]);
      if (measured.metrics !== metrics) {measured.metrics = metrics; measured.heights.clear(); changed = true;}
      for (const row of list.querySelectorAll<HTMLElement>("[data-window-key]:not([hidden])")) {
        const height = row.getBoundingClientRect().height;
        const key = row.dataset.windowKey!;
        if (height > 0 && measured.heights.get(key) !== height) {measured.heights.set(key, height); changed = true;}
      }
      if (changed && !aligned) correction.current = anchor.current;
      if (!changed) capture();
      const box = scroll.getBoundingClientRect(), bounds = outside.getBoundingClientRect();
      const origin = list.getBoundingClientRect().top;
      const top = Math.max(box.top, bounds.top) - origin;
      const bottom = Math.max(top, Math.min(box.bottom, bounds.bottom) - origin);
      setFrame(current => changed || current.top !== top || current.bottom !== bottom ? {top, bottom, revision: current.revision + (changed ? 1 : 0)} : current);
    };
    const schedule = () => {if (animation === null) animation = requestAnimationFrame(measure);};
    const resize = new ResizeObserver(schedule);
    resize.observe(scroll); resize.observe(outside); resize.observe(list);
    for (const row of list.querySelectorAll("[data-window-key]")) resize.observe(row);
    const scrollChanged = () => {capture(); flushSync(measure);};
    scroll.addEventListener("scroll", scrollChanged, {passive: true});
    outside.addEventListener("scroll", scrollChanged, {passive: true});
    if (anchor.current === null) capture();
    measure();
    return () => {
      resize.disconnect();
      scroll.removeEventListener("scroll", scrollChanged); outside.removeEventListener("scroll", scrollChanged);
      if (animation !== null) cancelAnimationFrame(animation);
    };
  });
  useLayoutEffect(() => {
    const changed = () => {
      const selected = window.getSelection();
      const keys = selected && !selected.isCollapsed ? [...root.current?.querySelectorAll<HTMLElement>("[data-group]") ?? []]
        .filter(row => {for (let i = 0; i < selected.rangeCount; i++) if (selected.getRangeAt(i).intersectsNode(row)) return true; return false;})
        .map(row => row.dataset.group!) : [];
      setSelection(current => JSON.stringify(current) === JSON.stringify(keys) ? current : keys);
    };
    document.addEventListener("selectionchange", changed);
    return () => document.removeEventListener("selectionchange", changed);
  }, [root]);
  return {rendered, tail: gap, held, interact, pin};
}
