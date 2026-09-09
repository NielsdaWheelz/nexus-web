"use client";

import { type MouseEvent } from "react";
import { CircleUser } from "lucide-react";
import type { AppNavActivationResult } from "@/lib/panes/targetLinkActivation";
import AccountMenu from "./AccountMenu";
import {
  isAccountDestinationId,
  type AccountNavigation,
  type NavItem,
} from "./navModel";
import styles from "./AppNav.module.css";

/** Rail account cluster: the shared contextual Account menu. */
export default function NavAccount({
  account,
  activeId,
  utilityActiveId,
  collapsed,
  onNavigate,
}: {
  account: AccountNavigation;
  activeId: NavItem["id"] | null;
  utilityActiveId: NavItem["id"] | null;
  collapsed: boolean;
  onNavigate: (
    event: MouseEvent<HTMLElement>,
    destination: NavItem,
  ) => AppNavActivationResult;
}) {
  const active = isAccountDestinationId(activeId);
  return (
    <AccountMenu
      account={account}
      activeId={activeId}
      utilityActiveId={utilityActiveId}
      placement="above"
      align="start"
      renderTrigger={(trigger) => (
        <button
          {...trigger}
          type="button"
          className={`${styles.accountTrigger} ${active ? styles.active : ""}`}
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
