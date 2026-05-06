/**
 * HtmlRenderer - THE ONLY component that may use dangerouslySetInnerHTML.
 *
 * This component renders sanitized HTML content from the API.
 * It accepts ONLY html_sanitized strings from fragment responses,
 * optionally with highlights already applied.
 *
 * S2 Constraints:
 * - Render HTML as-is from html_sanitized field
 * - Support pre-rendered HTML with highlight spans (PR-08)
 * - Do NOT perform additional client-side sanitization
 * - Do NOT fetch remote resources or proxy rewrite
 * - Images in HTML render as-is (display if src is reachable)
 *
 * ESLint exception: react/no-danger is disabled for this file only.
 *
 * @see docs/v1/s2/s2_prs/s2_pr08.md
 */

import { memo, useCallback, useEffect, useRef } from "react";
import { useReaderPulseHighlight } from "@/lib/reader/pulseEvent";
import styles from "./HtmlRenderer.module.css";

interface HtmlRendererProps {
  /**
   * Sanitized HTML content from API (must be html_sanitized field).
   * This can be either:
   * - Raw html_sanitized (no highlights)
   * - Pre-rendered HTML with highlight spans applied via applyHighlightsToHtml()
   *
   * The component treats both the same way - it just renders the HTML.
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
 * must come from the API's html_sanitized field or be processed
 * through applyHighlightsToHtml() which only adds highlight spans.
 *
 * @example
 * ```tsx
 * // Without highlights (original behavior)
 * <HtmlRenderer htmlSanitized={fragment.html_sanitized} />
 *
 * // With highlights (PR-08 behavior)
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
        const candidates = collectPulseCandidates(root, target.locator, target.snippet);
        for (const candidate of candidates) {
          candidate.scrollIntoView({ behavior: "smooth", block: "center" });
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
  locator: unknown,
  snippet: string | null,
): HTMLElement[] {
  const record = (locator as Record<string, unknown> | null) ?? null;
  const fragmentId = record && typeof record.fragment_id === "string" ? record.fragment_id : null;
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
