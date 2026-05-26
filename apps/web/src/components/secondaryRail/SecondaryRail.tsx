"use client";

import {
  useId,
  useRef,
  type ComponentType,
  type ReactNode,
} from "react";
import { PanelRightClose } from "lucide-react";
import Button from "@/components/ui/Button";
import styles from "./SecondaryRail.module.css";

export interface SecondaryRailTab {
  id: "highlights" | "doc-chat" | "library-chat";
  icon: ComponentType<{ size?: number }>;
  tooltip: string;
  body: ReactNode;
}

interface SecondaryRailProps {
  ariaLabel: string;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  collapsed?: ReactNode;
  children?: ReactNode;
  tabs?: SecondaryRailTab[];
  activeTabId?: SecondaryRailTab["id"];
  onActiveTabIdChange?: (tabId: SecondaryRailTab["id"]) => void;
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
  tabs,
  activeTabId,
  onActiveTabIdChange,
  expandedWidthPx = SECONDARY_RAIL_EXPANDED_WIDTH_PX,
  bodyClassName,
  testId,
}: SecondaryRailProps) {
  const panelId = useId();
  const tabRefs = useRef(new Map<SecondaryRailTab["id"], HTMLButtonElement>());
  const selectedTabId = activeTabId ?? tabs?.[0]?.id;
  const activeTab = tabs?.find((tab) => tab.id === selectedTabId) ?? null;
  const activeTabDomId = activeTab ? `${panelId}-${activeTab.id}-tab` : undefined;
  const selectTabFromKeyboard = (nextTabId: SecondaryRailTab["id"]) => {
    onActiveTabIdChange?.(nextTabId);
    window.requestAnimationFrame(() => {
      tabRefs.current.get(nextTabId)?.focus();
    });
  };
  const selectRelativeTab = (
    currentTabId: SecondaryRailTab["id"],
    direction: 1 | -1,
  ) => {
    if (!tabs || tabs.length === 0) {
      return;
    }
    const currentIndex = tabs.findIndex((tab) => tab.id === currentTabId);
    const nextIndex =
      currentIndex === -1
        ? 0
        : (currentIndex + direction + tabs.length) % tabs.length;
    selectTabFromKeyboard(tabs[nextIndex].id);
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
        {tabs && tabs.length > 0 ? (
          <div className={styles.tabs} role="tablist" aria-label={ariaLabel}>
            {tabs.map((tab) => {
              const Icon = tab.icon;
              const active = selectedTabId === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  id={`${panelId}-${tab.id}-tab`}
                  ref={(element) => {
                    if (element) {
                      tabRefs.current.set(tab.id, element);
                    } else {
                      tabRefs.current.delete(tab.id);
                    }
                  }}
                  role="tab"
                  aria-controls={panelId}
                  aria-selected={active}
                  aria-label={tab.tooltip}
                  title={tab.tooltip}
                  tabIndex={active ? 0 : -1}
                  className={styles.tab}
                  data-active={active ? "true" : "false"}
                  onClick={() => onActiveTabIdChange?.(tab.id)}
                  onKeyDown={(event) => {
                    if (event.key === "ArrowRight") {
                      event.preventDefault();
                      selectRelativeTab(tab.id, 1);
                    } else if (event.key === "ArrowLeft") {
                      event.preventDefault();
                      selectRelativeTab(tab.id, -1);
                    } else if (event.key === "Home") {
                      event.preventDefault();
                      selectTabFromKeyboard(tabs[0].id);
                    } else if (event.key === "End") {
                      event.preventDefault();
                      selectTabFromKeyboard(tabs[tabs.length - 1].id);
                    }
                  }}
                >
                  <Icon size={18} />
                </button>
              );
            })}
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
        role={tabs && tabs.length > 0 ? "tabpanel" : undefined}
        aria-labelledby={activeTabDomId}
        className={`${styles.body}${bodyClassName ? ` ${bodyClassName}` : ""}`}
      >
        {activeTab ? activeTab.body : children}
      </div>
    </aside>
  );
}
