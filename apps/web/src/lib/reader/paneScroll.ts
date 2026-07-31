"use client";

import { useCallback, useMemo } from "react";
import { useMobileChromeVisibleLocks } from "@/lib/workspace/mobileChrome";
import { isPositiveFinite } from "@/lib/validation";

const TEXT_ANCHOR_TOP_PADDING_PX = 56;

function isScrollableY(element: HTMLElement): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  const computed = window.getComputedStyle(element);
  return (
    /(auto|scroll|overlay)/.test(computed.overflowY) &&
    element.scrollHeight > element.clientHeight
  );
}

export function getPaneScrollContainer(
  contentNode: HTMLElement | null,
): HTMLElement | null {
  if (!contentNode) {
    return null;
  }

  const explicitPaneViewport = contentNode.closest<HTMLElement>(
    '[data-testid="document-viewport"], [data-pane-content="true"]',
  );
  if (explicitPaneViewport && isScrollableY(explicitPaneViewport)) {
    return explicitPaneViewport;
  }

  let candidate: HTMLElement | null = contentNode;
  while (candidate && candidate !== document.body) {
    if (isScrollableY(candidate)) {
      return candidate;
    }
    candidate = candidate.parentElement;
  }

  const paneContent = contentNode.closest<HTMLElement>(
    '[data-pane-content="true"]',
  );
  if (paneContent) {
    return paneContent;
  }

  if (typeof document !== "undefined" && document.scrollingElement) {
    return document.scrollingElement as HTMLElement;
  }
  return null;
}

export function getPaneScrollTopPaddingPx(container: HTMLElement): number {
  if (typeof window === "undefined") {
    return TEXT_ANCHOR_TOP_PADDING_PX;
  }

  const parsed = Number.parseFloat(
    window.getComputedStyle(container).scrollPaddingTop,
  );
  if (isPositiveFinite(parsed)) {
    return parsed;
  }
  return TEXT_ANCHOR_TOP_PADDING_PX;
}

export function isElementInPaneView(
  container: HTMLElement,
  target: HTMLElement,
): boolean {
  const containerRect = container.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  return targetRect.bottom > containerRect.top && targetRect.top < containerRect.bottom;
}

export interface ReaderScrollCommands {
  setTop(scrollport: HTMLElement, top: number): void;
  adjustTop(scrollport: HTMLElement, delta: number): void;
  reveal(scrollport: HTMLElement, target: HTMLElement): void;
}

export interface ReaderScrollPositioner {
  run(
    operation: (
      commands: ReaderScrollCommands,
    ) => void | Promise<void>,
  ): Promise<void>;
}

const readerScrollCommands: ReaderScrollCommands = {
  setTop(scrollport, top) {
    scrollport.scrollTop = Math.max(0, top);
  },
  adjustTop(scrollport, delta) {
    scrollport.scrollTop = Math.max(0, scrollport.scrollTop + delta);
  },
  reveal(scrollport, target) {
    const scrollportRect = scrollport.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    if (
      targetRect.top < scrollportRect.top &&
      targetRect.bottom > scrollportRect.bottom
    ) {
      return;
    }
    if (targetRect.top < scrollportRect.top) {
      readerScrollCommands.adjustTop(
        scrollport,
        targetRect.top - scrollportRect.top,
      );
      return;
    }
    if (targetRect.bottom > scrollportRect.bottom) {
      readerScrollCommands.adjustTop(
        scrollport,
        targetRect.bottom - scrollportRect.bottom,
      );
    }
  },
};

function nextLayoutSample(): Promise<void> {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

export function useReaderScrollPositioner(): ReaderScrollPositioner {
  const visibleLocks = useMobileChromeVisibleLocks();
  const run = useCallback<ReaderScrollPositioner["run"]>(
    async (operation) => {
      const release = visibleLocks.acquire("reader-positioning");
      try {
        await operation(readerScrollCommands);
      } finally {
        await nextLayoutSample();
        release();
      }
    },
    [visibleLocks],
  );
  return useMemo(() => ({ run }), [run]);
}
