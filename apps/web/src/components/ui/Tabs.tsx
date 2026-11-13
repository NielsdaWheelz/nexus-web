"use client";

import { useRef, type Ref } from "react";
import { cx } from "@/lib/ui/cx";
import { nextRovingIndexForKey } from "@/lib/ui/rovingIndex";
import { useIndicator } from "@/lib/ui/useIndicator";
import styles from "./Tabs.module.css";

type TabItem<V extends string> = {
  readonly value: V;
  readonly id: string;
  readonly panelId: string;
  readonly label: string;
  readonly ref?: Ref<HTMLButtonElement>;
};

/** Controlled tab selection; the host owns panel lifetime and guarded focus. */
export function TabList<V extends string>({
  value, items, onSelect, "aria-label": label, className,
}: {
  readonly value: V | null;
  readonly items: readonly TabItem<V>[];
  readonly onSelect: (value: V) => void;
  readonly "aria-label": string;
  readonly className?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  useIndicator(host, value);
  const current = items.findIndex(item => item.value === value);
  return (
    <div ref={host} role="tablist" aria-label={label} className={cx(styles.row, className)}>
      {items.map((item, index) => (
        <button
          key={item.value}
          ref={item.ref}
          type="button"
          role="tab"
          id={item.id}
          aria-controls={item.panelId}
          aria-selected={value === item.value}
          data-indicated={value === item.value || undefined}
          tabIndex={index === (current < 0 ? 0 : current) ? 0 : -1}
          className={styles.tab}
          onClick={() => { if (value !== item.value) onSelect(item.value); }}
          onKeyDown={(event) => {
            if (event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229 ||
              event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
            const next = nextRovingIndexForKey({
              key: event.key, currentIndex: index, itemCount: items.length,
              orientation: "horizontal", wrap: true,
            });
            if (next === null) return;
            event.preventDefault();
            if (value !== items[next]!.value) onSelect(items[next]!.value);
          }}
        >
          <span className={styles.word}><span aria-hidden="true" className={styles.reserve}>{item.label}</span><span>{item.label}</span></span>
        </button>
      ))}
      <span aria-hidden="true" data-indicator className={styles.mark} />
    </div>
  );
}

/** Route sections use normal anchors; the pane's anchor owner follows or forks. */
export function TabLinks({ current, items, "aria-label": label }: {
  readonly current: string | null;
  readonly items: readonly { readonly value: string; readonly label: string; readonly href: string }[];
  readonly "aria-label": string;
}) {
  const host = useRef<HTMLElement>(null);
  useIndicator(host, current);
  return <nav ref={host} className={styles.row} aria-label={label}>
    {items.map(item => <a key={item.value} href={item.href} className={styles.tab}
      aria-current={current === item.value ? "page" : undefined} data-indicated={current === item.value || undefined}>
      <span className={styles.word}><span aria-hidden="true" className={styles.reserve}>{item.label}</span><span>{item.label}</span></span>
    </a>)}
    <span aria-hidden="true" data-indicator className={styles.mark} />
  </nav>;
}
