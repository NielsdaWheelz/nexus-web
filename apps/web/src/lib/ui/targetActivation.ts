import type { MouseEvent as ReactMouseEvent } from "react";

/** A gesture changes placement, never the destination or the underlying write. */
export type OpenIntent = "default" | "new_pane";

export type TargetLinkMouseEvent = Pick<
  ReactMouseEvent,
  | "altKey"
  | "button"
  | "ctrlKey"
  | "defaultPrevented"
  | "metaKey"
  | "preventDefault"
  | "shiftKey"
>;

/** React and native keyboard events share this boundary. */
export type TargetLinkKeyEvent = Pick<
  KeyboardEvent,
  | "altKey"
  | "ctrlKey"
  | "defaultPrevented"
  | "key"
  | "metaKey"
  | "preventDefault"
  | "repeat"
  | "shiftKey"
> & {
  readonly isComposing?: boolean;
  readonly keyCode?: number;
  readonly nativeEvent?: { readonly isComposing: boolean };
};

export type TargetActivationEvent = TargetLinkMouseEvent | TargetLinkKeyEvent;
export type TargetActivation =
  | { readonly kind: "Open"; readonly intent: OpenIntent }
  | { readonly kind: "Consume" }
  | { readonly kind: "Unowned" };

/** Plain Enter keeps its native click; shifted Enter is handled before that click. */
export function workspaceTargetActivationIntent(
  event: TargetActivationEvent,
  enter: "native" | "activate" = "native",
): TargetActivation {
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey)
    return { kind: "Unowned" };
  if ("key" in event) {
    if (event.key !== "Enter") return { kind: "Unowned" };
    if (event.repeat || event.isComposing || event.nativeEvent?.isComposing || event.keyCode === 229)
      return { kind: "Consume" };
    return event.shiftKey ? { kind: "Open", intent: "new_pane" }
      : enter === "activate" ? { kind: "Open", intent: "default" } : { kind: "Unowned" };
  }
  if (event.button !== 0) return { kind: "Unowned" };
  return { kind: "Open", intent: event.shiftKey ? "new_pane" : "default" };
}
