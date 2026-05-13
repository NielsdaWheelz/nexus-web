"use client";

import {
  createContext,
  useContext,
  useRef,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import styles from "./Tabs.module.css";

type TabsVariant = "tabs" | "segmented";

interface TabsContextValue {
  value: string;
  onValueChange: (next: string) => void;
  variant: TabsVariant;
}

const TabsCtx = createContext<TabsContextValue | null>(null);

function useTabsContext(component: string): TabsContextValue {
  const ctx = useContext(TabsCtx);
  if (!ctx) {
    throw new Error(`${component} must be used inside <Tabs>`);
  }
  return ctx;
}

interface TabsProps extends HTMLAttributes<HTMLDivElement> {
  value: string;
  onValueChange: (next: string) => void;
  variant?: TabsVariant;
  children: ReactNode;
}

export function Tabs({
  value,
  onValueChange,
  variant = "tabs",
  children,
  className,
  ...rest
}: TabsProps) {
  return (
    <TabsCtx.Provider value={{ value, onValueChange, variant }}>
      <div className={[styles.root, className].filter(Boolean).join(" ")} {...rest}>
        {children}
      </div>
    </TabsCtx.Provider>
  );
}

const variantListClass: Record<TabsVariant, string> = {
  tabs: styles.listTabs,
  segmented: styles.listSegmented,
};

interface TabsListProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  "aria-label"?: string;
}

export function TabsList({
  children,
  className,
  "aria-label": ariaLabel,
  ...rest
}: TabsListProps) {
  const { variant } = useTabsContext("TabsList");
  const listRef = useRef<HTMLDivElement>(null);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
      return;
    }
    const root = listRef.current;
    if (!root) return;
    const triggers = Array.from(
      root.querySelectorAll<HTMLButtonElement>('[role="tab"]:not([disabled])')
    );
    if (triggers.length === 0) return;
    const activeIndex = triggers.findIndex((t) => t === document.activeElement);
    const startIndex = activeIndex < 0 ? 0 : activeIndex;
    const delta = event.key === "ArrowRight" ? 1 : -1;
    const nextIndex = (startIndex + delta + triggers.length) % triggers.length;
    event.preventDefault();
    const nextTrigger = triggers[nextIndex];
    if (!nextTrigger) return;
    nextTrigger.focus();
    nextTrigger.click();
  };

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={ariaLabel}
      className={[styles.list, variantListClass[variant], className]
        .filter(Boolean)
        .join(" ")}
      onKeyDown={handleKeyDown}
      {...rest}
    >
      {children}
    </div>
  );
}

const variantTriggerClass: Record<TabsVariant, string> = {
  tabs: styles.triggerTabs,
  segmented: styles.triggerSegmented,
};

interface TabsTriggerProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  value: string;
  children: ReactNode;
}

export function TabsTrigger({
  value,
  children,
  className,
  onClick,
  ...rest
}: TabsTriggerProps) {
  const ctx = useTabsContext("TabsTrigger");
  const selected = ctx.value === value;

  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      tabIndex={selected ? 0 : -1}
      data-selected={selected ? "true" : "false"}
      className={[
        styles.trigger,
        variantTriggerClass[ctx.variant],
        selected ? styles.triggerSelected : "",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      onClick={(event) => {
        ctx.onValueChange(value);
        onClick?.(event);
      }}
      {...rest}
    >
      {children}
    </button>
  );
}

interface TabsContentProps extends HTMLAttributes<HTMLDivElement> {
  value: string;
  children: ReactNode;
}

export function TabsContent({
  value,
  children,
  className,
  ...rest
}: TabsContentProps) {
  const ctx = useTabsContext("TabsContent");
  if (ctx.value !== value) {
    return null;
  }
  return (
    <div
      role="tabpanel"
      className={[styles.content, className].filter(Boolean).join(" ")}
      {...rest}
    >
      {children}
    </div>
  );
}

export type { TabsProps, TabsListProps, TabsTriggerProps, TabsContentProps, TabsVariant };
