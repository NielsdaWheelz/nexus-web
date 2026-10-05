/**
 * HtmlRenderer - THE ONLY component that may use dangerouslySetInnerHTML.
 *
 * It renders sanitized HTML from API-owned fields (`html_sanitized`,
 * `description_html`, apparatus bodies) as given: no client-side sanitizing,
 * fetching or rewriting, except an optional heading-level projection beneath
 * an owning route heading (ids and every other attribute are kept).
 *
 * ESLint exception: react/no-danger is disabled for this file only.
 */
import { memo } from "react";
import styles from "./HtmlRenderer.module.css";

export default memo(function HtmlRenderer({
  htmlSanitized,
  className,
  headingLevelOffset,
}: {
  readonly htmlSanitized: string;
  readonly className?: string;
  readonly headingLevelOffset?: 1 | 2 | 3 | 4 | 5;
}) {
  const html = headingLevelOffset
    ? htmlSanitized.replace(
        /<(\/?)h([1-6])(?=[\s>])/gi,
        (_match, closing: string, level: string) =>
          `<${closing}h${Math.min(6, Number(level) + headingLevelOffset)}`,
      )
    : htmlSanitized;
  return (
    <div
      className={`${styles.renderer} ${className ?? ""}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
});
