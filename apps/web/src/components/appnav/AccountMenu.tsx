"use client";

import { useState, type MouseEvent, type ReactNode } from "react";
import { Download, LogOut } from "lucide-react";
import Link from "next/link";
import ImportsBadge from "@/components/imports/ImportsBadge";
import ActionMenu from "@/components/ui/ActionMenu";
import { offlineAvailable, offlineCall } from "@/lib/offline/bridge";
import type { AppNavActivationResult } from "@/lib/panes/targetLinkActivation";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import { NAV_ACCOUNT, NAV_IMPORTS, type NavItem } from "./navModel";
import styles from "./AppNav.module.css";

export default function AccountMenu({
  activeId,
  importsActive,
  placement,
  align,
  renderTrigger,
  onNavigate,
}: {
  activeId: NavItem["id"] | null;
  /** Whether the workspace is on Imports, which is not an Account destination. */
  importsActive: boolean;
  placement: "above" | "below";
  align: "start" | "center" | "end";
  renderTrigger: Parameters<typeof ActionMenu>[0]["renderTrigger"];
  onNavigate: (
    event: MouseEvent<HTMLElement>,
    destination: NavItem,
  ) => AppNavActivationResult;
}): ReactNode {
  const { stats, settings } = NAV_ACCOUNT;
  const StatsIcon = stats.icon;
  const SettingsIcon = settings.icon;
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const ImportsIcon = NAV_IMPORTS.icon;
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
      id: "imports",
      label: NAV_IMPORTS.label,
      render: ({ closeMenu, closeMenuWithoutFocus }) => (
        <Link
          href={NAV_IMPORTS.href}
          role="menuitem"
          className={styles.menuItem}
          aria-current={importsActive ? "page" : undefined}
          onClick={(event) => {
            const result = onNavigate(event, NAV_IMPORTS);
            if (result === "unhandled") return;
            if (result === "handled-source-focus") closeMenu();
            else closeMenuWithoutFocus();
          }}
        >
          <ImportsIcon size={16} aria-hidden="true" />
          <ImportsBadge label={NAV_IMPORTS.label} labelVisible />
        </Link>
      ),
    },
  ];
  // Downloads is Android's packaged shelf; the bridge loads it in place of the workspace.
  if (offlineAvailable) {
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
            void offlineCall("showDownloads");
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
      // On Android the device's offline data goes first; the web post then
      // revokes the session. Without the bridge it is the plain web post.
      render: () => (
        <form
          action="/auth/signout"
          method="post"
          className={styles.menuForm}
          onSubmit={offlineAvailable ? (event) => {
            event.preventDefault();
            const form = event.currentTarget;
            setSignOutError(null);
            void offlineCall("purge").then(
              () => form.submit(),
              () => setSignOutError("Sign out could not remove offline data. Try again."),
            );
          } : undefined}
        >
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
    <>
    <ActionMenu
      className={styles.account}
      label="Account"
      placement={placement}
      align={align}
      renderTrigger={renderTrigger}
      options={options}
    />
    {signOutError === null ? null : <p role="alert">{signOutError}</p>}
    </>
  );
}
