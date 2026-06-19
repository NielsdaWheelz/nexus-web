/**
 * True when an event target sits inside a nested interactive element, so a row's
 * own activation (click/Enter on the row) must not fire. Shared by `ResourceRow`
 * and `ItemCard`.
 *
 * When `boundary` is supplied (the activating element itself, e.g. a primary
 * `<button>` that wraps its own content), it is treated as the activation surface
 * rather than a nested control: clicks on it or its inert content still activate;
 * only a *different* interactive element nested inside it suppresses activation.
 */
export function isNestedInteractiveTarget(
  target: EventTarget | null,
  boundary?: EventTarget | null,
): boolean {
  if (!(target instanceof Element)) {
    return false;
  }
  const interactive = target.closest(
    'a, button, input, textarea, select, summary, [contenteditable="true"], .ProseMirror',
  );
  if (interactive === null) {
    return false;
  }
  return interactive !== boundary;
}
