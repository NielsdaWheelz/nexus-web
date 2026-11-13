"use client";

// A margin's geometry, independent of its source and contents. The stationary root has one
// element child: the translated stack. Rows name data-margin-key; data-resource-primary and
// its first mark supply their content baseline. Hosts retain membership, rendering and extent.
import {useCallback, useLayoutEffect, useRef, useState, type RefObject} from "react";
import {flushSync} from "react-dom";
import {getOverlayOpeners, useInteractionOwner} from "@/lib/ui/overlay";
import {MARGIN_GAP, stackMargin, type MarginFrame, type MarginRow} from "./stackMargin";

export interface MarginMeasurement {
  readonly sourceIdentity: string;
  /** Changes with source placement, never with margin scrolling or row height. */
  readonly positionKey: string;
  readonly viewport: {readonly top: number; readonly bottom: number};
  readonly anchors: readonly {
    readonly key: string;
    /** Null retains an already mounted row without a measurable source. Null height means a top without a text line. */
    readonly line: {readonly top: number; readonly height: number | null} | null;
  }[];
}
export interface MarginSource {
  /** Deliver current committed geometry outside React's commit, before the source frame paints. */
  subscribeGeometry(listener: () => void): () => void;
  measure(retained: ReadonlySet<string>): MarginMeasurement | null;
}
export type MarginPlacement = {key: string; kind: "measuring"}
  | {key: string; kind: "placed"; offset: number; height: number};

export function useMarginLayout(input: {
  active: boolean;
  source: MarginSource;
  outer: RefObject<HTMLElement | null>;
  list: RefObject<HTMLElement | null>;
  root: RefObject<HTMLElement | null>;
  retainedKeys(): ReadonlySet<string>;
  onMoved?(): void;
}) {
  const {active, source, outer, list, root} = input;
  const {subscribeGeometry} = source;
  const latest = useRef(input); latest.current = input;
  const [placements, setPlacements] = useState<readonly MarginPlacement[]>([]);
  const committed = useRef(placements); committed.current = placements;
  const frame = useRef<MarginFrame | null>(null);
  const translation = useRef(0);
  const position = useRef<{identity: string; key: string; outerScrollTop: number} | null>(null);
  const pin = useRef<{element: HTMLElement; y: number; scrollTop: number} | null>(null);
  const schedule = useRef<(() => void) | null>(null);
  const observeRows = useRef<(() => void) | null>(null);
  const requestMeasure = useCallback(() => schedule.current?.(), []);
  /** Intentional inspection can reach a row above the scroll origin. It moves the
   * actual stack; later source motion continues from that position. */
  const reveal = useCallback((key: string): boolean => {
    const current = latest.current, port = current.list.current;
    const stack = current.root.current?.firstElementChild;
    if (!current.active || !port || !(stack instanceof HTMLElement) ||
      !committed.current.some(row => row.key === key && row.kind === "placed")) return false;
    const row = port.querySelector<HTMLElement>(`[data-margin-key="${CSS.escape(key)}"]`);
    if (!row || !row.getClientRects().length || getComputedStyle(row).visibility === "hidden") return false;
    port.scrollTop += row.getBoundingClientRect().top - port.getBoundingClientRect().top;
    const remaining = row.getBoundingClientRect().top - port.getBoundingClientRect().top;
    if (remaining < 0) {
      translation.current -= remaining;
      stack.style.transform = `translateY(${translation.current}px)`;
      const previous = frame.current;
      if (previous) frame.current = {y: previous.y, tops: new Map([...previous.tops].map(([id, top]) => [id, top - remaining]))};
    }
    if (pin.current?.element.isConnected) {
      pin.current.y = pin.current.element.getBoundingClientRect().top;
      pin.current.scrollTop = port.scrollTop;
    }
    return true;
  }, []);
  // An overlay's opener holds its row even when focus lives in the portal.
  useInteractionOwner();

  useLayoutEffect(() => {
    const port = list.current, origin = root.current, outside = outer.current;
    if (!active) {
      frame.current = null; position.current = null; pin.current = null;
      translation.current = 0;
      const stack = origin?.firstElementChild;
      if (stack instanceof HTMLElement) stack.style.removeProperty("transform");
      return;
    }
    if (!port || !origin || !outside) return;
    let live = true, scheduledFrame = 0;
    const rowOf = (element: HTMLElement) => {
      const row = element.closest<HTMLElement>("[data-margin-key]:not([hidden])");
      return row && port.contains(row) ? row : null;
    };
    const measure = () => {
      if (scheduledFrame) {cancelAnimationFrame(scheduledFrame); scheduledFrame = 0;}
      if (!live || !latest.current.active) return;
      const stackRoot = origin.firstElementChild;
      if (!(stackRoot instanceof HTMLElement)) return;
      const overlayKeys = new Set(getOverlayOpeners().flatMap(opener => {
        const key = rowOf(opener)?.dataset.marginKey;
        return key === undefined ? [] : [key];
      }));
      const retained = new Set([...latest.current.retainedKeys(), ...overlayKeys]);
      const held = pin.current?.element.isConnected ? pin.current : null;
      const focusedKey = held && rowOf(held.element)?.dataset.marginKey;
      if (focusedKey) retained.add(focusedKey);
      const measured = latest.current.source.measure(retained);
      if (!measured) return;
      if (position.current?.identity !== measured.sourceIdentity) {frame.current = null; position.current = null;}
      // Source movement absorbs an independently scrolled margin into the stack before resetting its port.
      if (position.current?.key !== measured.positionKey) {
        const previous = frame.current, folded = port.scrollTop;
        if (previous && folded) frame.current = {y: previous.y, tops: new Map([...previous.tops].map(([key, top]) => [key, top - folded]))};
        port.scrollTop = 0;
        if (pin.current) pin.current.scrollTop = port.scrollTop;
        position.current = {identity: measured.sourceIdentity, key: measured.positionKey, outerScrollTop: outside.scrollTop};
      }
      const read = () => {
        const box = origin.getBoundingClientRect();
        const originY = box.top + port.scrollTop + outside.scrollTop - position.current!.outerScrollTop;
        const rows: MarginRow[] = [];
        const ring: {key: string; height: number; holds: number | null}[] = [];
        const unseen: string[] = [];
        let pinnedKey: string | null = null;
        for (const {key, line} of measured.anchors) {
          const row = port.querySelector<HTMLElement>(`[data-margin-key="${CSS.escape(key)}"]:not([hidden])`);
          if (!row) {if (line) unseen.push(key); continue;}
          const rect = row.getBoundingClientRect();
          let holds: number | null = null;
          if (overlayKeys.has(key)) {holds = rect.top - box.top; pinnedKey = key;}
          else if (held && row.contains(held.element)) {
            holds = held.y - box.top - (held.element.getBoundingClientRect().top - rect.top);
            pinnedKey = key;
          } else if (!line) holds = rect.top - box.top;
          ring.push({key, height: rect.height, holds});
          if (!line) continue;
          const primary = row.querySelector<HTMLElement>("[data-resource-primary]");
          const mark = primary?.querySelector("mark");
          const content = mark ?? primary;
          const baseline = content ? content.getBoundingClientRect().top - rect.top : 0;
          const quoteLine = mark?.getClientRects()[0];
          const desired = line.top - originY - baseline + (line.height !== null && quoteLine ? (line.height - quoteLine.height) / 2 : 0);
          rows.push({key, desired, height: rect.height, y: line.top});
        }
        return {rows, ring, unseen, pinnedKey};
      };
      let reading = read();
      // A newly admitted row must have its resting height before any placement reaches paint.
      if (reading.unseen.length) {
        const measuring = reading.unseen.map(key => ({key, kind: "measuring" as const}));
        flushSync(() => setPlacements([...committed.current, ...measuring]));
        reading = read();
      }
      const stack = stackMargin(reading.rows, frame.current,
        Math.max(port.getBoundingClientRect().top, measured.viewport.top + (measured.viewport.bottom - measured.viewport.top) / 3));
      if (stack.moved) latest.current.onMoved?.();
      const next = reading.ring.map(({key, height, holds}) => ({key, kind: "placed" as const, height: Math.ceil(height),
        offset: holds === null ? stack.offsets.get(key)! : Math.round(holds - stack.base)}));
      const pinnedAt = next.findIndex(place => place.key === reading.pinnedKey);
      if (pinnedAt >= 0) {
        for (let i = pinnedAt + 1; i < next.length; i++) next[i].offset = Math.max(next[i].offset, next[i - 1].offset + next[i - 1].height + MARGIN_GAP);
        for (let i = pinnedAt - 1; i >= 0; i--) next[i].offset = Math.min(next[i].offset, next[i + 1].offset - next[i].height - MARGIN_GAP);
      }
      // Retain the actual final positions, including a hold's correction and fractional slew residue.
      const tops = new Map<string, number>();
      for (const place of next) {
        const top = stack.frame.tops.get(place.key);
        if (top !== undefined) tops.set(place.key, top + place.offset - stack.offsets.get(place.key)!);
      }
      frame.current = {y: stack.frame.y, tops};
      const lift = Math.min(0, ...next.map(place => place.offset));
      for (const place of next) place.offset -= lift;
      const current = committed.current;
      const same = current.length === next.length && current.every((was, i) => was.kind === "placed" &&
        was.key === next[i].key && was.offset === next[i].offset && was.height === next[i].height);
      // Child layout effects must measure the new transform together with the new row offsets.
      translation.current = stack.base + lift;
      stackRoot.style.transform = `translateY(${translation.current}px)`;
      if (!same) flushSync(() => setPlacements(next));
    };
    // Row resize delivery cannot flush React inside its broadcast. Source geometry already owns
    // a current frame and calls measure directly; local changes share this one requested frame.
    const request = () => {if (!scheduledFrame) scheduledFrame = requestAnimationFrame(measure);};
    schedule.current = request;
    const observer = new ResizeObserver(request);
    observer.observe(port); observer.observe(outside); observer.observe(origin);
    const observed = new Set<HTMLElement>();
    observeRows.current = () => {
      const rows = new Set(port.querySelectorAll<HTMLElement>("[data-margin-key]"));
      for (const row of observed) if (!rows.has(row)) {observer.unobserve(row); observed.delete(row);}
      for (const row of rows) if (!observed.has(row)) {observer.observe(row); observed.add(row);}
    };
    const focus = () => {
      const element = document.activeElement;
      if (element instanceof HTMLElement && rowOf(element))
        pin.current = {element, y: element.getBoundingClientRect().top, scrollTop: port.scrollTop};
      else pin.current = null;
      request();
    };
    const blur = () => {queueMicrotask(() => {if (live) focus();});};
    const scroll = (event: Event) => {
      if (pin.current?.element.isConnected && (event.currentTarget === outside || pin.current.scrollTop !== port.scrollTop)) {
        pin.current.y = pin.current.element.getBoundingClientRect().top;
        pin.current.scrollTop = port.scrollTop;
      }
      request();
    };
    port.addEventListener("focusin", focus);
    port.addEventListener("focusout", blur);
    port.addEventListener("scroll", scroll, {passive: true});
    outside.addEventListener("scroll", scroll, {passive: true});
    const unsubscribe = subscribeGeometry(measure);
    observeRows.current();
    focus();
    return () => {
      live = false; unsubscribe(); observer.disconnect(); cancelAnimationFrame(scheduledFrame);
      port.removeEventListener("focusin", focus); port.removeEventListener("focusout", blur);
      port.removeEventListener("scroll", scroll); outside.removeEventListener("scroll", scroll);
      schedule.current = null; observeRows.current = null;
    };
  }, [active, subscribeGeometry, outer, list, root]);
  useLayoutEffect(() => {observeRows.current?.(); requestMeasure();});
  return {placements, requestMeasure, reveal};
}
