"use client";

import { X } from "lucide-react";
import styles from "./TabStrip.module.css";

export interface WorkspaceTabView {
  id: string;
  href: string;
  title: string;
}

interface TabStripProps {
  tabs: WorkspaceTabView[];
  activeTabId: string;
  onSelectTab: (tabId: string) => void;
  onCloseTab?: (tabId: string) => void;
  placement: "top" | "bottom";
}

export default function TabStrip({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  placement,
}: TabStripProps) {
  return (
    <div
      className={`${styles.tabStrip} ${placement === "bottom" ? styles.bottom : styles.top}`}
      role="tablist"
      aria-label="Pane tabs"
    >
      {tabs.map((tab) => {
        const isActive = tab.id === activeTabId;
        return (
          <div
            key={tab.id}
            className={`${styles.tab} ${isActive ? styles.active : ""}`}
            role="tab"
            aria-selected={isActive}
            tabIndex={isActive ? 0 : -1}
            onClick={() => onSelectTab(tab.id)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelectTab(tab.id);
              }
            }}
          >
            <span className={styles.title} title={tab.title}>
              {tab.title}
            </span>
            {onCloseTab && (
              <button
                type="button"
                className={styles.closeButton}
                aria-label={`Close ${tab.title}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onCloseTab(tab.id);
                }}
              >
                <X size={12} aria-hidden="true" />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
