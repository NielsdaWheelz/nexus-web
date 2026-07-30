"use client";

import {
  type MouseEvent,
  type ReactNode,
} from "react";
import { Download, LogOut } from "lucide-react";
import Link from "next/link";
import ActionMenu from "@/components/ui/ActionMenu";
import { useOfflineMediaCapability } from "@/lib/offlineMedia/OfflineMediaProvider";
import type { AppNavActivationResult } from "@/lib/panes/targetLinkActivation";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import type { NavItem } from "./navModel";
import styles from "./AppNav.module.css";

export default function AccountMenu({
  settings,
  active,
  placement,
  align,
  renderTrigger,
  onNavigate,
}: {
  settings: NavItem;
  active: boolean;
  placement: "above" | "below";
  align: "start" | "center" | "end";
  renderTrigger: Parameters<typeof ActionMenu>[0]["renderTrigger"];
  onNavigate: (
    event: MouseEvent<HTMLElement>,
    href: string,
  ) => AppNavActivationResult;
}): ReactNode {
  const SettingsIcon = settings.icon;
  const offlineMedia = useOfflineMediaCapability();
  const options: ActionDescriptor[] = [];
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
          aria-current={active ? "page" : undefined}
          onClick={(event) => {
            const result = onNavigate(event, settings.href);
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
      label="Account"
      placement={placement}
      align={align}
      renderTrigger={renderTrigger}
      options={options}
    />
  );
}
