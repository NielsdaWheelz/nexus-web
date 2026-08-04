"use client";

import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";

/**
 * Retain the pane scrollport's offset across a same-path domain-view
 * replacement. Call the returned `capture` before requesting the new view; the
 * offset is reapplied once `commitToken` changes. It is reapplied twice because
 * the committed rows finish laying out on the frame after the commit.
 */
export default function usePaneScrollRetention(
  regionRef: RefObject<HTMLElement | null>,
  commitToken: unknown,
): () => void {
  const pendingScrollTopRef = useRef<number | null>(null);
  const capture = useCallback(() => {
    const scrollport =
      regionRef.current?.closest<HTMLElement>("[data-pane-content]");
    if (scrollport) {
      pendingScrollTopRef.current = scrollport.scrollTop;
    }
  }, [regionRef]);

  useLayoutEffect(() => {
    const scrollTop = pendingScrollTopRef.current;
    if (scrollTop === null) return;
    const scrollport =
      regionRef.current?.closest<HTMLElement>("[data-pane-content]");
    if (!scrollport) return;
    scrollport.scrollTop = scrollTop;
    const frame = requestAnimationFrame(() => {
      scrollport.scrollTop = scrollTop;
      pendingScrollTopRef.current = null;
    });
    return () => cancelAnimationFrame(frame);
  }, [commitToken, regionRef]);

  return capture;
}
