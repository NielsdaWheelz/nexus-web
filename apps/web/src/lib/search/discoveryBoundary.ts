"use client";

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import { observeScrollMotion, writeScrollPosition } from "@/lib/collections/scrollMotion";

export function discoveryViewport(viewport: HTMLElement): HTMLElement {
  return viewport.closest<HTMLElement>('[data-collection-constrained="true"]') ?? viewport;
}

export function nearDiscoveryTail(port: HTMLElement, tail?: HTMLElement | null): boolean {
  if (port.clientHeight === 0) return false;
  if (tail === undefined) return port.scrollHeight - port.scrollTop <= 2 * port.clientHeight;
  if (tail === null || !port.contains(tail)) return false;
  const bottom = tail.getBoundingClientRect().bottom;
  const top = port.getBoundingClientRect().top + port.clientTop;
  return bottom >= top && bottom - top <= 2 * port.clientHeight;
}

/** A cold one-source view can spend one demand if its first accepted page doesn't fill the port. */
export function useInitialDiscoveryDemand({ key, current, active, viewport, run }: {
  readonly key: string | null;
  readonly current: boolean;
  readonly active: boolean;
  readonly viewport: () => HTMLElement | null;
  readonly run: () => void;
}): void {
  const seen = useRef<{ key: string | null; opened: boolean } | null>(null);
  useLayoutEffect(() => {
    if (seen.current?.key !== key) seen.current = { key, opened: current };
    if (key === null || !current || seen.current.opened) return;
    seen.current.opened = true;
    const port = viewport();
    if (active && port !== null && port.clientHeight > 0 && port.scrollHeight <= port.clientHeight + 1) run();
  });
}

type Slot = { readonly id: string; readonly height: number };
const optionNodes = (list: HTMLElement) => [...list.querySelectorAll<HTMLElement>(":scope > [data-discovery-option]")];

export function heldDiscoveryOptionStyle(height: number | null): CSSProperties | undefined {
  return height === null ? undefined : { blockSize: height, minBlockSize: 0, overflow: "hidden", flexShrink: 0 };
}

/** The actual option port owns its landing. A revoked option loses its content
 * immediately; its slot survives the current gesture. */
export function useDiscoveryOptions<T>(input: {
  readonly key: string;
  readonly viewport: RefObject<HTMLElement | null>;
  readonly open: boolean;
  readonly rows: readonly T[];
  readonly id: (row: T) => string;
  readonly forward: () => void;
}) {
  const { key, viewport, open, rows, id } = input;
  const latest = useRef(input);
  useLayoutEffect(() => { latest.current = input; }, [input]);
  const [held, setHeld] = useState<{ readonly key: string; readonly slots: readonly Slot[] } | null>(null);
  const landing = useRef<{ readonly key: string; readonly port: HTMLElement; readonly ids: readonly string[];
    readonly at: number; readonly offset: number } | null>(null);
  useEffect(() => {
    const list = viewport.current;
    if (!open || list === null) { setHeld(null); return; }
    let slots: readonly Slot[] | null = null;
    let owner: HTMLElement | null = null;
    const body = list.closest<HTMLElement>("[data-collection-body]");
    const observe = (port: HTMLElement) => observeScrollMotion(port, motion => {
      if (motion === "still" ? owner !== port : discoveryViewport(list) !== port) return;
      landing.current = null;
      if (motion !== "still") {
        if (slots !== null) return;
        owner = port;
        slots = optionNodes(list).map(node => ({ id: node.dataset.discoveryOption!, height: node.getBoundingClientRect().height }));
        setHeld({ key, slots });
        return;
      }
      if (slots === null) return;
      const top = port.getBoundingClientRect().top + port.clientTop;
      const eye = optionNodes(list).find(node => {
        const box = node.getBoundingClientRect();
        return box.bottom > top && box.top < top + port.clientHeight;
      });
      if (eye !== undefined) {
        const ids = slots.map(slot => slot.id);
        landing.current = { key, port, ids, at: ids.indexOf(eye.dataset.discoveryOption!), offset: eye.getBoundingClientRect().top - top };
      }
      slots = null;
      owner = null;
      setHeld(null);
    }, () => {
      const last = list.lastElementChild;
      if (discoveryViewport(list) === port && nearDiscoveryTail(port, last instanceof HTMLElement ? last : list)) latest.current.forward();
    });
    const stopList = observe(list);
    const stopBody = body === null || body === list ? null : observe(body);
    return () => { stopList(); stopBody?.(); landing.current = null; };
  }, [key, open, viewport]);

  useLayoutEffect(() => {
    const list = viewport.current, rest = landing.current;
    if (held !== null || list === null || rest === null || rest.key !== key || rest.port !== discoveryViewport(list)) return;
    landing.current = null;
    const nodes = new Map(optionNodes(list).map(node => [node.dataset.discoveryOption!, node]));
    const next = rest.ids.slice(rest.at).find(id => nodes.has(id))
      ?? rest.ids.slice(0, rest.at).reverse().find(id => nodes.has(id));
    const anchor = next === undefined ? null : nodes.get(next);
    if (!anchor) return;
    const port = rest.port;
    const delta = anchor.getBoundingClientRect().top - (port.getBoundingClientRect().top + port.clientTop) - rest.offset;
    if (Math.abs(delta) > 0.5) writeScrollPosition(port, port.scrollTop + delta);
  }, [held, key, viewport]);

  if (held === null || held.key !== key || !open) return rows.map(row => ({id: id(row), row, height: null}));
  const byId = new Map(rows.map(row => [id(row), row]));
  return held.slots.map(slot => ({ ...slot, row: byId.get(slot.id) ?? null }));
}
