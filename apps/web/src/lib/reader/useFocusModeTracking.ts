"use client";

import { useEffect, useState, type RefObject } from "react";
import type { ReaderFocusMode } from "@/lib/reader/types";

const CHROME_REVEAL_TIMEOUT_MS = 3000;

/**
 * Wires reader focus-mode DOM tracking inside `readerRootRef`:
 * - paragraph/sentence emphasis via IntersectionObserver + viewport-centered
 *   pick, with Intl.Segmenter sentence segmentation when available
 * - distraction-free chrome reveal that surfaces on pointer movement and hides
 *   after `CHROME_REVEAL_TIMEOUT_MS` of idle
 *
 * `renderedHtmlSignal` re-attaches the observer when the reader's content
 * (paragraph DOM) changes identity.
 */
export function useFocusModeTracking(
  focusMode: ReaderFocusMode,
  readerRootRef: RefObject<HTMLElement | null>,
  renderedHtmlSignal: string,
): { chromeRevealed: boolean } {
  const [chromeRevealed, setChromeRevealed] = useState(false);

  // IntersectionObserver tracks the paragraph nearest viewport vertical center.
  // For sentence mode, segment the active paragraph's text via Intl.Segmenter
  // and mark the sentence containing the line nearest the center. Without
  // Intl.Segmenter, sentence mode silently behaves like paragraph mode.
  useEffect(() => {
    if (focusMode !== "paragraph" && focusMode !== "sentence") {
      return;
    }
    const root = readerRootRef.current;
    if (!root) return;

    function clearSentenceMarkers(paragraph: Element) {
      for (const node of Array.from(
        paragraph.querySelectorAll<HTMLElement>(
          '[data-sentence-current="true"]',
        ),
      )) {
        node.removeAttribute("data-sentence-current");
      }
      const wrapped = paragraph.querySelector<HTMLElement>(
        '[data-sentence-wrap="true"]',
      );
      if (wrapped) {
        const original = wrapped.getAttribute("data-sentence-original");
        if (original !== null) {
          paragraph.textContent = original;
        }
      }
    }

    function markSentenceNearViewportCenter(paragraph: Element) {
      const SegmenterCtor = (
        globalThis as {
          Intl: typeof Intl & { Segmenter?: typeof Intl.Segmenter };
        }
      ).Intl.Segmenter;
      if (!SegmenterCtor) return;
      // Only segment plain-text paragraphs. If the paragraph contains element
      // children (highlights, links, code, etc.), rewriting the DOM would
      // destroy that structure, so silently downgrade to paragraph-only
      // emphasis.
      if (paragraph.childElementCount !== 0) return;
      const text = paragraph.textContent ?? "";
      if (text.length === 0) return;

      const segmenter = new SegmenterCtor(undefined, {
        granularity: "sentence",
      });
      const segments = Array.from(segmenter.segment(text));
      if (segments.length === 0) return;

      const originalText = text;
      const fragment = document.createDocumentFragment();
      for (const segment of segments) {
        const span = document.createElement("span");
        span.setAttribute("data-sentence", "true");
        span.textContent = segment.segment;
        fragment.appendChild(span);
      }
      const sentinel = document.createElement("span");
      sentinel.setAttribute("data-sentence-wrap", "true");
      sentinel.setAttribute("data-sentence-original", originalText);
      sentinel.style.display = "contents";
      sentinel.appendChild(fragment);
      paragraph.replaceChildren(sentinel);

      const center = window.innerHeight / 2;
      let bestEl: HTMLElement | null = null;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (const el of Array.from(
        paragraph.querySelectorAll<HTMLElement>('[data-sentence="true"]'),
      )) {
        const rect = el.getBoundingClientRect();
        const sentenceCenter = rect.top + rect.height / 2;
        const distance = Math.abs(sentenceCenter - center);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestEl = el;
        }
      }
      if (bestEl) {
        bestEl.setAttribute("data-sentence-current", "true");
      }
    }

    function pickCenteredParagraph(scope: HTMLElement): Element | null {
      const paragraphs = Array.from(
        scope.querySelectorAll<HTMLElement>('[data-paragraph="true"]'),
      );
      if (paragraphs.length === 0) return null;
      const center = window.innerHeight / 2;
      let bestEl: Element | null = null;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (const el of paragraphs) {
        const rect = el.getBoundingClientRect();
        if (rect.height === 0) continue;
        const elementCenter = rect.top + rect.height / 2;
        const distance = Math.abs(elementCenter - center);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestEl = el;
        }
      }
      return bestEl;
    }

    let lastCurrent: Element | null = null;
    const scopedRoot = root;

    const applyCurrent = () => {
      const next = pickCenteredParagraph(scopedRoot);
      const previous = lastCurrent;
      if (next === previous) return;
      if (previous) {
        previous.removeAttribute("data-paragraph-current");
        clearSentenceMarkers(previous);
      }
      if (next) {
        next.setAttribute("data-paragraph-current", "true");
        if (focusMode === "sentence") {
          markSentenceNearViewportCenter(next);
        }
      }
      lastCurrent = next;
    };

    const observer = new IntersectionObserver(applyCurrent, {
      rootMargin: "0px",
      threshold: [0, 0.25, 0.5, 0.75, 1],
    });
    const paragraphs = Array.from(
      root.querySelectorAll<HTMLElement>('[data-paragraph="true"]'),
    );
    for (const paragraph of paragraphs) {
      observer.observe(paragraph);
    }
    applyCurrent();
    window.addEventListener("scroll", applyCurrent, { passive: true });

    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", applyCurrent);
      if (lastCurrent) {
        lastCurrent.removeAttribute("data-paragraph-current");
        clearSentenceMarkers(lastCurrent);
      }
    };
  }, [focusMode, readerRootRef, renderedHtmlSignal]);

  // Distraction-free chrome reveal: pointer movement keeps chrome visible for
  // CHROME_REVEAL_TIMEOUT_MS of idle time. Exits silently in the off case.
  useEffect(() => {
    if (focusMode === "off") {
      setChromeRevealed(false);
      return;
    }
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    function handlePointerMove() {
      setChromeRevealed(true);
      if (timeoutId !== null) clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        setChromeRevealed(false);
      }, CHROME_REVEAL_TIMEOUT_MS);
    }
    window.addEventListener("pointermove", handlePointerMove);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      if (timeoutId !== null) clearTimeout(timeoutId);
    };
  }, [focusMode]);

  return { chromeRevealed };
}
