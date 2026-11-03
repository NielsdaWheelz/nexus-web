"use client";

// Geometry for this pane's root occurrences only. Data, folds and editors stay
// with their existing owners; gaps never instantiate a resource row.
import {useCallback, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject} from "react";
import {scrollFrame} from "@/lib/collections/scrollFrame";

export interface EvidenceSlot {key: string; estimate: number}
/** A row and its top, measured from the port's top. */
export interface Anchor {key: string; offset: number}
/** Each row's last true height, valid for one list width, font and reader profile. */
export interface Memory {metrics: string; heights: Map<string, number>}
/** The visible band, in the list's own coordinates. */
interface Frame {top: number; bottom: number}
/** The row the window holds still, by its top in the list's own coordinates: a scroll leaves `y` alone, layout above it does not. */
interface ListAnchor {key: string; y: number}
/** Rest: still; moving until the timer fires; due until the next frame publishes. */
type Clock = {kind: "still"} | {kind: "moving"; timer: number} | {kind: "due"};

/** Window rest: this long since an offset last changed. It must outlast child reads. */
const REST_MS = 1000;

/** #884's policy, shared by current boxes and the last committed layout. */
function firstVisible<T>(items: Iterable<T>, top: number, bottom: number, bounds: (item: T) => {top: number; bottom: number} | null): T | null {
  let clipped: T | null = null;
  for (const item of items) {
    const rect = bounds(item);
    if (rect === null || rect.bottom <= rect.top || rect.bottom <= top || rect.top >= bottom) continue;
    if (rect.top >= top) return item;
    clipped ??= item;
  }
  return clipped;
}

export function firstVisibleRow(list: HTMLElement, top: number, bottom: number): HTMLElement | null {
  return firstVisible(list.querySelectorAll<HTMLElement>("[data-group]:not([hidden])"), top, bottom, row => row.getBoundingClientRect());
}

function offsetsOf(slots: readonly EvidenceSlot[], heights: ReadonlyMap<string, number>): number[] {
  const offsets = [0];
  for (const slot of slots) offsets.push(offsets.at(-1)! + (slot.estimate === 0 ? 0 : heights.get(slot.key) ?? slot.estimate));
  return offsets;
}

/** One viewport above and below amortizes remounts without admitting detail owners. */
function rangeOf(slots: readonly EvidenceSlot[], offsets: readonly number[], frame: Frame): string[] {
  const span = frame.bottom - frame.top, keys: string[] = [];
  for (let index = 0; index < slots.length; index++) {
    if (slots[index].estimate > 0 && offsets[index + 1] >= frame.top - span && offsets[index] <= frame.bottom + span) keys.push(slots[index].key);
  }
  return keys;
}

/** A removed anchor hands its place to the next row that survives, in the previous order. */
function survivor(anchor: ListAnchor | null, before: readonly EvidenceSlot[], slots: readonly EvidenceSlot[]): ListAnchor | null {
  if (anchor === null) return null;
  const available = new Set(slots.map(slot => slot.key));
  if (available.has(anchor.key)) return anchor;
  const next = before.slice(before.findIndex(slot => slot.key === anchor.key) + 1).find(slot => available.has(slot.key));
  return next ? {key: next.key, y: anchor.y} : null;
}

export function useEvidenceWindow(input: {
  scope: string | null; slots: readonly EvidenceSlot[]; aligned: boolean;
  placements: readonly string[]; demand: string | null; focused: string | null;
  root: RefObject<HTMLDivElement | null>; port: RefObject<HTMLDivElement | null>; outer: RefObject<HTMLDivElement | null>;
  memory: RefObject<Memory>; profile: string; onGeometry(): void; onAnchor(anchor: Anchor): void;
}) {
  const {scope, slots, aligned, placements, demand, focused, root, port, outer, memory} = input;
  const [pins, setPins] = useState<ReadonlyMap<symbol, string>>(() => new Map());
  const [sticky, setSticky] = useState<string | null>(null);
  const [selection, setSelection] = useState<readonly string[]>([]);
  const [, setRevision] = useState(0);
  const latest = useRef(input);
  const frame = useRef<Frame>({top: 0, bottom: 900});
  // The committed layout, including actual mounted heights; memory predicts only the next window.
  const committed = useRef({scope, slots, offsets: [0], range: [] as string[]});
  const anchor = useRef<ListAnchor | null>(null);
  // A row whose external hold ended, for the next commit to anchor.
  const released = useRef<string | null>(null);
  // Offsets as the window last saw them, its own writes included: a difference is someone else's scroll.
  const seen = useRef({port: 0, outer: 0});
  const clock = useRef<Clock>({kind: "still"});
  const rows = useRef(new Map<string, HTMLLIElement>());
  const observer = useRef<ResizeObserver | null>(null);
  const frames = useRef<ReturnType<typeof scrollFrame> | null>(null);

  const before = committed.current;
  const preserved = before.scope === scope ? survivor(anchor.current, before.slots, slots) : null;
  // Admit a surviving filter anchor in this render, before correcting its box.
  const held = new Set([...pins.values(), ...selection,
    ...[focused, demand, sticky, aligned ? null : preserved?.key ?? null].filter(key => key !== null)]);
  const offsets = offsetsOf(slots, memory.current.heights);
  const range = rangeOf(slots, offsets, frame.current);
  const admitted = new Set([...range, ...(aligned ? placements : []), ...held]);
  let gap = 0;
  const rendered: {key: string; gap: number}[] = [];
  for (let index = 0; index < slots.length; index++) {
    if (admitted.has(slots[index].key)) {rendered.push({key: slots[index].key, gap}); gap = 0;}
    else gap += offsets[index + 1] - offsets[index];
  }

  const interact = useCallback((key: string) => setSticky(key), []);
  const pin = useCallback((key: string) => {
    const token = Symbol();
    setPins(current => new Map(current).set(token, key));
    return () => setPins(current => {const next = new Map(current); next.delete(token); return next;});
  }, []);
  /** Restarts the rest clock. */
  const restart = useCallback(() => {
    if (clock.current.kind === "moving") clearTimeout(clock.current.timer);
    clock.current = {kind: "moving", timer: window.setTimeout(() => {clock.current = {kind: "due"}; frames.current?.request();}, REST_MS)};
  }, []);
  const moving = useCallback(() => clock.current.kind !== "still", []);
  const measure = useCallback(() => {
    const before = committed.current, measured = [0];
    for (let index = 0; index < before.slots.length; index++) {
      const slot = before.slots[index], row = rows.current.get(slot.key);
      const height = slot.estimate === 0 ? 0 : row && !row.hidden ? row.getBoundingClientRect().height : before.offsets[index + 1] - before.offsets[index];
      measured.push(measured.at(-1)! + height);
    }
    committed.current.offsets = measured;
  }, []);
  // Outside resize delivery: changing an observed ancestor there loses notifications.
  const publishExtent = useCallback(() => {
    const list = root.current, scroll = port.current;
    if (list && scroll) {
      // Keep the last extent until compensation runs: shrinking children must not clamp the
      // browser's offset first. Releasing this floor acknowledges only its own clamp, not input.
      const from = scroll.scrollTop;
      list.style.minHeight = latest.current.aligned ? "" : `${committed.current.offsets.at(-1)!}px`;
      seen.current.port += scroll.scrollTop - from;
    }
  }, [port, root]);
  /** C3: the anchor moves only with the scroll. Any other move is absorbed relatively, because the compositor may be ahead. */
  const hold = useCallback(() => {
    const {aligned, demand} = latest.current;
    const list = root.current, scroll = port.current, outside = outer.current;
    let kept = anchor.current;
    if (aligned || demand !== null || !list || !scroll || !outside || !kept) return;
    const origin = list.getBoundingClientRect().top, before = committed.current;
    if (before.scope === latest.current.scope && before.slots.length === latest.current.slots.length &&
      before.slots.every((slot, index) => slot.key === latest.current.slots[index].key) &&
      (scroll.scrollTop !== seen.current.port || outside.scrollTop !== seen.current.outer)) {
      // Input may have passed the old anchor before a resize lands. Choose in the prior layout,
      // otherwise growth inside that row (or the next) is accepted before it can be compensated.
      const key = kept.key, index = before.slots.findIndex(slot => slot.key === key);
      if (index !== -1) {
        const box = scroll.getBoundingClientRect(), bounds = outside.getBoundingClientRect(), y = kept.y;
        const next = firstVisible(before.slots.entries(), Math.max(box.top, bounds.top), Math.min(box.bottom, bounds.bottom), ([at, slot]) => {
          const row = rows.current.get(slot.key);
          if (!row || row.hidden) return null;
          const top = origin + y + before.offsets[at] - before.offsets[index];
          return {top, bottom: top + before.offsets[at + 1] - before.offsets[at]};
        });
        if (next) kept = {key: next[1].key, y: y + before.offsets[next[0]] - before.offsets[index]};
      }
    }
    const row = rows.current.get(kept.key);
    if (!row || row.hidden) return;
    const y = row.getBoundingClientRect().top - origin;
    // A port at its origin stays there: rows landing above it are the list's start.
    if (y !== kept.y && scroll.scrollTop > 0) {
      const from = scroll.scrollTop;
      scroll.scrollBy({top: y - kept.y, behavior: "instant"});
      seen.current.port += scroll.scrollTop - from;
    }
    anchor.current = {key: kept.key, y};
  }, [outer, port, root]);
  /** Ends an external hold. The commit this causes ends the demand, and anchors the row where it stands if it is mounted. */
  const release = useCallback((key: string) => {
    released.current = key;
    setRevision(revision => revision + 1);
  }, []);
  /** In motion a row commits at least at its remembered height, so the gap it replaces conserves extent (C2). */
  const reserve = useCallback((key: string): CSSProperties | undefined => {
    const height = clock.current.kind === "still" ? undefined : memory.current.heights.get(key);
    return height === undefined ? undefined : {minHeight: height};
  }, [memory]);
  /** Bound on the node, so a replaced `li` stays observed. */
  const observeRow = useCallback((key: string, node: HTMLLIElement | null) => {
    const current = rows.current.get(key);
    if (current === node) return;
    if (current) observer.current?.unobserve(current);
    if (node) {rows.current.set(key, node); observer.current?.observe(node);}
    else rows.current.delete(key);
  }, []);

  // Every commit: an anchor survives a membership change, and whatever moved it lands back before paint.
  useLayoutEffect(() => {
    latest.current = input;
    if (committed.current.scope !== scope || aligned) anchor.current = null;
    else if (committed.current.slots !== slots) anchor.current = survivor(anchor.current, committed.current.slots, slots);
    // A release lands here, under this commit's `aligned`: a row's layout effect runs before this one.
    if (released.current !== null) {
      const list = root.current, scroll = port.current, outside = outer.current, row = rows.current.get(released.current);
      if (!aligned && list && scroll && outside && row && !row.hidden) {
        anchor.current = {key: released.current, y: row.getBoundingClientRect().top - list.getBoundingClientRect().top};
        // The reveal's own writes are no reader motion, so the next frame keeps this anchor.
        seen.current = {port: scroll.scrollTop, outer: outside.scrollTop};
      }
      released.current = null;
    }
    hold();
    committed.current = {scope, slots, offsets, range};
    measure();
    publishExtent();
    frames.current?.request();
  });

  // One observer and one frame loop for the pane's life; inputs come through `latest`.
  useLayoutEffect(() => {
    const list = root.current, scroll = port.current, outside = outer.current;
    if (!list || !scroll || !outside) return;
    const resize = new ResizeObserver(entries => {
      const {memory, onGeometry} = latest.current;
      for (const entry of entries) {
        const key = entry.target instanceof HTMLElement ? entry.target.dataset.windowKey : undefined;
        const height = entry.borderBoxSize[0]?.blockSize ?? 0;
        const known = key === undefined ? undefined : memory.current.heights.get(key);
        // In motion memory only rises; truth is learned at rest.
        if (key === undefined || height <= 0 || height === known || clock.current.kind !== "still" && known !== undefined && height < known) continue;
        memory.current.heights.set(key, height);
      }
      hold();
      measure();
      // Never flushSync here: a commit inside a resize broadcast loops.
      frames.current?.request();
      onGeometry();
    });
    /** The visible band and the list's origin, in viewport coordinates. */
    const band = () => {
      const box = scroll.getBoundingClientRect(), bounds = outside.getBoundingClientRect(), top = Math.max(box.top, bounds.top);
      return {port: box.top, top, bottom: Math.max(top, Math.min(box.bottom, bounds.bottom)), origin: list.getBoundingClientRect().top};
    };
    /** #884's policy. Callers hold first: whatever moved the old anchor is absorbed before a new one is chosen. */
    const capture = ({top, bottom, origin}: ReturnType<typeof band>) => {
      const {aligned, demand} = latest.current;
      // Under a demand the pane owns the position.
      const row = aligned || demand !== null ? null : firstVisibleRow(list, top, bottom), key = row?.dataset.group;
      anchor.current = row && key !== undefined ? {key, y: row.getBoundingClientRect().top - origin} : null;
    };
    const tick = () => {
      const {slots, memory, profile, onAnchor} = latest.current;
      let publish = false;
      const metrics = JSON.stringify([list.clientWidth, getComputedStyle(list).font, profile]);
      if (list.clientWidth > 0 && memory.current.metrics !== metrics) {
        // In place: the pane's return snapshot holds this same memory.
        memory.current.metrics = metrics;
        memory.current.heights.clear();
        publish = true;
        // An observer reports only a changed box, so mounted rows would stay unknown. A fresh observation
        // reports again; both engines ignore observe() on a target they already observe.
        for (const node of rows.current.values()) {resize.unobserve(node); resize.observe(node);}
      }
      const scrolled = scroll.scrollTop !== seen.current.port || outside.scrollTop !== seen.current.outer;
      if (scrolled) {
        // Absorb what moved the old anchor before measuring anything: its write moves every box.
        hold();
        seen.current = {port: scroll.scrollTop, outer: outside.scrollTop};
        restart();
      } else if (clock.current.kind === "due") {
        // Reservations drop in one publication, and the observer learns the truth.
        clock.current = {kind: "still"};
        publish = true;
      }
      measure();
      publishExtent();
      const at = band();
      // Without a scroll the anchor stands: a released row stays the anchor until the reader acts.
      if (scrolled || anchor.current === null) capture(at);
      const kept = anchor.current, row = kept && rows.current.get(kept.key);
      if (kept && row) onAnchor({key: kept.key, offset: row.getBoundingClientRect().top - at.port});
      frame.current = {top: at.top - at.origin, bottom: at.bottom - at.origin};
      const next = rangeOf(slots, offsetsOf(slots, memory.current.heights), frame.current), current = committed.current.range;
      let same = !publish && next.length === current.length;
      for (let index = 0; same && index < next.length; index++) same = next[index] === current[index];
      if (!same) setRevision(revision => revision + 1);
    };
    // The reader's pointer or key ends a released anchor before its own effect lands: the policy chooses again.
    const act = () => {hold(); measure(); publishExtent(); capture(band());};
    outside.addEventListener("pointerdown", act, true);
    outside.addEventListener("keydown", act, true);
    for (const node of [scroll, outside, list, ...rows.current.values()]) resize.observe(node);
    observer.current = resize;
    frames.current = scrollFrame([scroll, outside], tick);
    seen.current = {port: scroll.scrollTop, outer: outside.scrollTop};
    tick();
    return () => {
      outside.removeEventListener("pointerdown", act, true);
      outside.removeEventListener("keydown", act, true);
      frames.current?.stop();
      frames.current = null;
      resize.disconnect();
      observer.current = null;
      if (clock.current.kind === "moving") clearTimeout(clock.current.timer);
      clock.current = {kind: "still"};
    };
  }, [hold, measure, outer, port, publishExtent, restart, root]);

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
  return {rendered, tail: gap, held, interact, pin, release, reserve, observeRow, moved: restart, moving};
}
