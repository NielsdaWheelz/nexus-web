/**
 * HtmlRenderer - THE ONLY component that may use dangerouslySetInnerHTML.
 *
 * This component renders sanitized HTML content from the API.
 * It accepts ONLY html_sanitized strings from fragment responses.
 *
 * S0 Constraints:
 * - Render HTML as-is from html_sanitized field
 * - Do NOT perform additional client-side sanitization
 * - Do NOT fetch remote resources or proxy rewrite
 * - Images in HTML render as-is (display if src is reachable)
 *
 * ESLint exception: react/no-danger is disabled for this file only.
 */

import styles from "./HtmlRenderer.module.css";

interface HtmlRendererProps {
  /** Sanitized HTML content from API (must be html_sanitized field) */
  htmlSanitized: string;
  /** Optional class name for the container */
  className?: string;
}

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
