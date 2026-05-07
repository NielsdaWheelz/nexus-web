"use client";

import type { ReactNode } from "react";
import { PanelRightClose } from "lucide-react";
import Button from "@/components/ui/Button";
import styles from "./SecondaryRail.module.css";

interface SecondaryRailProps {
  ariaLabel: string;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  collapsed: ReactNode;
  children: ReactNode;
  tabs?: Array<{ id: string; label: string; disabled?: boolean }>;
  activeTabId?: string;
  onActiveTabChange?: (tabId: string) => void;
  expandedWidthPx?: number;
  bodyClassName?: string;
  testId?: string;
}

const DEFAULT_EXPANDED_WIDTH_PX = 360;
const DEFAULT_COLLAPSED_WIDTH_PX = 36;

export default function SecondaryRail({
  ariaLabel,
  expanded,
  onExpandedChange,
  collapsed,
  children,
  tabs = [],
  activeTabId,
  onActiveTabChange,
  expandedWidthPx = DEFAULT_EXPANDED_WIDTH_PX,
  bodyClassName,
  testId,
}: SecondaryRailProps) {
  if (!expanded) {
    return (
      <aside
        className={`${styles.rail} ${styles.collapsed}`}
        style={{
          width: DEFAULT_COLLAPSED_WIDTH_PX,
          flexBasis: DEFAULT_COLLAPSED_WIDTH_PX,
        }}
        aria-label={ariaLabel}
        data-testid={testId}
        data-expanded="false"
      >
        {collapsed}
      </aside>
    );
  }

  return (
    <aside
      className={`${styles.rail} ${styles.expanded}`}
      style={{
        width: expandedWidthPx,
        flexBasis: expandedWidthPx,
      }}
      aria-label={ariaLabel}
      data-testid={testId}
      data-expanded="true"
    >
      <header className={styles.header}>
        {tabs.length > 0 ? (
          <div className={styles.tabs} role="tablist" aria-label={ariaLabel}>
            {tabs.map((tab) => (
              <Button
                key={tab.id}
                variant="ghost"
                size="sm"
                role="tab"
                aria-selected={activeTabId === tab.id}
                disabled={tab.disabled}
                className={styles.tab}
                data-active={activeTabId === tab.id ? "true" : "false"}
                onClick={() => onActiveTabChange?.(tab.id)}
              >
                {tab.label}
              </Button>
            ))}
          </div>
        ) : (
          <span className={styles.title}>{ariaLabel}</span>
        )}
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          aria-label="Collapse secondary rail"
          onClick={() => onExpandedChange(false)}
        >
          <PanelRightClose size={15} aria-hidden="true" />
        </Button>
      </header>
      <div className={`${styles.body}${bodyClassName ? ` ${bodyClassName}` : ""}`}>
        {children}
      </div>
    </aside>
  );
}
