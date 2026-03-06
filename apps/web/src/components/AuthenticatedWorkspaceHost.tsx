"use client";

import { useCallback, useMemo } from "react";
import PaneRouteRenderer from "@/components/PaneRouteRenderer";
import { WorkspaceV2Host } from "@/components/workspace";
import { useWorkspaceStore } from "@/lib/workspace/store";
import styles from "./AuthenticatedWorkspaceHost.module.css";

function WorkspaceV2TabRoute({
  href,
  groupId,
  tabId,
}: {
  href: string;
  groupId: string;
  tabId: string;
}) {
  const { navigateTab, openGroupWithTab, publishTabTitle } = useWorkspaceStore();

  const paneId = useMemo(() => `${groupId}:${tabId}`, [groupId, tabId]);

  const onNavigatePane = useCallback(
    (_paneId: string, nextHref: string) => {
      navigateTab(groupId, tabId, nextHref, { replace: false });
    },
    [navigateTab, groupId, tabId]
  );

  const onReplacePane = useCallback(
    (_paneId: string, nextHref: string) => {
      navigateTab(groupId, tabId, nextHref, { replace: true });
    },
    [navigateTab, groupId, tabId]
  );

  const onOpenInNewPane = useCallback(
    (nextHref: string) => {
      openGroupWithTab(nextHref, { historyMode: "push" });
    },
    [openGroupWithTab]
  );

  const onSetPaneTitle = useCallback(
    (
      _paneId: string,
      title: string | null,
      metadata: { routeId: string; resourceRef: string | null }
    ) => {
      publishTabTitle(groupId, tabId, title, {
        resourceRef: metadata.resourceRef,
      });
    },
    [publishTabTitle, groupId, tabId]
  );

  return (
    <div className={styles.routeShell}>
      <PaneRouteRenderer
        paneId={paneId}
        href={href}
        onNavigatePane={onNavigatePane}
        onReplacePane={onReplacePane}
        onOpenInNewPane={onOpenInNewPane}
        onSetPaneTitle={onSetPaneTitle}
      />
    </div>
  );
}

export default function AuthenticatedWorkspaceHost() {
  return (
    <WorkspaceV2Host
      renderTab={(href, groupId, tabId) => (
        <WorkspaceV2TabRoute href={href} groupId={groupId} tabId={tabId} />
      )}
    />
  );
}
