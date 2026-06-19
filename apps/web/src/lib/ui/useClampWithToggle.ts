"use client";

import { useLayoutEffect, useState } from "react";
import type { RefObject } from "react";

// Measures whether a collapsed, clamped element overflows its box, so a host can
// decide whether to offer a "show more" toggle. Measure only while collapsed; when
// expanded the box is un-clamped and would read as not overflowing. The element ref
// is owned by the caller.
export function useClampWithToggle(args: {
  ref: RefObject<HTMLElement | null>;
  text: string | null;
  expanded: boolean;
}): { overflowing: boolean } {
  const { ref, text, expanded } = args;
  const [overflowing, setOverflowing] = useState(false);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || text === null || expanded) {
      return;
    }
    const measure = () => setOverflowing(element.scrollHeight - element.clientHeight > 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, text, expanded]);

  return { overflowing };
}
