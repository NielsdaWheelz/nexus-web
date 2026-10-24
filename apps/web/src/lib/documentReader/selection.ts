"use client";

import { useCallback, useEffect, useRef, type RefObject } from "react";
import { isEditableTarget } from "@/lib/ui/eventTarget";
import type { SelectionCandidate, SelectionEvent, SelectionNotice } from "./DocumentReader";

const EXTENDING_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"]);

/** Observe native ranges; only completed trusted reader gestures admit a session. */
export function useReaderSelection(
  root: RefObject<HTMLElement | null>,
  options: {
    readonly identity: string;
    readonly textSelector: string;
    readonly capture: (selection: Selection) => SelectionCandidate | null;
    readonly onSelection: ((notice: SelectionNotice) => void) | undefined;
    readonly onSelecting?: (selecting: boolean) => void;
  },
) {
  const input = useRef<SelectionEvent["input"]>("pointer");
  const current = useRef(options);
  current.current = options;
  const enabled = options.onSelection !== undefined;
  const observing = enabled || options.onSelecting !== undefined;
  const sourceElement = useCallback((target: EventTarget | null) => {
    const node = target instanceof Node ? target : null;
    const element = node instanceof Element ? node : node?.parentElement;
    const source = element?.closest("[data-reader-unit]");
    const embedUi = element?.closest("[data-document-embed-ui]");
    return element && root.current?.isConnected && root.current.contains(element) &&
      !isEditableTarget(element) && !element.closest("button,[data-reader-metadata],[hidden],[inert]") &&
      (!embedUi || source && embedUi.contains(source)) ? element : null;
  }, [root]);
  const selected = useCallback(() => {
    const selection = document.getSelection();
    return selection && !selection.isCollapsed && selection.rangeCount > 0 &&
      sourceElement(selection.anchorNode)?.closest(current.current.textSelector) &&
      sourceElement(selection.focusNode)?.closest(current.current.textSelector)
      ? selection : null;
  }, [sourceElement]);
  const captureSelection = useCallback((): SelectionEvent | null => {
    const selection = selected();
    const capture = selection && current.current.capture(selection);
    return capture ? { ...capture, identity: current.current.identity, input: input.current } : null;
  }, [selected]);

  useEffect(() => {
    if (!observing) return;
    let pointer: { id: number; input: "pointer" | "touch"; range: Range | null; changed: boolean; reengaged: boolean; admit: boolean } | null = null;
    let keyboard = false;
    // Completed gestures can precede each other's native clicks. Missing clicks
    // retain only an id until reuse, cancellation, blur or reader disposal.
    const suppressedClicks = new Set<number>();
    let touchCandidate = false;
    let touchOwned = false;
    let touchAnchor: string | null = null;
    let touchRejected = false;
    const inText = (target: EventTarget | null) => Boolean(sourceElement(target)?.closest(current.current.textSelector));
    const observe = () => {
      current.current.onSelection?.({
        kind: "Observed", selection: captureSelection(), inputHeld: pointer !== null || keyboard,
      });
    };
    const sameRange = (before: Range | null, after: Range | null) => before === null || after === null
      ? before === after
      : before.startContainer === after.startContainer && before.startOffset === after.startOffset &&
        before.endContainer === after.endContainer && before.endOffset === after.endOffset;
    const hitsRange = (range: Range | null, event: PointerEvent) => range !== null && [...range.getClientRects()].some((rect) =>
      rect.width > 0 && rect.height > 0 && event.clientX >= rect.left && event.clientX <= rect.right &&
      event.clientY >= rect.top && event.clientY <= rect.bottom);
    const commit = (kind: SelectionEvent["input"]) => {
      const capture = captureSelection();
      if (!capture || !current.current.onSelection) return;
      if (kind === "touch") {
        if (capture.kind === "Rejected") {
          if (touchRejected) return;
          touchRejected = true;
          touchAnchor = null;
        } else {
          touchRejected = false;
          const key = JSON.stringify(capture.anchor);
          if (key === touchAnchor) return;
          touchAnchor = key;
        }
      }
      current.current.onSelection({ kind: "Admitted", selection: { ...capture, input: kind } });
    };
    const selectionchange = () => {
      const selection = selected();
      if (pointer && !sameRange(pointer.range, selection?.getRangeAt(0) ?? null)) pointer.changed = true;
      const native = document.getSelection();
      current.current.onSelecting?.(Boolean(
        native && !native.isCollapsed && inText(native.anchorNode),
      ));
      observe();
      if (!selection) {
        touchOwned = false;
        touchAnchor = null;
      } else if (touchOwned) commit("touch");
    };
    const down = (event: PointerEvent) => {
      suppressedClicks.delete(event.pointerId);
      touchOwned = false;
      touchCandidate = false;
      touchAnchor = null;
      touchRejected = false;
      // Owned controls capture before their default focus transfer. Their
      // presses are not source activity, even while a native range survives.
      if (!event.isTrusted || !event.isPrimary || event.button !== 0 || !sourceElement(event.target)) return;
      pointer = null;
      keyboard = false;
      input.current = event.pointerType === "touch" ? "touch" : "pointer";
      const range = selected()?.getRangeAt(0).cloneRange() ?? null;
      const admit = inText(event.target);
      pointer = { id: event.pointerId, input: input.current, range, changed: false, reengaged: hitsRange(range, event), admit };
      touchCandidate = admit && input.current === "touch";
      observe();
    };
    const up = (event: PointerEvent) => {
      if (!event.isTrusted || pointer?.id !== event.pointerId) return;
      const gesture = pointer;
      pointer = null;
      const range = selected()?.getRangeAt(0) ?? null;
      // A lingering native range elsewhere is not this press's selection.
      const selectedRange = range !== null && (gesture.changed || !sameRange(gesture.range, range) ||
        gesture.reengaged && hitsRange(range, event));
      // Clearing a selection also owns the click; it cannot activate the link
      // or mark underneath after the browser collapses the native range.
      if (gesture.admit && (gesture.range !== null || selectedRange)) suppressedClicks.add(gesture.id);
      touchOwned = gesture.admit && gesture.input === "touch" && selectedRange;
      observe();
      if (gesture.admit && selectedRange) commit(gesture.input);
    };
    const cancel = (event: PointerEvent) => {
      if (pointer?.id === event.pointerId) {
        pointer = null;
        observe();
      }
      suppressedClicks.delete(event.pointerId);
    };
    const contextmenu = (event: MouseEvent) => {
      // Native long-press selection can cancel its pointer before opening the
      // selection handles. The trusted menu gesture admits that touch session.
      if (!event.isTrusted || !touchCandidate || !inText(event.target)) return;
      touchOwned = true;
      commit("touch");
    };
    const click = (event: PointerEvent) => {
      if (!event.isTrusted || event.detail === 0 || !suppressedClicks.delete(event.pointerId)) return;
      // Window capture runs before an ancestor React route/link handler. The
      // editor may already have collapsed the native selection after release.
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const atSource = (target: EventTarget | null) => inText(target) ||
      target === root.current ||
      (target === document.body && inText(document.getSelection()?.anchorNode ?? null));
    const keydown = (event: KeyboardEvent) => {
      if (!event.isTrusted) return;
      input.current = "keyboard";
      touchCandidate = false;
      touchOwned = false;
      touchRejected = false;
      if (!atSource(event.target)) {
        if (keyboard) {
          keyboard = false;
          observe();
        }
      } else if (event.shiftKey && !event.isComposing && EXTENDING_KEYS.has(event.key)) {
        keyboard = true;
        observe();
      }
    };
    const keyup = (event: KeyboardEvent) => {
      if (!event.isTrusted || !keyboard || event.shiftKey) return;
      keyboard = false;
      observe();
      if (!event.isComposing && atSource(event.target)) commit("keyboard");
    };
    const blur = () => {
      pointer = null;
      keyboard = false;
      suppressedClicks.clear();
      touchCandidate = false;
      touchOwned = false;
      current.current.onSelection?.({ kind: "Observed", selection: null, inputHeld: false });
    };
    const scroll = (event: Event) => {
      if (event.target === root.current || inText(event.target)) observe();
    };
    const port = root.current;
    document.addEventListener("selectionchange", selectionchange);
    if (enabled) {
      window.addEventListener("pointerdown", down, true);
      window.addEventListener("pointerup", up, true);
      window.addEventListener("pointercancel", cancel, true);
      window.addEventListener("contextmenu", contextmenu, true);
      window.addEventListener("click", click, true);
      window.addEventListener("keydown", keydown, true);
      window.addEventListener("keyup", keyup, true);
      window.addEventListener("blur", blur);
      port?.addEventListener("scroll", scroll, { capture: true, passive: true });
    }
    return () => {
      blur();
      document.removeEventListener("selectionchange", selectionchange);
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", cancel, true);
      window.removeEventListener("contextmenu", contextmenu, true);
      window.removeEventListener("click", click, true);
      window.removeEventListener("keydown", keydown, true);
      window.removeEventListener("keyup", keyup, true);
      window.removeEventListener("blur", blur);
      port?.removeEventListener("scroll", scroll, true);
    };
  }, [root, options.identity, options.textSelector, enabled, observing, sourceElement, selected, captureSelection]);

  return { input, captureSelection };
}
