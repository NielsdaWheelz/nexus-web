"use client";

import { type MouseEvent, type ReactNode } from "react";
import { Download, ListTodo, LogOut } from "lucide-react";
import Link from "next/link";
import ActionMenu from "@/components/ui/ActionMenu";
import { useMediaActivity } from "@/lib/media/MediaActivityProvider";
import { requestNexusOpen } from "@/lib/nexus/events";
import { useOfflineMediaCapability } from "@/lib/offlineMedia/OfflineMediaProvider";
import type { AppNavActivationResult } from "@/lib/panes/targetLinkActivation";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import type { AccountNavigation, NavItem } from "./navModel";
import styles from "./AppNav.module.css";

export default function AccountMenu({
  account,
  activeId,
  placement,
  align,
  renderTrigger,
  onNavigate,
}: {
  account: AccountNavigation;
  activeId: NavItem["id"] | null;
  placement: "above" | "below";
  align: "start" | "center" | "end";
  renderTrigger: Parameters<typeof ActionMenu>[0]["renderTrigger"];
  onNavigate: (
    event: MouseEvent<HTMLElement>,
    destination: NavItem,
  ) => AppNavActivationResult;
}): ReactNode {
  const { stats, settings } = account;
  const StatsIcon = stats.icon;
  const SettingsIcon = settings.icon;
  const { snapshot } = useMediaActivity();
  const offlineMedia = useOfflineMediaCapability();
  const importCount = snapshot
    ? snapshot.needsAttentionCount + snapshot.activeCount
    : 0;
  const options: ActionDescriptor[] = [
    {
      kind: "custom",
      id: "stats",
      label: stats.label,
      render: ({ closeMenu, closeMenuWithoutFocus }) => (
        <Link
          href={stats.href}
          role="menuitem"
          className={styles.menuItem}
          aria-current={activeId === stats.id ? "page" : undefined}
          onClick={(event) => {
            const result = onNavigate(event, stats);
            if (result === "unhandled") return;
            if (result === "handled-source-focus") closeMenu();
            else closeMenuWithoutFocus();
          }}
        >
          <StatsIcon size={16} aria-hidden="true" />
          {stats.label}
        </Link>
      ),
    },
    {
      kind: "custom",
      id: "import-activity",
      label: "Import activity",
      render: ({ closeMenuWithoutFocus }) => (
        <button
          type="button"
          role="menuitem"
          className={styles.menuItem}
          onClick={() => {
            closeMenuWithoutFocus();
            requestNexusOpen({ kind: "Activity" });
          }}
        >
          <ListTodo size={16} aria-hidden="true" />
          Import activity
        </button>
      ),
    },
  ];
  if (offlineMedia.kind === "Ready") {
    options.push({
      kind: "custom",
      id: "downloads",
      label: "Downloads",
      render: ({ closeMenu }) => (
        <button
          type="button"
          role="menuitem"
          className={styles.menuItem}
          onClick={() => {
            closeMenu();
            offlineMedia.controller.openDownloads();
          }}
        >
          <Download size={16} aria-hidden="true" />
          Downloads
        </button>
      ),
    });
  }
  options.push(
    {
      kind: "custom",
      id: "settings",
      label: settings.label,
      render: ({ closeMenu, closeMenuWithoutFocus }) => (
        <Link
          href={settings.href}
          role="menuitem"
          className={styles.menuItem}
          aria-current={activeId === settings.id ? "page" : undefined}
          onClick={(event) => {
            const result = onNavigate(event, settings);
            if (result === "unhandled") return;
            if (result === "handled-source-focus") closeMenu();
            else closeMenuWithoutFocus();
          }}
        >
          <SettingsIcon size={16} aria-hidden="true" />
          {settings.label}
        </Link>
      ),
    },
    {
      kind: "custom",
      id: "signout",
      label: "Sign Out",
      separatorBefore: true,
      render: () => (
        <form action="/auth/signout" method="post" className={styles.menuForm}>
          <button
            type="submit"
            role="menuitem"
            className={`${styles.menuItem} ${styles.menuItemDanger}`}
          >
            <LogOut size={16} aria-hidden="true" />
            Sign Out
          </button>
        </form>
      ),
    },
  );
  return (
    <ActionMenu
      className={styles.account}
      label={
        importCount === 0
          ? "Account"
          : `Account, ${importCount} open ${
              importCount === 1 ? "import" : "imports"
            }`
      }
      placement={placement}
      align={align}
      renderTrigger={renderTrigger}
      triggerAttributes={{
        "data-import-count": importCount > 0 ? String(importCount) : undefined,
      }}
      options={options}
    />
  );
}
