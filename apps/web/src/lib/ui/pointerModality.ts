/**
 * Which input activated a control. A click the browser synthesises from Enter or
 * Space carries `detail === 0`; a real pointer click carries its click count.
 */
export function pointerModality(event: {
  readonly detail: number;
}): "Keyboard" | "Pointer" {
  return event.detail === 0 ? "Keyboard" : "Pointer";
}
