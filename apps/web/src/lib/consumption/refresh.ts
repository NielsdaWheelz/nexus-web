"use client";

import { useEffect, useRef, useState } from "react";

/**
 * A `stale` token for reads another device can change: it moves when `active` turns on (in the
 * same render, so a read keyed on both changes once) and, with `foreground` set, when the page
 * returns to the screen (focus, visible, online, pageshow) at least `foreground` ms after the
 * last move.
 */
export function useRefreshStamp(
  active: boolean,
  foreground: number | null,
): number {
  const [state, setState] = useState({ active, stamp: 0 });
  if (state.active !== active)
    setState({ active, stamp: state.stamp + (active ? 1 : 0) });
  const movedAt = useRef(0);
  useEffect(() => {
    movedAt.current = Date.now();
  }, [state.stamp]);
  useEffect(() => {
    if (!active || foreground === null) return;
    const onForeground = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - movedAt.current < foreground) return;
      setState((current) => ({ ...current, stamp: current.stamp + 1 }));
    };
    const events = ["focus", "online", "pageshow"] as const;
    document.addEventListener("visibilitychange", onForeground);
    for (const name of events) window.addEventListener(name, onForeground);
    return () => {
      document.removeEventListener("visibilitychange", onForeground);
      for (const name of events) window.removeEventListener(name, onForeground);
    };
  }, [active, foreground]);
  return state.stamp;
}
