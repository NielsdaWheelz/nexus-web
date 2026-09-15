import { isEditableTarget } from "@/lib/ui/isEditableTarget";

export type TrustedScrollDirection = "forward" | "backward";

/** Native scroll keys express reading only when the focused control does not own them. */
export function readerScrollKeyDirection(event: KeyboardEvent): TrustedScrollDirection | null {
  if (!event.isTrusted || event.altKey || event.ctrlKey || event.metaKey || isEditableTarget(event.target)) return null;
  if (event.key === " " || event.key === "Spacebar") {
    if (event.target instanceof Element && event.target.closest("button, [role='button']")) return null;
    return event.shiftKey ? "backward" : "forward";
  }
  if (event.key === "ArrowDown" || event.key === "PageDown" || event.key === "End") return "forward";
  if (event.key === "ArrowUp" || event.key === "PageUp" || event.key === "Home") return "backward";
  return null;
}
