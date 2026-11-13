"use client";

import { useLayoutEffect, type RefObject } from "react";

/** Places one drawing in its host's scroll coordinates; the host owns its paint. */
export function useIndicator(host: RefObject<HTMLElement | null>, key: string | null): void {
  useLayoutEffect(() => {
    const element = host.current;
    if (!element) return;
    const place = () => {
      const child = element.querySelector<HTMLElement>("[data-indicated]");
      const box = child?.getBoundingClientRect();
      const bounds = element.getBoundingClientRect();
      element.style.setProperty("--indicator-start", `${box ? box.left - bounds.left + element.scrollLeft : 0}px`);
      element.style.setProperty("--indicator-size", `${box?.width ?? 0}px`);
      if (child && !element.hasAttribute("data-indicator-ready")) {
        // Commit the first position without a transition before enabling later moves.
        element.querySelector<HTMLElement>("[data-indicator]")?.getBoundingClientRect();
        element.setAttribute("data-indicator-ready", "");
      }
    };
    const sizes = new ResizeObserver(place);
    const observe = () => {
      sizes.disconnect();
      sizes.observe(element);
      const indicated = element.querySelector<HTMLElement>("[data-indicated]");
      for (const child of indicated?.parentElement?.children ?? element.children)
        if (!child.hasAttribute("data-indicator")) sizes.observe(child);
      place();
    };
    const children = new MutationObserver(observe);
    children.observe(element, { childList: true, subtree: true });
    observe();
    return () => { sizes.disconnect(); children.disconnect(); };
  }, [host, key]);
}
