"use client";

import { useCallback, useEffect, useRef } from "react";
import { useWorkspaceStore } from "@/lib/workspace/store";
import { WorkspaceRoot } from "@/components/workspace";
import { emitWorkspaceTelemetry } from "@/lib/workspace/telemetry";
import { resolveTabDescriptor } from "@/lib/workspace/tabDescriptor";

interface WorkspaceV2HostProps {
  renderTab: (href: string, groupId: string, tabId: string) => React.ReactNode;
}

export default function WorkspaceV2Host({ renderTab }: WorkspaceV2HostProps) {
  const {
    state,
    runtimeTitleByTabId,
    openHintByTabId,
    resourceTitleByRef,
    activateGroup,
    activateTab,
    closeTab,
    setGroupWidth,
  } = useWorkspaceStore();
  const titleTelemetryByTabIdRef = useRef<Map<string, string>>(new Map());

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

  const getTabDescriptor = useCallback(
    (tab: Parameters<typeof resolveTabDescriptor>[0]) =>
      resolveTabDescriptor(tab, {
        nowMs: Date.now(),
        runtimeTitleByTabId,
        openHintByTabId,
        resourceTitleByRef,
      }),
    [openHintByTabId, resourceTitleByRef, runtimeTitleByTabId]
  );

  useEffect(() => {
    const nextTelemetryByTabId = new Map<string, string>();
    for (const group of state.groups) {
      for (const tab of group.tabs) {
        const descriptor = getTabDescriptor(tab);
        const telemetryKey = [
          descriptor.resolvedTitle,
          descriptor.titleSource,
          descriptor.routeId,
        ].join("|");
        nextTelemetryByTabId.set(tab.id, telemetryKey);
        if (titleTelemetryByTabIdRef.current.get(tab.id) === telemetryKey) {
          continue;
        }
        emitWorkspaceTelemetry({
          type: "title",
          status: descriptor.titleSource === "safe_fallback" ? "fallback" : "ok",
          errorCode:
            descriptor.titleSource === "safe_fallback" ? "safe_fallback_title" : null,
          titleSource: descriptor.titleSource,
          routeId: descriptor.routeId,
        });
      }
    }
    titleTelemetryByTabIdRef.current = nextTelemetryByTabId;
  }, [getTabDescriptor, state.groups]);

  return (
    <WorkspaceRoot
      groups={state.groups}
      activeGroupId={state.activeGroupId}
      onActivateGroup={activateGroup}
      onActivateTab={activateTab}
      onCloseTab={closeTab}
      onSetGroupWidth={setGroupWidth}
      renderTabContent={renderTabContent}
      getTabDescriptor={getTabDescriptor}
    />
  );
}
