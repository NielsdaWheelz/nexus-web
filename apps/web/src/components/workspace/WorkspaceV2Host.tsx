"use client";

import { useCallback } from "react";
import { useWorkspaceStore } from "@/lib/workspace/store";
import { WorkspaceRoot } from "@/components/workspace";

interface WorkspaceV2HostProps {
  renderTab: (href: string, groupId: string, tabId: string) => React.ReactNode;
  getTabTitle?: (href: string) => string;
}

export default function WorkspaceV2Host({ renderTab, getTabTitle }: WorkspaceV2HostProps) {
  const {
    state,
    activateGroup,
    activateTab,
    closeTab,
    setGroupWidth,
  } = useWorkspaceStore();

  const renderTabContent = useCallback(
    (groupId: string, tabId: string) => {
      const group = state.groups.find((candidate) => candidate.id === groupId);
      const tab = group?.tabs.find((candidate) => candidate.id === tabId);
      if (!tab) {
        return null;
      }
      return renderTab(tab.href, groupId, tabId);
    },
    [renderTab, state.groups]
  );

  return (
    <WorkspaceRoot
      groups={state.groups}
      activeGroupId={state.activeGroupId}
      onActivateGroup={activateGroup}
      onActivateTab={activateTab}
      onCloseTab={closeTab}
      onSetGroupWidth={setGroupWidth}
      renderTabContent={renderTabContent}
      getTabTitle={(tab) => getTabTitle?.(tab.href) ?? tab.href}
    />
  );
}
