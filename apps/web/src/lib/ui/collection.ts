"use client";

// Collection geometry stays within its owned body. When fixed controls cannot
// leave one row, the body scrolls instead of nesting two scrolling regions.
import { useLayoutEffect, type RefObject } from "react";

export function revealCollectionItem(viewport: HTMLElement, item: HTMLElement): void {
  const body = viewport.closest<HTMLElement>('[data-collection-constrained="true"]');
  const scrollport = body ?? viewport;
  if (!scrollport.contains(item)) return;
  const box = scrollport.getBoundingClientRect();
  const row = item.getBoundingClientRect();
  const top = box.top + scrollport.clientTop;
  const bottom = top + scrollport.clientHeight;
  if (row.top < top) scrollport.scrollTop = Math.floor(scrollport.scrollTop + row.top - top);
  else if (row.bottom > bottom) scrollport.scrollTop = Math.ceil(scrollport.scrollTop + Math.min(row.bottom - bottom, row.top - top));
}

export function useCollectionLayout(ref: RefObject<HTMLElement | null>, active: boolean): void {
  useLayoutEffect(() => {
    const body = ref.current;
    if (!active || !body) return;
    body.dataset.collectionBody = "";
    let viewport: HTMLElement | null = null;
    const measure = () => {
      const next = body.querySelector<HTMLElement>("[data-collection-viewport]");
      if (next !== viewport) {
        if (viewport) {
          resize.unobserve(viewport);
          viewport.style.removeProperty("--collection-available-height");
        }
        viewport = next;
        if (viewport) resize.observe(viewport);
      }
      if (!viewport) {
        delete body.dataset.collectionConstrained;
        return;
      }
      const bodyScroll = { top: body.scrollTop, left: body.scrollLeft };
      const listScroll = { top: viewport.scrollTop, left: viewport.scrollLeft };
      viewport.style.removeProperty("--collection-available-height");
      delete body.dataset.collectionConstrained;
      const css = getComputedStyle(viewport);
      const row = Number.parseFloat(css.getPropertyValue("--collection-row-height"));
      const padding = Number.parseFloat(css.paddingTop) + Number.parseFloat(css.paddingBottom);
      const fixed = body.scrollHeight - viewport.offsetHeight;
      const available = Math.max(0, body.clientHeight - fixed);
      viewport.style.setProperty("--collection-available-height", `${available}px`);
      body.dataset.collectionConstrained = String(available < row + padding);
      body.scrollTop = bodyScroll.top;
      body.scrollLeft = bodyScroll.left;
      viewport.scrollTop = listScroll.top;
      viewport.scrollLeft = listScroll.left;
    };
    const resize = new ResizeObserver(measure);
    resize.observe(body);
    const content = new MutationObserver(measure);
    content.observe(body, { childList: true, characterData: true, subtree: true });
    measure();
    return () => {
      resize.disconnect();
      content.disconnect();
      viewport?.style.removeProperty("--collection-available-height");
      delete body.dataset.collectionBody;
      delete body.dataset.collectionConstrained;
    };
  }, [ref, active]);
}
