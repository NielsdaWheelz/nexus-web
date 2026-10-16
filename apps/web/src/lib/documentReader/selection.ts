"use client";

import { useEffect, useRef, type RefObject } from "react";
import { isEditableTarget } from "@/lib/ui/eventTarget";
import type { SelectionCandidate, SelectionEvent } from "./DocumentReader";

const EXTENDING_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"]);

/** Admit completed reader gestures, never the editor's or a bare selectionchange. */
export function useReaderSelection(
  root: RefObject<HTMLElement | null>,
  options: {
    readonly identity: string;
    readonly textSelector: string;
    readonly capture: (selection: Selection) => SelectionCandidate | null;
    readonly onSelection: ((event: SelectionEvent) => void) | undefined;
    readonly onSelecting?: (selecting: boolean) => void;
  },
) {
  const input = useRef<SelectionEvent["input"]>("pointer");
  const current = useRef(options);
  current.current = options;
  const enabled = options.onSelection !== undefined;
  const observing = enabled || options.onSelecting !== undefined;

  useEffect(() => {
    if (!observing) return;
    let pointer: { id: number; input: "pointer" | "touch"; range: Range | null; changed: boolean; reengaged: boolean } | null = null;
    let keyboard = false;
    let suppressClick = false;
    let touchCandidate = false;
    let touchOwned = false;
    let touchAnchor: string | null = null;
    let touchRejected = false;
    const inText = (target: EventTarget | null) => {
      const node = target instanceof Node ? target : null;
      const element = node instanceof Element ? node : node?.parentElement;
      return Boolean(
        element && root.current?.contains(element) &&
        element.closest(options.textSelector) && !isEditableTarget(element) &&
        !element.closest("button,[data-document-embed-ui],[hidden],[inert]"),
      );
    };
    const selected = () => {
      const selection = document.getSelection();
      return selection && !selection.isCollapsed &&
        inText(selection.anchorNode) && inText(selection.focusNode)
        ? selection
        : null;
    };
    const sameRange = (before: Range | null, after: Range | null) => before === null || after === null
      ? before === after
      : before.startContainer === after.startContainer && before.startOffset === after.startOffset &&
        before.endContainer === after.endContainer && before.endOffset === after.endOffset;
    const hitsRange = (range: Range | null, event: PointerEvent) => range !== null && [...range.getClientRects()].some((rect) =>
      rect.width > 0 && rect.height > 0 && event.clientX >= rect.left && event.clientX <= rect.right &&
      event.clientY >= rect.top && event.clientY <= rect.bottom);
    const commit = (kind: SelectionEvent["input"]) => {
      const selection = selected();
      const capture = selection && current.current.capture(selection);
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
      current.current.onSelection({ ...capture, identity: current.current.identity, input: kind });
    };
    const selectionchange = () => {
      const selection = selected();
      if (pointer && !sameRange(pointer.range, selection?.getRangeAt(0) ?? null)) pointer.changed = true;
      const native = document.getSelection();
      current.current.onSelecting?.(Boolean(
        native && !native.isCollapsed && inText(native.anchorNode),
      ));
      if (!selection) {
        touchOwned = false;
        touchAnchor = null;
      } else if (touchOwned) commit("touch");
    };
    const down = (event: PointerEvent) => {
      suppressClick = false;
      pointer = null;
      keyboard = false;
      touchOwned = false;
      touchCandidate = false;
      touchAnchor = null;
      touchRejected = false;
      if (!event.isTrusted || !event.isPrimary || event.button !== 0 || !inText(event.target)) return;
      input.current = event.pointerType === "touch" ? "touch" : "pointer";
      const range = selected()?.getRangeAt(0).cloneRange() ?? null;
      pointer = { id: event.pointerId, input: input.current, range, changed: false, reengaged: hitsRange(range, event) };
      touchCandidate = input.current === "touch";
    };
    const up = (event: PointerEvent) => {
      if (!event.isTrusted || pointer?.id !== event.pointerId) return;
      const gesture = pointer;
      pointer = null;
      const range = selected()?.getRangeAt(0) ?? null;
      // A lingering native range elsewhere is not this press's selection.
      suppressClick = range !== null && (gesture.changed || !sameRange(gesture.range, range) ||
        gesture.reengaged && hitsRange(range, event));
      touchOwned = gesture.input === "touch" && suppressClick;
      if (suppressClick) commit(gesture.input);
    };
    const cancel = (event: PointerEvent) => {
      if (pointer?.id === event.pointerId) pointer = null;
    };
    const contextmenu = (event: MouseEvent) => {
      // Native long-press selection can cancel its pointer before opening the
      // selection handles. The trusted menu gesture admits that touch session.
      if (!event.isTrusted || !touchCandidate || !inText(event.target)) return;
      touchOwned = true;
      commit("touch");
    };
    const click = (event: MouseEvent) => {
      if (!suppressClick || !event.isTrusted || event.detail === 0) return;
      suppressClick = false;
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
      if (!atSource(event.target)) keyboard = false;
      else if (event.shiftKey && !event.isComposing && EXTENDING_KEYS.has(event.key))
        keyboard = true;
    };
    const keyup = (event: KeyboardEvent) => {
      if (!event.isTrusted || !keyboard || event.shiftKey) return;
      keyboard = false;
      if (!event.isComposing && atSource(event.target)) commit("keyboard");
    };
    const blur = () => {
      pointer = null;
      keyboard = false;
      suppressClick = false;
      touchCandidate = false;
      touchOwned = false;
    };
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
    }
    return () => {
      document.removeEventListener("selectionchange", selectionchange);
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", cancel, true);
      window.removeEventListener("contextmenu", contextmenu, true);
      window.removeEventListener("click", click, true);
      window.removeEventListener("keydown", keydown, true);
      window.removeEventListener("keyup", keyup, true);
      window.removeEventListener("blur", blur);
    };
  }, [root, options.identity, options.textSelector, enabled, observing]);

  return input;
}
