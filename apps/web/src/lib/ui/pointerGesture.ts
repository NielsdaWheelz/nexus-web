"use client";

import {useCallback, useEffect, useRef} from "react";

/** A pointer press is still activating its target; presses inside `within`, when
 * given, do not count. Focus leaves at pointerdown, but the target activates at click,
 * so anything that moves layout on departure must wait. onComplete runs at the
 * rendering boundary after activation. */
export function usePointerGesture(input: {
  enabled: boolean;
  within?(target: EventTarget | null): boolean;
  onComplete(outside: boolean): void;
}): {active(): boolean; reset(): void} {
  const latest = useRef(input); latest.current = input;
  const pressed = useRef(false), completion = useRef(0);
  const active = useCallback(() => pressed.current, []);
  const reset = useCallback(() => {cancelAnimationFrame(completion.current); pressed.current = false;}, []);
  useEffect(() => {
    if (!input.enabled) return;
    const down = (event: PointerEvent) => {cancelAnimationFrame(completion.current); pressed.current = !latest.current.within?.(event.target);};
    const finish = () => {const outside = pressed.current; pressed.current = false; latest.current.onComplete(outside);};
    // A captured click can precede target handlers and their microtasks. Its
    // next rendering boundary certifies activation completion; pointerup cannot
    // do that for a delayed touch click. Native cancellation/drag end complete
    // their own gestures without predicting a click.
    const complete = () => {cancelAnimationFrame(completion.current); completion.current = requestAnimationFrame(finish);};
    const key = () => {if (pressed.current) complete();};
    // Window capture precedes every document listener. The overlay's light dismiss is one,
    // registered with the first layer: the close it commits reaches consumers before the
    // next listener runs, so a press recorded later would already have moved its target.
    window.addEventListener("pointerdown", down, true); document.addEventListener("click", complete, true);
    document.addEventListener("pointercancel", complete, true); document.addEventListener("dragend", complete, true); document.addEventListener("keydown", key);
    return () => {
      reset();
      window.removeEventListener("pointerdown", down, true); document.removeEventListener("click", complete, true);
      document.removeEventListener("pointercancel", complete, true); document.removeEventListener("dragend", complete, true); document.removeEventListener("keydown", key);
    };
  }, [input.enabled, reset]);
  return {active, reset};
}
