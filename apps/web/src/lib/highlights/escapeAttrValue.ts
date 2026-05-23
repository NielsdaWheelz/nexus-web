/**
 * Escape a value for safe embedding in a CSS attribute selector
 * (e.g. `[data-highlight-id="<value>"]`).
 *
 * Uses native CSS.escape where available; falls back to escaping the two
 * characters that would terminate a quoted attribute selector.
 */
export function escapeAttrValue(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
