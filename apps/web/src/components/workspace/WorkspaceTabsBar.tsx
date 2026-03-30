"use client";

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import styles from "./WorkspaceTabsBar.module.css";

export interface WorkspaceTabItem {
  paneId: string;
  title: string;
  isActive: boolean;
}

interface WorkspaceTabsBarProps {
  tabs: WorkspaceTabItem[];
  onActivatePane: (paneId: string, options?: { focusPaneChrome?: boolean }) => void;
  onClosePane: (paneId: string) => void;
  mobileSwitcherLabel: string;
  onOpenMobileSwitcher?: () => void;
  mobileSwitcherButtonRef?: RefObject<HTMLButtonElement | null>;
}

export default function WorkspaceTabsBar({
  tabs,
  onActivatePane,
  onClosePane,
  mobileSwitcherLabel,
  onOpenMobileSwitcher,
  mobileSwitcherButtonRef,
}: WorkspaceTabsBarProps) {
  const isMobile = useIsMobileViewport();
  const tabRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const [pendingFocusPaneId, setPendingFocusPaneId] = useState<string | null>(null);

  const paneIds = useMemo(() => tabs.map((tab) => tab.paneId), [tabs]);
  const activeTabTitle = useMemo(
    () => tabs.find((tab) => tab.isActive)?.title || tabs[0]?.title || "Pane",
    [tabs]
  );
  const activateTabByIndex = (
    index: number,
    options?: { focusPaneChrome?: boolean }
  ) => {
    if (!tabs.length) {
      return;
    }
    const normalizedIndex = ((index % tabs.length) + tabs.length) % tabs.length;
    const nextPaneId = tabs[normalizedIndex]?.paneId;
    if (!nextPaneId) {
      return;
    }
    onActivatePane(nextPaneId, options);
    tabRefs.current.get(nextPaneId)?.focus();
  };

  useEffect(() => {
    if (isMobile) {
      return;
    }
    if (!pendingFocusPaneId) {
      return;
    }
    const next = tabRefs.current.get(pendingFocusPaneId);
    if (next) {
      next.focus();
      setPendingFocusPaneId(null);
      return;
    }
    const firstPaneId = paneIds[0];
    if (firstPaneId) {
      const first = tabRefs.current.get(firstPaneId);
      first?.focus();
    }
    setPendingFocusPaneId(null);
  }, [isMobile, paneIds, pendingFocusPaneId]);

  if (isMobile) {
    return (
      <div className={styles.root}>
        <div className={styles.mobileSummary} aria-live="polite">
          {activeTabTitle}
        </div>
        <button
          ref={mobileSwitcherButtonRef}
          type="button"
          className={styles.mobileSwitcher}
          onClick={onOpenMobileSwitcher}
          aria-label={mobileSwitcherLabel}
        >
          {mobileSwitcherLabel}
        </button>
      </div>
    );
  }

  return (
    <div className={styles.root}>
      <div className={styles.tablist} role="tablist" aria-label="Workspace panes">
        {tabs.map((tab) => {
          const tabName = tab.title || "Pane";
          return (
            <div key={tab.paneId} className={styles.tabShell}>
              <button
                ref={(element) => {
                  if (element) {
                    tabRefs.current.set(tab.paneId, element);
                  } else {
                    tabRefs.current.delete(tab.paneId);
                  }
                }}
                type="button"
                role="tab"
                aria-selected={tab.isActive ? "true" : "false"}
                tabIndex={tab.isActive ? 0 : -1}
                id={`workspace-tab-${tab.paneId}`}
                aria-controls={`workspace-panel-${tab.paneId}`}
                className={`${styles.tab} ${tab.isActive ? styles.active : ""}`}
                onClick={() => onActivatePane(tab.paneId, { focusPaneChrome: true })}
                onKeyDown={(event) => {
                  const currentIndex = tabs.findIndex(
                    (candidate) => candidate.paneId === tab.paneId
                  );
                  if (currentIndex < 0) {
                    return;
                  }
                  if (event.key === "ArrowRight") {
                    event.preventDefault();
                    activateTabByIndex(currentIndex + 1, { focusPaneChrome: false });
                    return;
                  }
                  if (event.key === "ArrowLeft") {
                    event.preventDefault();
                    activateTabByIndex(currentIndex - 1, { focusPaneChrome: false });
                    return;
                  }
                  if (event.key === "Home") {
                    event.preventDefault();
                    activateTabByIndex(0, { focusPaneChrome: false });
                    return;
                  }
                  if (event.key === "End") {
                    event.preventDefault();
                    activateTabByIndex(tabs.length - 1, { focusPaneChrome: false });
                  }
                }}
              >
                {tabName}
              </button>
              <button
                type="button"
                className={styles.close}
                aria-label={`Close ${tabName}`}
                onClick={() => {
                  const currentIndex = tabs.findIndex((candidate) => candidate.paneId === tab.paneId);
                  const nextTab =
                    tabs[currentIndex + 1] ??
                    tabs[currentIndex - 1] ??
                    null;
                  setPendingFocusPaneId(nextTab?.paneId ?? null);
                  onClosePane(tab.paneId);
                }}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
