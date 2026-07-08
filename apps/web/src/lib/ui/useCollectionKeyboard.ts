"use client";

import { useCallback, useEffect, useRef } from "react";
import type {
  FocusEvent as ReactFocusEvent,
  KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { nextRovingIndexForKey } from "@/lib/ui/rovingIndex";

/**
 * Composite list keyboard: one tab stop, arrow/Home/End to move focus, type-ahead
 * to jump. Operates on `[data-row-focusable]` descendants and matches type-ahead
 * against each row's `[data-row-text]`. Domain-free; the row primitive supplies the
 * attributes. Enter/Space activation stays native to the focused anchor/button.
 */
const TYPEAHEAD_RESET_MS = 600;
const ROW_FOCUSABLE_SELECTOR = "[data-row-focusable]";
const ROW_ACTION_TRIGGER_SELECTOR = "[data-row-action-trigger]";
const ROW_SELECTOR = "[data-collection-row-id]";
const ROW_CONTROL_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "textarea:not([disabled])",
  "select:not([disabled])",
  "summary",
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function usesNativeArrowKeys(element: HTMLElement | null): boolean {
  if (!element) return false;
  if (element.isContentEditable) return true;
  return ["INPUT", "SELECT", "TEXTAREA"].includes(element.tagName);
}

export function useCollectionKeyboard() {
  const containerRef = useRef<HTMLUListElement>(null);
  const typeahead = useRef({ buffer: "", at: 0 });

  const focusables = useCallback(
    () =>
      Array.from(
        containerRef.current?.querySelectorAll<HTMLElement>(ROW_FOCUSABLE_SELECTOR) ?? [],
      ),
    [],
  );

  const rowControls = useCallback((row: Element | null): HTMLElement[] => {
    if (!row) return [];
    return Array.from(row.querySelectorAll<HTMLElement>(ROW_CONTROL_SELECTOR)).filter(
      (el) => !el.matches(ROW_FOCUSABLE_SELECTOR),
    );
  }, []);

  const allRowControls = useCallback(() => {
    const root = containerRef.current;
    if (!root) return [];
    return Array.from(root.querySelectorAll<HTMLElement>(ROW_CONTROL_SELECTOR)).filter(
      (el) => !el.matches(ROW_FOCUSABLE_SELECTOR),
    );
  }, []);

  const applyRovingIndex = useCallback((items: HTMLElement[], activeIndex: number) => {
    items.forEach((el, i) => {
      el.tabIndex = i === activeIndex ? 0 : -1;
    });
    allRowControls().forEach((el) => {
      el.tabIndex = -1;
    });
  }, [allRowControls]);

  // Roving tabindex: keep exactly one row primary tabbable as rows mount/unmount.
  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    const sync = () => {
      const items = focusables();
      if (items.length === 0) return;
      const currentIndex = items.indexOf(document.activeElement as HTMLElement);
      applyRovingIndex(items, currentIndex >= 0 ? currentIndex : 0);
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [applyRovingIndex, focusables]);

  const moveTo = useCallback((items: HTMLElement[], index: number) => {
    applyRovingIndex(items, index);
    items[index].focus();
    items[index].scrollIntoView({ block: "nearest" });
  }, [applyRovingIndex]);

  const onFocus = useCallback(
    (event: ReactFocusEvent<HTMLUListElement>) => {
      const items = focusables();
      const index = items.indexOf(event.target as HTMLElement);
      if (index !== -1) {
        applyRovingIndex(items, index);
      }
    },
    [applyRovingIndex, focusables],
  );

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLUListElement>) => {
      const items = focusables();
      const currentIndex = items.indexOf(document.activeElement as HTMLElement);
      if (items.length === 0) return;

      if (currentIndex === -1) {
        const active = document.activeElement as HTMLElement | null;
        const row = active?.closest(ROW_SELECTOR);
        if (!row || !containerRef.current?.contains(row)) return;
        const primary = row.querySelector<HTMLElement>(ROW_FOCUSABLE_SELECTOR);
        if (event.key === "Escape") {
          event.preventDefault();
          primary?.focus();
          return;
        }
        if (
          (event.key === "ArrowLeft" || event.key === "ArrowRight") &&
          !usesNativeArrowKeys(active)
        ) {
          const controls = rowControls(row);
          const controlIndex = active ? controls.indexOf(active) : -1;
          if (event.key === "ArrowLeft") {
            event.preventDefault();
            if (controlIndex > 0) {
              controls[controlIndex - 1]?.focus();
            } else {
              primary?.focus();
            }
            return;
          }
          const nextControl = controls[controlIndex + 1];
          if (nextControl) {
            event.preventDefault();
            nextControl.focus();
            if (nextControl.matches(ROW_ACTION_TRIGGER_SELECTOR)) {
              nextControl.click();
            }
          }
          return;
        }
        return;
      }

      if (
        event.key === "ContextMenu" ||
        (event.key === "F10" && event.shiftKey)
      ) {
        const row = items[currentIndex].closest(ROW_SELECTOR);
        const actionTrigger = row?.querySelector<HTMLButtonElement>(ROW_ACTION_TRIGGER_SELECTOR);
        if (actionTrigger && !actionTrigger.disabled) {
          event.preventDefault();
          actionTrigger.focus();
          actionTrigger.click();
          return;
        }
      }

      if (event.key === "ArrowRight") {
        const row = items[currentIndex].closest(ROW_SELECTOR);
        const firstControl = rowControls(row)[0];
        if (firstControl) {
          event.preventDefault();
          firstControl.focus();
          if (firstControl.matches(ROW_ACTION_TRIGGER_SELECTOR)) {
            firstControl.click();
          }
          return;
        }
      }

      const nextIndex = nextRovingIndexForKey({
        key: event.key,
        currentIndex,
        itemCount: items.length,
        orientation: "vertical",
        homeEnd: true,
      });
      if (nextIndex !== null) {
        event.preventDefault();
        moveTo(items, nextIndex);
        return;
      }

      if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
        const t = typeahead.current;
        t.buffer = event.timeStamp - t.at > TYPEAHEAD_RESET_MS ? event.key : t.buffer + event.key;
        t.at = event.timeStamp;
        const needle = t.buffer.toLowerCase();
        const rotated = [...items.slice(currentIndex + 1), ...items.slice(0, currentIndex + 1)];
        const match = rotated.find((el) =>
          (el.querySelector("[data-row-text]")?.textContent ?? "").trim().toLowerCase().startsWith(needle),
        );
        if (match) {
          event.preventDefault();
          moveTo(items, items.indexOf(match));
        }
      }
    },
    [focusables, moveTo, rowControls],
  );

  return { containerRef, onFocus, onKeyDown };
}
