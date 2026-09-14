/**
 * HtmlRenderer - THE ONLY component that may use dangerouslySetInnerHTML.
 *
 * This component renders sanitized HTML content from API-owned fields:
 * fragment/EPUB/transcript `html_sanitized` and podcast `description_html`.
 * Callers may apply local transforms that annotate sanitized HTML, such as
 * highlight spans or podcast timestamp buttons. This renderer may also apply
 * an explicit heading-level projection beneath an owning route heading.
 *
 * Constraints:
 * - Do NOT perform additional client-side sanitization
 * - Do NOT fetch remote resources or proxy rewrite
 * - Images in HTML render as-is (display if src is reachable)
 *
 * ESLint exception: react/no-danger is disabled for this file only.
 */

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { usePaneRuntime } from "@/lib/panes/paneRuntime";
import { useReaderPulseHighlight } from "@/lib/reader/pulseEvent";
import type { RetrievalLocator } from "@/lib/api/sse/locators";
import {
  getPaneScrollContainer,
} from "@/lib/reader/paneScroll";
import type { ReaderScrollPositioner } from "@/lib/reader/paneScroll";
import styles from "./HtmlRenderer.module.css";

interface HtmlRendererCommonProps {
  /** Optional class name for the container */
  className?: string;
  /**
   * Optional media id used to gate reader-pulse highlight events. When the
   * pulse target's `mediaId` matches, the renderer scrolls to and pulses the
   * matching highlight element.
   */
  mediaId?: string;
  /** Reader-owned positioning boundary for pulse navigation. */
  scrollPositioner?: ReaderScrollPositioner;
}

type HtmlRendererProps = HtmlRendererCommonProps & (
  | { htmlSanitized: string; preparedRoot?: never; headingLevelOffset?: 1 | 2 | 3 | 4 | 5 }
  /** Publication preparation already admitted and projected these exact nodes. */
  | { preparedRoot: HTMLElement; htmlSanitized?: never; headingLevelOffset?: never }
);

const PULSE_DURATION_MS = 1200;

function projectHtmlHeadingLevels(
  html: string,
  offset: NonNullable<HtmlRendererProps["headingLevelOffset"]>,
): string {
  return html.replace(
    /<(\/?)h([1-6])(?=[\s>])/gi,
    (_match, closing: string, levelText: string) => {
      const level = Number.parseInt(levelText, 10);
      return `<${closing}h${Math.min(6, level + offset)}`;
    },
  );
}

/**
 * Renders sanitized HTML content.
 *
 * This is the ONLY component in the application that may use
 * dangerouslySetInnerHTML. All HTML rendered through this component
 * must come from an API-owned sanitized HTML field or be processed
 * by a local annotation transform. The optional heading projection changes
 * semantics only; it preserves sanitized attributes and anchor IDs.
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
  preparedRoot,
  className,
  mediaId,
  scrollPositioner,
  headingLevelOffset,
}: HtmlRendererProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const paneId = usePaneRuntime()?.paneId ?? null;
  const projectedHtml = useMemo(
    () =>
      htmlSanitized === undefined ? null : headingLevelOffset
        ? projectHtmlHeadingLevels(htmlSanitized, headingLevelOffset)
        : htmlSanitized,
    [headingLevelOffset, htmlSanitized],
  );

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (root === null || preparedRoot === undefined) return;
    root.replaceChildren(preparedRoot);
    return () => {
      if (preparedRoot.parentNode === root) root.removeChild(preparedRoot);
    };
  }, [preparedRoot]);

  useReaderPulseHighlight(
    useCallback(
      (target) => {
        if (!mediaId || target.mediaId !== mediaId || target.paneId !== paneId || preparedRoot !== undefined) return;
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
          if (container && scrollPositioner) {
            void scrollPositioner.run(({ reveal }) => {
              reveal(container, candidate);
            });
          }
          candidate.classList.add(styles.pulsing);
          window.setTimeout(() => {
            candidate.classList.remove(styles.pulsing);
          }, PULSE_DURATION_MS);
        }
      },
      [mediaId, paneId, preparedRoot, scrollPositioner],
    ),
  );

  // Tag direct-child <p> elements so focus mode and reading metrics can target them.
  // Runs after each projected-HTML render; safe and idempotent (same selector each time).
  useEffect(() => {
    const root = preparedRoot ?? rootRef.current;
    if (!root) return;
    for (const paragraph of Array.from(root.children)) {
      if (paragraph.tagName === "P") {
        paragraph.setAttribute("data-paragraph", "true");
      }
    }
  }, [preparedRoot, projectedHtml]);

  return (
    <div
      ref={rootRef}
      className={`${styles.renderer} ${className || ""}`}
      data-testid="html-renderer"
      dangerouslySetInnerHTML={projectedHtml === null ? undefined : { __html: projectedHtml }}
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
    locator.type === "web_text_offsets" ||
    locator.type === "epub_fragment_offsets"
      ? locator.fragment_id
      : null;
  if (fragmentId) {
    const scoped = root.querySelectorAll<HTMLElement>(
      `[data-fragment-id="${CSS.escape(fragmentId)}"] [data-active-highlight-ids]`,
    );
    if (scoped.length > 0) return Array.from(scoped);
  }
  if (snippet) {
    const all = root.querySelectorAll<HTMLElement>(
      "[data-active-highlight-ids]",
    );
    const matches = Array.from(all).filter((element) =>
      element.textContent?.includes(snippet),
    );
    if (matches.length > 0) return matches;
  }
  const fallback = root.querySelectorAll<HTMLElement>(
    "[data-active-highlight-ids]",
  );
  return fallback.length > 0 ? [fallback[0]] : [];
}
