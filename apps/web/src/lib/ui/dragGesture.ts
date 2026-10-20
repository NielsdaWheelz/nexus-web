/**
 * Physical release ownership outlives a cancelled drag and its mounted origin.
 * Only the matching trusted pointer-click is consumed; a fresh gesture retires it.
 */
export function suppressDragReleaseClick(pointerId: number): void {
  const controller = new AbortController();
  const options = { capture: true, signal: controller.signal };
  const clear = () => controller.abort();
  let released = false;
  document.addEventListener("pointerup", (event) => {
    if (event.pointerId === pointerId) released = true;
  }, options);
  document.addEventListener("pointercancel", (event) => {
    if (event.pointerId === pointerId) clear();
  }, options);
  document.addEventListener("pointerdown", (event) => {
    if (event.isPrimary && event.button === 0) clear();
  }, options);
  // next's document root runs react capture handlers before later document listeners.
  window.addEventListener("click", (event) => {
    if (!released || !event.isTrusted || event.detail === 0) return;
    if (event instanceof PointerEvent && event.pointerId !== pointerId) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    clear();
  }, options);
  window.addEventListener("blur", clear, { signal: controller.signal });
}

/** Synchronously cancels the owning scrollport's pending pull gesture. */
export const TOUCH_DRAG_CLAIMED = "nexus:touch-drag-claimed";
