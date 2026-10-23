// A completed plain reader tap. Native pan, selection and semantic controls
// keep their gestures; window capture records ownership before light-dismiss.
import { isInteractiveTarget } from "@/lib/ui/eventTarget";
import { hasActiveInteractionOwner } from "@/lib/ui/overlay";

const TAP_SLOP_PX = 8;

export function listenForReaderTap(port: HTMLElement, onTap: () => void): () => void {
  let candidate: {
    id: number;
    x: number;
    y: number;
  } | null = null;
  // WebView may deliver several complete pointer gestures before their clicks.
  // A later down must not replace an earlier gesture awaiting its native click.
  // A missing click retains one inert id until reuse, context menu or cleanup;
  // that small reader-lifetime cost preserves other pointers' delayed clicks.
  const completed = new Set<number>();
  const pending = new Set<number>();
  // Reader-owned focusable reading surfaces mark their own input boundary.
  // Their tabindex serves keyboard reading; controls inside still own gestures.
  const interactive = (target: EventTarget | null) => {
    const boundary = target instanceof Element ? target.closest("[data-reader-input-boundary]") : null;
    return isInteractiveTarget(target, boundary && port.contains(boundary) ? boundary : port);
  };

  const down = (event: PointerEvent) => {
    const interrupted = candidate !== null;
    candidate = null;
    completed.delete(event.pointerId);
    if (
      interrupted || !event.isTrusted || !event.isPrimary || event.button !== 0 ||
      event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
      !(event.target instanceof Node) || !port.contains(event.target) ||
      document.getSelection()?.isCollapsed === false ||
      interactive(event.target) || hasActiveInteractionOwner()
    ) return;
    candidate = { id: event.pointerId, x: event.clientX, y: event.clientY };
  };
  const move = (event: PointerEvent) => {
    if (!event.isTrusted || candidate?.id !== event.pointerId) return;
    if (Math.hypot(event.clientX - candidate.x, event.clientY - candidate.y) > TAP_SLOP_PX)
      candidate = null;
  };
  const up = (event: PointerEvent) => {
    if (!event.isTrusted || candidate?.id !== event.pointerId) return;
    const ended = candidate;
    candidate = null;
    if (
      !event.isPrimary || event.button !== 0 ||
      !(event.target instanceof Node) || !port.contains(event.target) ||
      Math.hypot(event.clientX - ended.x, event.clientY - ended.y) > TAP_SLOP_PX
    ) return;
    completed.add(ended.id);
  };
  const cancel = (event: PointerEvent) => {
    if (candidate?.id === event.pointerId) candidate = null;
    completed.delete(event.pointerId);
  };
  const clearGestures = () => {
    candidate = null;
    completed.clear();
  };
  const clear = () => {
    clearGestures();
    for (const timer of pending) window.clearTimeout(timer);
    pending.clear();
  };
  const click = (event: PointerEvent) => {
    if (
      !event.isTrusted || !completed.delete(event.pointerId) ||
      event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
    ) return;
    // React's semantic handlers run later in this dispatch and may consume it.
    const timer = window.setTimeout(() => {
      pending.delete(timer);
      if (
        event.defaultPrevented || !(event.target instanceof Node) ||
        !port.contains(event.target) || document.getSelection()?.isCollapsed === false ||
        interactive(event.target) || hasActiveInteractionOwner()
      ) return;
      onTap();
    }, 0);
    pending.add(timer);
  };

  const capture = { capture: true, passive: true };
  window.addEventListener("pointerdown", down, capture);
  window.addEventListener("pointermove", move, capture);
  window.addEventListener("pointerup", up, capture);
  window.addEventListener("pointercancel", cancel, capture);
  window.addEventListener("contextmenu", clearGestures, capture);
  window.addEventListener("blur", clear);
  port.addEventListener("click", click);
  return () => {
    clear();
    window.removeEventListener("pointerdown", down, true);
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", up, true);
    window.removeEventListener("pointercancel", cancel, true);
    window.removeEventListener("contextmenu", clearGestures, true);
    window.removeEventListener("blur", clear);
    port.removeEventListener("click", click);
  };
}
