/**
 * HtmlRenderer - THE ONLY component that may use dangerouslySetInnerHTML.
 *
 * This component renders sanitized HTML content from API-owned fields:
 * fragment/EPUB/transcript `html_sanitized` and podcast `description_html`.
 * Callers may apply local transforms that only annotate sanitized HTML, such
 * as highlight spans or podcast timestamp buttons.
 *
 * Constraints:
 * - Do NOT perform additional client-side sanitization
 * - Do NOT fetch remote resources or proxy rewrite
 * - Images in HTML render as-is (display if src is reachable)
 *
 * ESLint exception: react/no-danger is disabled for this file only.
 */

import { memo, useCallback, useEffect, useRef } from "react";
import { useReaderPulseHighlight } from "@/lib/reader/pulseEvent";
import type { RetrievalLocator } from "@/lib/api/sse/locators";
import {
  getPaneScrollContainer,
  scrollElementIntoPaneView,
} from "@/lib/reader/paneScroll";
import styles from "./HtmlRenderer.module.css";

interface HtmlRendererProps {
  /**
   * Sanitized HTML content from the API.
   * This can be either:
   * - Raw `html_sanitized` / `description_html`
   * - Sanitized HTML annotated with highlight spans or timestamp buttons
   *
   * The component treats both the same way: it only renders the HTML.
   */
  htmlSanitized: string;
  /** Optional class name for the container */
  className?: string;
  /**
   * Optional media id used to gate reader-pulse highlight events. When the
   * pulse target's `mediaId` matches, the renderer scrolls to and pulses the
   * matching highlight element.
   */
  mediaId?: string;
}

const PULSE_DURATION_MS = 1200;

/**
 * Renders sanitized HTML content.
 *
 * This is the ONLY component in the application that may use
 * dangerouslySetInnerHTML. All HTML rendered through this component
 * must come from an API-owned sanitized HTML field or be processed
 * by a local transform that only annotates already-sanitized HTML.
 *
 * @example
 * ```tsx
 * // Raw sanitized fragment HTML.
 * <HtmlRenderer htmlSanitized={fragment.html_sanitized} />
 *
 * // Sanitized fragment HTML with local highlight annotations.
 * const { html } = applyHighlightsToHtml(
 *   fragment.html_sanitized,
 *   fragment.canonical_text,
 *   fragment.id,
 *   highlights
 * );
 * <HtmlRenderer htmlSanitized={html} />
 * ```
 */
export default memo(function HtmlRenderer({
  htmlSanitized,
  className,
  mediaId,
}: HtmlRendererProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);

  useReaderPulseHighlight(
    useCallback(
      (target) => {
        if (!mediaId || target.mediaId !== mediaId) return;
        const root = rootRef.current;
        if (!root) return;
        const candidates = collectPulseCandidates(
          root,
          target.locator,
          target.snippet,
          target.highlightId,
        );
        for (const candidate of candidates) {
          const container = getPaneScrollContainer(candidate);
          if (container) {
            scrollElementIntoPaneView(container, candidate, { block: "center" });
          }
          candidate.classList.add(styles.pulsing);
          window.setTimeout(() => {
            candidate.classList.remove(styles.pulsing);
          }, PULSE_DURATION_MS);
        }
      },
      [mediaId],
    ),
  );

  // Tag direct-child <p> elements so focus mode and reading metrics can target them.
  // Runs after each render of htmlSanitized; safe and idempotent (same selector each time).
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    for (const paragraph of Array.from(root.children)) {
      if (paragraph.tagName === "P") {
        paragraph.setAttribute("data-paragraph", "true");
      }
    }
  }, [htmlSanitized]);

  // Reflect non-collapsed selections inside this renderer so focus-mode dimming can suspend.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const handleSelectionChange = () => {
      const selection = document.getSelection();
      const isActive =
        selection !== null &&
        !selection.isCollapsed &&
        selection.rangeCount > 0 &&
        root.contains(selection.getRangeAt(0).commonAncestorContainer);
      if (isActive) {
        root.setAttribute("data-selection-active", "true");
      } else {
        root.removeAttribute("data-selection-active");
      }
    };
    document.addEventListener("selectionchange", handleSelectionChange);
    return () => {
      document.removeEventListener("selectionchange", handleSelectionChange);
    };
  }, []);

  return (
    <div
      ref={rootRef}
      className={`${styles.renderer} ${className || ""}`}
      data-testid="html-renderer"
      dangerouslySetInnerHTML={{ __html: htmlSanitized }}
    />
  );
});

function collectPulseCandidates(
  root: HTMLElement,
  locator: RetrievalLocator,
  snippet: string | null,
  highlightId: string | undefined,
): HTMLElement[] {
  if (highlightId) {
    const matches = root.querySelectorAll<HTMLElement>(
      `[data-active-highlight-ids~="${CSS.escape(highlightId)}"]`,
    );
    if (matches.length > 0) return Array.from(matches);
  }

  const fragmentId =
    locator.type === "web_text_offsets" || locator.type === "epub_fragment_offsets"
      ? locator.fragment_id
      : null;
  if (fragmentId) {
    const scoped = root.querySelectorAll<HTMLElement>(
      `[data-fragment-id="${CSS.escape(fragmentId)}"] [data-active-highlight-ids]`,
    );
    if (scoped.length > 0) return Array.from(scoped);
  }
  if (snippet) {
    const all = root.querySelectorAll<HTMLElement>("[data-active-highlight-ids]");
    const matches = Array.from(all).filter((element) =>
      element.textContent?.includes(snippet),
    );
    if (matches.length > 0) return matches;
  }
  const fallback = root.querySelectorAll<HTMLElement>("[data-active-highlight-ids]");
  return fallback.length > 0 ? [fallback[0]] : [];
}
