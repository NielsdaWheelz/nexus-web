"use client";

import { useCallback, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { windowRanks } from "@/lib/collections/collectionWindow";
import type { ScrollMotion } from "@/lib/collections/scrollMotion";
import type { TurnKey } from "@/lib/chat/wire";
import { getOverlayOpeners } from "@/lib/ui/overlay";

const ESTIMATED_TURN_HEIGHT = 160;

function firstAfter(ends: readonly number[], offset: number): number {
  let low = 0, high = ends.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (ends[middle] <= offset) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** The viewport retains geometry by run identity even when its body has left.
 * Scroll writes and the reading point belong exclusively to useChatScroll. */
export function useTranscriptWindow(
  port: RefObject<HTMLDivElement | null>,
  root: RefObject<HTMLDivElement | null>,
  order: readonly TurnKey[],
  target: string | null,
  pins: readonly string[],
) {
  const [motion, commitMotion] = useState<ScrollMotion>("still");
  const [shown, setShown] = useState(order);
  const append = motion === "travel" && order.length > shown.length && shown.every((key, rank) => key.run_id === order[rank].run_id);
  if (shown !== order && (motion === "still" || append)) setShown(order);
  const [heights, setHeights] = useState<ReadonlyMap<string, number>>(() => new Map());
  const [frame, setFrame] = useState({ top: 0, height: 700, positioned: false });
  const [focused, setFocused] = useState<readonly string[]>([]);
  const current = useRef({ motion, nonempty: shown.length > 0 }); current.current = { motion, nonempty: shown.length > 0 };
  const layout = useMemo(() => {
    const ranks = new Map<string, number>();
    const ends: number[] = [];
    let height = 0;
    for (const [rank, key] of shown.entries()) {
      ranks.set(key.run_id, rank);
      height += heights.get(key.run_id) ?? ESTIMATED_TURN_HEIGHT;
      ends.push(height);
    }
    return { ranks, ends, height };
  }, [shown, heights]);
  const readViewport = useCallback(() => {
    const scroll = port.current;
    const transcript = root.current;
    if (!scroll || !transcript || scroll.clientHeight === 0) return;
    const inset = parseFloat(getComputedStyle(transcript).paddingTop) || 0;
    const top = scroll.scrollTop - inset, height = scroll.clientHeight;
    setFrame(previous => previous.top === top && previous.height === height && previous.positioned === current.current.nonempty
      ? previous : { top, height, positioned: current.current.nonempty });
  }, [port, root]);
  const topOf = (rank: number) => layout.ends[rank - 1] ?? 0;
  const targetRank = target === null ? undefined : layout.ranks.get(target);
  const top = frame.positioned ? frame.top
    : targetRank === undefined ? Math.max(0, layout.height - frame.height) : topOf(targetRank);
  const start = firstAfter(layout.ends, top - frame.height);
  const end = Math.min(shown.length, firstAfter(layout.ends, top + 2 * frame.height) + 1);
  const pinnedRanks = [...pins, ...focused].flatMap(id => {
    const rank = layout.ranks.get(id);
    return rank === undefined ? [] : [rank];
  });
  const plan = windowRanks({ start, end, pinnedRanks, count: shown.length });
  const demand = useRef<readonly string[]>([]);
  // A distant seek reserves intervening slots without reading their bodies.
  // In-flight bodies for the old viewport can still paint inside held slots.
  if (motion === "still") demand.current = plan.demand.map(rank => shown[rank].run_id);
  const observer = useRef<ResizeObserver | null>(null);
  const items = useRef(new Map<string, HTMLElement>());
  const observe = useCallback((node: HTMLElement | null) => {
    const id = node?.dataset.chatRun;
    if (!node || !id) return;
    items.current.set(id, node);
    observer.current?.observe(node);
    return () => {
      observer.current?.unobserve(node);
      items.current.delete(id);
    };
  }, []);
  const record = useCallback(() => {
    if (current.current.motion !== "still") return;
    const measured = [...items.current].flatMap(([id, node]) => {
      if (!node.hasAttribute("data-chat-measured")) return [];
      const height = node.getBoundingClientRect().height;
      return height > 0 ? [[id, height] as const] : [];
    });
    setHeights(previous => {
      if (measured.every(([id, height]) => previous.get(id) === height)) return previous;
      const next = new Map(previous);
      for (const [id, height] of measured) next.set(id, height);
      return next;
    });
  }, []);
  useLayoutEffect(() => {
    const size = new ResizeObserver(record);
    observer.current = size;
    for (const node of items.current.values()) size.observe(node);
    return () => { observer.current = null; size.disconnect(); };
  }, [record]);
  useLayoutEffect(record, [record, motion]);
  const setMotion = useCallback((next: ScrollMotion) => {
    // A press may arrive before an observed size has reached React. Reserve the
    // current painted slots in the same commit that freezes their geometry.
    if (next !== "still") record();
    commitMotion(next);
  }, [record]);

  const readPins = useCallback(() => {
    const transcript = root.current;
    if (!transcript) return;
    const selected = window.getSelection();
    const nodes = [document.activeElement, ...getOverlayOpeners(), selected?.isCollapsed ? null : selected?.anchorNode, selected?.isCollapsed ? null : selected?.focusNode];
    const ids = new Set<string>();
    for (const node of nodes) {
      if (!node || !transcript.contains(node)) continue;
      const slot = (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>("[data-chat-run]");
      if (slot?.dataset.chatRun) ids.add(slot.dataset.chatRun);
    }
    setFocused(previous => previous.length === ids.size && previous.every(id => ids.has(id)) ? previous : [...ids]);
  }, [root]);
  useLayoutEffect(() => {
    document.addEventListener("selectionchange", readPins);
    document.addEventListener("focusin", readPins);
    return () => {
      document.removeEventListener("selectionchange", readPins);
      document.removeEventListener("focusin", readPins);
    };
  }, [readPins]);

  return {
    shown, motion, setMotion, readViewport, observe,
    demand: demand.current,
    rows: plan.rows.map(({ index, gap }) => ({
      rank: index, key: shown[index],
      height: layout.ends[index] - topOf(index),
      gap: topOf(index) - topOf(index - gap),
    })),
    offset(id: string) {
      const rank = layout.ranks.get(id);
      if (rank === undefined || !root.current) return null;
      return topOf(rank) + (parseFloat(getComputedStyle(root.current).paddingTop) || 0);
    },
  };
}
