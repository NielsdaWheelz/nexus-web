"use client";

import { useCallback, useRef, type KeyboardEvent } from "react";
import {
  MAX_GROUP_WIDTH_PX,
  MIN_GROUP_WIDTH_PX,
  type WorkspacePaneGroupStateV2,
} from "@/lib/workspace/schema";
import TabStrip, { type WorkspaceTabView } from "@/components/workspace/TabStrip";
import styles from "./PaneGroup.module.css";

interface PaneGroupProps {
  group: WorkspacePaneGroupStateV2;
  tabs: WorkspaceTabView[];
  isActiveGroup: boolean;
  onActivateGroup: (groupId: string) => void;
  onActivateTab: (groupId: string, tabId: string) => void;
  onCloseTab?: (groupId: string, tabId: string) => void;
  onSetGroupWidth?: (groupId: string, widthPx: number) => void;
  renderTabContent: (groupId: string, tabId: string) => React.ReactNode;
}

function clampWidth(widthPx: number): number {
  return Math.max(MIN_GROUP_WIDTH_PX, Math.min(MAX_GROUP_WIDTH_PX, Math.round(widthPx)));
}

export default function PaneGroup({
  group,
  tabs,
  isActiveGroup,
  onActivateGroup,
  onActivateTab,
  onCloseTab,
  onSetGroupWidth,
  renderTabContent,
}: PaneGroupProps) {
  const groupRef = useRef<HTMLElement>(null);
  const activeTabId = group.tabs.find((tab) => tab.id === group.activeTabId)?.id ?? group.tabs[0]?.id;

  const handleResizeMouseDown = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (!onSetGroupWidth) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();

      const groupElement = groupRef.current;
      if (!groupElement) {
        return;
      }
      const startX = event.clientX;
      const startWidth = groupElement.getBoundingClientRect().width;

      document.body.style.userSelect = "none";
      document.body.style.cursor = "col-resize";

      const handleMouseMove = (moveEvent: MouseEvent) => {
        const delta = moveEvent.clientX - startX;
        onSetGroupWidth(group.id, clampWidth(startWidth + delta));
      };

      const handleMouseUp = () => {
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
      };

      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    },
    [group.id, onSetGroupWidth]
  );

  const handleResizeKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (!onSetGroupWidth) {
        return;
      }
      const current = group.widthPx ?? groupRef.current?.getBoundingClientRect().width ?? MIN_GROUP_WIDTH_PX * 2;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        onSetGroupWidth(group.id, clampWidth(current - 24));
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        onSetGroupWidth(group.id, clampWidth(current + 24));
      } else if (event.key === "Home") {
        event.preventDefault();
        onSetGroupWidth(group.id, MIN_GROUP_WIDTH_PX);
      } else if (event.key === "End") {
        event.preventDefault();
        onSetGroupWidth(group.id, MAX_GROUP_WIDTH_PX);
      }
    },
    [group.id, group.widthPx, onSetGroupWidth]
  );

  return (
    <section
      ref={groupRef}
      className={`${styles.group} ${isActiveGroup ? styles.groupActive : ""}`}
      style={
        onSetGroupWidth && group.widthPx ? { width: `${group.widthPx}px` } : undefined
      }
      onMouseDownCapture={() => onActivateGroup(group.id)}
      aria-label="Workspace pane group"
    >
      <div className={styles.tabsTop}>
        <TabStrip
          tabs={tabs}
          activeTabId={activeTabId ?? ""}
          onSelectTab={(tabId) => onActivateTab(group.id, tabId)}
          onCloseTab={onCloseTab ? (tabId) => onCloseTab(group.id, tabId) : undefined}
          placement="top"
        />
      </div>
      <div className={styles.content}>
        {activeTabId ? renderTabContent(group.id, activeTabId) : null}
      </div>
      <div className={styles.tabsBottom}>
        <TabStrip
          tabs={tabs}
          activeTabId={activeTabId ?? ""}
          onSelectTab={(tabId) => onActivateTab(group.id, tabId)}
          onCloseTab={onCloseTab ? (tabId) => onCloseTab(group.id, tabId) : undefined}
          placement="bottom"
        />
      </div>
      {onSetGroupWidth && (
        <div
          className={styles.resizeHandle}
          role="separator"
          aria-label="Resize pane group"
          aria-orientation="vertical"
          tabIndex={0}
          onMouseDown={handleResizeMouseDown}
          onKeyDown={handleResizeKeyDown}
        />
      )}
    </section>
  );
}
