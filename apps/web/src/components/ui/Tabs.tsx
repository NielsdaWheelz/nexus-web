"use client";

import type { ReactElement, ReactNode, Ref } from "react";
import { cx } from "@/lib/ui/cx";
import { nextRovingIndexForKey } from "@/lib/ui/rovingIndex";
import selection from "./Selection.module.css";

type TabItem<V extends string> = {
  readonly value: V;
  readonly id: string;
  readonly panelId: string;
  readonly label: ReactNode;
  readonly icon?: ReactElement;
  readonly ref?: Ref<HTMLButtonElement>;
};

type TabListProps<V extends string> = {
  readonly value: V | null;
  readonly items: readonly TabItem<V>[];
  readonly onSelect: (value: V) => void;
  readonly "aria-label": string;
  readonly className?: string;
};

/** Controlled tab selection; the host owns panel lifetime and guarded focus. */
export function TabList<V extends string>({
  value, items, onSelect, "aria-label": label, className,
}: TabListProps<V>) {
  return (
    <div role="tablist" aria-label={label} className={className}>
      {items.map((item, index) => (
        <button
          key={item.value}
          ref={item.ref}
          type="button"
          role="tab"
          id={item.id}
          aria-controls={item.panelId}
          aria-selected={value === item.value}
          tabIndex={value === item.value ? 0 : -1}
          className={cx(selection.surface, selection.target, value === item.value && selection.selected)}
          onClick={() => onSelect(item.value)}
          onKeyDown={(event) => {
            if (event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229 ||
              event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
            const next = nextRovingIndexForKey({
              key: event.key,
              currentIndex: index,
              itemCount: items.length,
              orientation: "horizontal",
              wrap: true,
            });
            if (next === null) return;
            event.preventDefault();
            onSelect(items[next]!.value);
          }}
        >
          {item.icon ? <span aria-hidden="true">{item.icon}</span> : null}
          {item.label}
        </button>
      ))}
    </div>
  );
}
