import { isEditableTarget } from "@/lib/ui/isEditableTarget";

export type TrustedScrollDirection = "forward" | "backward";
export type ReaderScrollKeyIntent =
  | { kind: "Traverse"; direction: TrustedScrollDirection }
  | { kind: "Seek"; edge: "Start" | "End" };

/** Native scroll keys express reading only when the focused control does not own them. */
export function readerScrollKeyIntent(event: KeyboardEvent): ReaderScrollKeyIntent | null {
  if (!event.isTrusted || event.altKey || event.ctrlKey || event.metaKey || isEditableTarget(event.target)) return null;
  if (event.key === " " || event.key === "Spacebar") {
    if (event.target instanceof Element && event.target.closest("button, [role='button']")) return null;
    return { kind: "Traverse", direction: event.shiftKey ? "backward" : "forward" };
  }
  if (event.key === "End") return { kind: "Seek", edge: "End" };
  if (event.key === "Home") return { kind: "Seek", edge: "Start" };
  if (event.key === "ArrowDown" || event.key === "PageDown") return { kind: "Traverse", direction: "forward" };
  if (event.key === "ArrowUp" || event.key === "PageUp") return { kind: "Traverse", direction: "backward" };
  return null;
}

/** Scrollbar events target the scrollport, including native overlay scrollbars.
 * Empty-background presses share that target; no movement settles as Unchanged. */
export function isReaderScrollbarSeekStart(
  event: PointerEvent,
  viewport: HTMLElement,
): boolean {
  return event.isTrusted && event.button === 0 && event.pointerType !== "touch" &&
    event.target === viewport;
}
