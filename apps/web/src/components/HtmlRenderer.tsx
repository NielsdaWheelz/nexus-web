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

import styles from "./HtmlRenderer.module.css";
// Import highlight styles to ensure they're available when rendering highlights
import "@/lib/highlights/highlights.css";

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
}

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
export default function HtmlRenderer({
  htmlSanitized,
  className,
}: HtmlRendererProps) {
  return (
    <div
      className={`${styles.renderer} ${className || ""}`}
      dangerouslySetInnerHTML={{ __html: htmlSanitized }}
    />
  );
}
