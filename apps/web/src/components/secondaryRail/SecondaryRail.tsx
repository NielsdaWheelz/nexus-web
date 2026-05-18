"use client";

import { useId, useRef, type ReactNode } from "react";
import { PanelRightClose } from "lucide-react";
import Button from "@/components/ui/Button";
import styles from "./SecondaryRail.module.css";

interface SecondaryRailProps {
  ariaLabel: string;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  collapsed?: ReactNode;
  children: ReactNode;
  tabs?: Array<{ id: string; label: string; disabled?: boolean }>;
  activeTabId?: string;
  onActiveTabChange?: (tabId: string) => void;
  expandedWidthPx?: number;
  bodyClassName?: string;
  testId?: string;
}

export const SECONDARY_RAIL_EXPANDED_WIDTH_PX = 360;
export const SECONDARY_RAIL_COLLAPSED_WIDTH_PX = 36;

export default function SecondaryRail({
  ariaLabel,
  expanded,
  onExpandedChange,
  collapsed,
  children,
  tabs = [],
  activeTabId,
  onActiveTabChange,
  expandedWidthPx = SECONDARY_RAIL_EXPANDED_WIDTH_PX,
  bodyClassName,
  testId,
}: SecondaryRailProps) {
  const panelId = useId();
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const selectedTabId =
    activeTabId ?? tabs.find((tab) => !tab.disabled)?.id ?? tabs[0]?.id;
  const activeTab = tabs.find((tab) => tab.id === selectedTabId) ?? null;
  const activeTabDomId = activeTab ? `${panelId}-${activeTab.id}-tab` : undefined;
  const enabledTabs = tabs.filter((tab) => !tab.disabled);
  const selectTabFromKeyboard = (nextTabId: string) => {
    onActiveTabChange?.(nextTabId);
    window.requestAnimationFrame(() => {
      tabRefs.current.get(nextTabId)?.focus();
    });
  };
  const selectRelativeTab = (currentTabId: string, direction: 1 | -1) => {
    if (enabledTabs.length === 0) {
      return;
    }
    const currentIndex = enabledTabs.findIndex((tab) => tab.id === currentTabId);
    const nextIndex =
      currentIndex === -1
        ? 0
        : (currentIndex + direction + enabledTabs.length) % enabledTabs.length;
    selectTabFromKeyboard(enabledTabs[nextIndex].id);
  };

  if (!expanded) {
    return (
      <aside
        className={`${styles.rail} ${styles.collapsed}`}
        style={{
          width: SECONDARY_RAIL_COLLAPSED_WIDTH_PX,
          flexBasis: SECONDARY_RAIL_COLLAPSED_WIDTH_PX,
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
                id={`${panelId}-${tab.id}-tab`}
                ref={(element) => {
                  if (element) {
                    tabRefs.current.set(tab.id, element);
                  } else {
                    tabRefs.current.delete(tab.id);
                  }
                }}
                variant="ghost"
                size="sm"
                role="tab"
                aria-controls={panelId}
                aria-selected={selectedTabId === tab.id}
                disabled={tab.disabled}
                tabIndex={selectedTabId === tab.id ? 0 : -1}
                className={styles.tab}
                data-active={selectedTabId === tab.id ? "true" : "false"}
                onClick={() => onActiveTabChange?.(tab.id)}
                onKeyDown={(event) => {
                  if (event.key === "ArrowRight") {
                    event.preventDefault();
                    selectRelativeTab(tab.id, 1);
                  } else if (event.key === "ArrowLeft") {
                    event.preventDefault();
                    selectRelativeTab(tab.id, -1);
                  } else if (event.key === "Home" && enabledTabs.length > 0) {
                    event.preventDefault();
                    selectTabFromKeyboard(enabledTabs[0].id);
                  } else if (event.key === "End" && enabledTabs.length > 0) {
                    event.preventDefault();
                    selectTabFromKeyboard(enabledTabs[enabledTabs.length - 1].id);
                  }
                }}
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
      <div
        id={panelId}
        role={tabs.length > 0 ? "tabpanel" : undefined}
        aria-labelledby={activeTabDomId}
        className={`${styles.body}${bodyClassName ? ` ${bodyClassName}` : ""}`}
      >
        {children}
      </div>
    </aside>
  );
}
