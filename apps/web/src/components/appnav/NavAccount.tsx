"use client";

import { type MouseEvent } from "react";
import { CircleUser } from "lucide-react";
import type { AppNavActivationResult } from "@/lib/panes/targetLinkActivation";
import AccountMenu from "./AccountMenu";
import type { NavItem } from "./navModel";
import styles from "./AppNav.module.css";

/** Rail account cluster: an avatar trigger opening a menu with Settings + Sign Out. */
export default function NavAccount({
  settings,
  active,
  collapsed,
  onNavigate,
}: {
  settings: NavItem;
  active: boolean;
  collapsed: boolean;
  onNavigate: (event: MouseEvent<HTMLElement>, href: string) => AppNavActivationResult;
}) {
  return (
    <AccountMenu
      settings={settings}
      active={active}
      placement="above"
      align="start"
      renderTrigger={(trigger) => (
        <button
          {...trigger}
          type="button"
          className={`${styles.accountTrigger} ${active ? styles.active : ""}`}
          aria-label="Account"
          aria-current={active ? "page" : undefined}
        >
          <span className={styles.accountAvatar}>
            <CircleUser size={20} strokeWidth={2} aria-hidden="true" />
          </span>
          {!collapsed && <span className={styles.itemLabel}>Account</span>}
        </button>
      )}
      onNavigate={onNavigate}
    />
  );
}
