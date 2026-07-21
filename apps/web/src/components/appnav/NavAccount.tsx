"use client";

import { type MouseEvent } from "react";
import { CircleUser, LogOut } from "lucide-react";
import Link from "next/link";
import ActionMenu from "@/components/ui/ActionMenu";
import type { AppNavActivationResult } from "./navActivation";
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
  const SettingsIcon = settings.icon;
  return (
    <ActionMenu
      className={styles.account}
      label="Account"
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
      options={[
        {
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
      ]}
    />
  );
}
