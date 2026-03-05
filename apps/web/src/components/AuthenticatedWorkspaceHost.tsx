"use client";

import PaneRouteRenderer from "@/components/PaneRouteRenderer";
import { WorkspaceV2Host } from "@/components/workspace";
import { useWorkspaceStore } from "@/lib/workspace/store";
import { tabTitleFromHref } from "@/lib/workspace/schema";
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
  const { navigateTab, openGroupWithTab } = useWorkspaceStore();

  return (
    <div className={styles.routeShell}>
      <PaneRouteRenderer
        paneId={`${groupId}:${tabId}`}
        href={href}
        onNavigatePane={(_paneId, nextHref) => {
          navigateTab(groupId, tabId, nextHref, { replace: false });
        }}
        onReplacePane={(_paneId, nextHref) => {
          navigateTab(groupId, tabId, nextHref, { replace: true });
        }}
        onOpenInNewPane={(nextHref) => {
          openGroupWithTab(nextHref, { historyMode: "push" });
        }}
      />
    </div>
  );
}

export default function AuthenticatedWorkspaceHost() {
  return (
    <WorkspaceV2Host
      getTabTitle={tabTitleFromHref}
      renderTab={(href, groupId, tabId) => (
        <WorkspaceV2TabRoute href={href} groupId={groupId} tabId={tabId} />
      )}
    />
  );
}
