"use client";

import { useEffect, useRef } from "react";
import PaneGroup from "@/components/workspace/PaneGroup";
import type { WorkspaceTabView } from "@/components/workspace/TabStrip";
import {
  type WorkspacePaneGroupStateV2,
  type WorkspaceTabStateV2,
} from "@/lib/workspace/schema";
import type { TabDescriptor } from "@/lib/workspace/tabDescriptor";
import styles from "./WorkspaceRoot.module.css";

interface WorkspaceRootProps {
  groups: WorkspacePaneGroupStateV2[];
  activeGroupId: string;
  onActivateGroup: (groupId: string) => void;
  onActivateTab: (groupId: string, tabId: string) => void;
  onCloseTab?: (groupId: string, tabId: string) => void;
  onSetGroupWidth?: (groupId: string, widthPx: number) => void;
  renderTabContent: (groupId: string, tabId: string) => React.ReactNode;
  getTabDescriptor?: (tab: WorkspaceTabStateV2) => TabDescriptor;
}

export default function WorkspaceRoot({
  groups,
  activeGroupId,
  onActivateGroup,
  onActivateTab,
  onCloseTab,
  onSetGroupWidth,
  renderTabContent,
  getTabDescriptor,
}: WorkspaceRootProps) {
  const groupRefs = useRef(new Map<string, HTMLElement>());

  useEffect(() => {
    const activeElement = groupRefs.current.get(activeGroupId);
    if (!activeElement) {
      return;
    }
    activeElement.scrollIntoView({
      block: "nearest",
      inline: "nearest",
      behavior: "smooth",
    });
  }, [activeGroupId]);

  if (groups.length === 0) {
    return (
      <div className={styles.empty}>
        <p>No panes are open.</p>
      </div>
    );
  }

  const isMultiGroup = groups.length > 1;
  const workspaceClass = `${styles.workspace} ${isMultiGroup ? styles.workspaceScrollable : ""}`;

  return (
    <div className={workspaceClass} aria-label="Workspace panes">
      {groups.map((group) => {
        const tabs: WorkspaceTabView[] = group.tabs.map((tab) => ({
          id: tab.id,
          href: tab.href,
          title: getTabDescriptor?.(tab)?.resolvedTitle ?? "Tab",
        }));

        const isSized = isMultiGroup && group.widthPx != null;
        const shellClass = `${styles.groupShell} ${isSized ? styles.groupShellSized : ""}`;

        return (
          <div
            key={group.id}
            ref={(element) => {
              if (element) {
                groupRefs.current.set(group.id, element);
              } else {
                groupRefs.current.delete(group.id);
              }
            }}
            className={shellClass}
          >
            <PaneGroup
              group={group}
              tabs={tabs}
              isActiveGroup={group.id === activeGroupId}
              onActivateGroup={onActivateGroup}
              onActivateTab={onActivateTab}
              onCloseTab={onCloseTab}
              onSetGroupWidth={onSetGroupWidth}
              renderTabContent={renderTabContent}
            />
          </div>
        );
      })}
    </div>
  );
}
