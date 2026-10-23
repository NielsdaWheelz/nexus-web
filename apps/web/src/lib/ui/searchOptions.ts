"use client";

// Controlled suggestion bindings. Admission and active identity belong to the
// feature; this module owns no query, request, selection or mutation lifetime.
import { useLayoutEffect, useRef, type MouseEvent, type PointerEvent } from "react";
import { revealCollectionItem } from "./collection";

export type SearchOption = {
  readonly key: string;
  readonly disabledReason: string | null;
};
export type SearchActive = { readonly context: string; readonly key: string | null } | null;

type SearchKeyEvent = Pick<KeyboardEvent,
  "key" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey" | "repeat" |
  "isComposing" | "keyCode" | "defaultPrevented">;

function searchOptionId(listId: string, key: string): string {
  return `${listId}-option-${encodeURIComponent(key)}`;
}

export function reconcileSearchActive({ context, admitted, options, firstExistingKey, active }: {
  readonly context: string;
  readonly admitted: boolean;
  readonly options: readonly SearchOption[];
  readonly firstExistingKey: string | null;
  readonly active: SearchActive;
}): SearchActive {
  const current = active?.context === context ? active : null;
  if (!admitted) return current;
  if (current) {
    return current.key === null || options.some(option => option.key === current.key)
      ? current : { context, key: null };
  }
  return firstExistingKey !== null && options.some(option => option.key === firstExistingKey && option.disabledReason === null)
    ? { context, key: firstExistingKey } : null;
}

export function useSearchOptions<T extends HTMLElement = HTMLDivElement>({
  listId, label, open, options, activeKey, onActiveChange, onActivate,
}: {
  readonly listId: string;
  readonly label: string;
  readonly open: boolean;
  readonly options: readonly SearchOption[];
  readonly activeKey: string | null;
  readonly onActiveChange: (key: string | null) => void;
  readonly onActivate: (key: string) => void;
}) {
  const listRef = useRef<T | null>(null);
  const latest = useRef({ open, options, onActiveChange, onActivate });
  latest.current = { open, options, onActiveChange, onActivate };
  const press = useRef<{
    readonly key: string; readonly pointerId: number;
    readonly x: number; readonly y: number; moved: boolean;
  } | null>(null);
  const active = open ? options.find(option => option.key === activeKey) ?? null : null;
  const activeItemKey = active?.key ?? null;
  const activeIndex = active === null ? null : options.findIndex(option => option.key === active.key);
  useLayoutEffect(() => {
    const list = listRef.current;
    const item = activeItemKey === null ? null : document.getElementById(searchOptionId(listId, activeItemKey));
    if (list && item) revealCollectionItem(list, item);
  }, [listId, open, activeItemKey, activeIndex]);
  const activate = (key: string) => {
    const current = latest.current;
    const option = current.open ? current.options.find(option => option.key === key) : null;
    if (!option) return;
    current.onActiveChange(key);
    if (option.disabledReason === null) current.onActivate(key);
  };
  return {
    listRef,
    listProps: { id: listId, role: "listbox", "aria-label": label, "data-collection-viewport": "" } as const,
    inputProps: {
      role: "combobox", "aria-autocomplete": "list", "aria-expanded": open,
      "aria-controls": open ? listId : undefined,
      "aria-activedescendant": active ? searchOptionId(listId, active.key) : undefined,
    } as const,
    handleKey(event: SearchKeyEvent, composing: boolean): boolean {
      if (!open || event.defaultPrevented || composing || event.isComposing || event.keyCode === 229 ||
        event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
      if (event.key === "Enter") {
        if (!event.repeat && active?.disabledReason === null) onActivate(active.key);
        return true;
      }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return false;
      const next = activeIndex === null
        ? event.key === "ArrowDown" ? 0 : options.length - 1
        : Math.max(0, Math.min(options.length - 1, activeIndex + (event.key === "ArrowDown" ? 1 : -1)));
      const key = options[next]?.key ?? null;
      onActiveChange(key);
      if (key !== null && key === activeItemKey) {
        const list = listRef.current;
        const item = document.getElementById(searchOptionId(listId, key));
        if (list && item) revealCollectionItem(list, item);
      }
      return true;
    },
    optionProps(key: string) {
      const option = options.find(option => option.key === key);
      if (!option) throw new Error("search option is not in the current collection");
      return {
        id: searchOptionId(listId, key), role: "option", "aria-selected": active?.key === key,
        "aria-disabled": option.disabledReason !== null || undefined,
        "data-active": active?.key === key || undefined,
        onPointerMove(event: PointerEvent<HTMLElement>) {
          const start = press.current;
          if (start?.pointerId === event.pointerId && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8) start.moved = true;
          if (event.pointerType === "touch" || event.buttons !== 0 ||
            (event.movementX === 0 && event.movementY === 0)) return;
          if (latest.current.open && latest.current.options.some(option => option.key === key)) latest.current.onActiveChange(key);
        },
        onPointerDown(event: PointerEvent<HTMLElement>) {
          if (!event.isPrimary || event.button !== 0) return;
          press.current = { key, pointerId: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
          if (event.pointerType !== "touch") event.preventDefault();
        },
        onPointerCancel() { press.current = null; },
        onClick(event: MouseEvent<HTMLElement>) {
          const start = press.current;
          press.current = null;
          if (event.button !== 0 || (event.detail !== 0 && (!start || start.key !== key || start.moved))) return;
          activate(key);
        },
      } as const;
    },
  };
}
