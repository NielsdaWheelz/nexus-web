"use client";

import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { observeScrollMotion } from "@/lib/collections/scrollMotion";

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

/** The constrained chooser can give its scrolling to the enclosing body. Only the
 * current port's trusted motion can admit demand. */
export function useOptionForwardTravel(viewport: RefObject<HTMLElement | null>, open: boolean, run: () => void): void {
  const latest = useRef(run);
  useLayoutEffect(() => { latest.current = run; }, [run]);
  useEffect(() => {
    const list = viewport.current;
    if (!open || list === null) return;
    const forward = (port: HTMLElement) => {
      if (discoveryViewport(list) === port && nearDiscoveryTail(port, list.lastElementChild instanceof HTMLElement ? list.lastElementChild : list)) latest.current();
    };
    const stopList = observeScrollMotion(list, () => {}, forward);
    const body = list.closest<HTMLElement>("[data-collection-body]");
    const stopBody = body === null || body === list ? null : observeScrollMotion(body, () => {}, forward);
    return () => { stopList(); stopBody?.(); };
  }, [viewport, open]);
}
