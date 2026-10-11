"use client";

import {
  createContext,
  useContext,
  useId,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { cx } from "@/lib/ui/cx";
import { nextRovingIndexForKey } from "@/lib/ui/rovingIndex";
import styles from "./Tabs.module.css";

type TabsContextValue = {
  value: string;
  onValueChange: (next: string) => void;
  idFor: (value: string) => string;
};

const TabsContext = createContext<TabsContextValue | null>(null);

function useTabs(): TabsContextValue {
  const context = useContext(TabsContext);
  if (!context) throw new Error("Tabs parts must be used inside <Tabs>");
  return context;
}

/**
 * Segmented tabs, the aria tabs pattern: arrow keys move focus and select,
 * wrapping; each panel is named by its tab.
 */
export function Tabs({
  value,
  onValueChange,
  className,
  children,
}: {
  value: string;
  onValueChange: (next: string) => void;
  className?: string;
  children: ReactNode;
}) {
  const base = useId();
  const idFor = (tab: string) => `${base}-${tab.replace(/\W/g, "_")}`;
  return (
    <TabsContext value={{ value, onValueChange, idFor }}>
      <div className={cx(styles.root, className)}>{children}</div>
    </TabsContext>
  );
}

export function TabsList({
  children,
  "aria-label": label,
}: {
  children: ReactNode;
  "aria-label": string;
}) {
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const tabs = [
      ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
        '[role="tab"]',
      ),
    ];
    const next = nextRovingIndexForKey({
      key: event.key,
      currentIndex: Math.max(
        0,
        tabs.findIndex((tab) => tab === document.activeElement),
      ),
      itemCount: tabs.length,
      orientation: "horizontal",
      wrap: true,
      homeEnd: false,
    });
    if (next === null) return;
    event.preventDefault();
    tabs[next]?.focus();
    tabs[next]?.click();
  };
  return (
    <div
      role="tablist"
      aria-label={label}
      className={styles.list}
      onKeyDown={move}
    >
      {children}
    </div>
  );
}

export function TabsTrigger({
  value,
  children,
  "aria-label": label,
}: {
  value: string;
  children: ReactNode;
  "aria-label"?: string;
}) {
  const tabs = useTabs();
  const selected = tabs.value === value;
  return (
    <button
      type="button"
      role="tab"
      id={tabs.idFor(value)}
      aria-label={label}
      aria-selected={selected}
      tabIndex={selected ? 0 : -1}
      className={cx(styles.trigger, selected && styles.selected)}
      onClick={() => tabs.onValueChange(value)}
    >
      {children}
    </button>
  );
}

export function TabsContent({
  value,
  children,
}: {
  value: string;
  children: ReactNode;
}) {
  const tabs = useTabs();
  if (tabs.value !== value) return null;
  return (
    <div
      role="tabpanel"
      aria-labelledby={tabs.idFor(value)}
      className={styles.content}
    >
      {children}
    </div>
  );
}
