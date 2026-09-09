"use client";

import { useState, type MouseEvent, type ReactNode } from "react";
import { Download, LogOut } from "lucide-react";
import Link from "next/link";
import ImportsBadge from "@/components/imports/ImportsBadge";
import ActionMenu from "@/components/ui/ActionMenu";
import { requestDownloadsOpen } from "@/components/offlineMedia/downloadsSurfaceIngress";
import { useOfflineMediaCapability } from "@/lib/offlineMedia/OfflineMediaProvider";
import { useOfflineReadingCapability } from "@/lib/offlineReading/OfflineReadingProvider";
import { useAndroidShell } from "@/lib/renderEnvironment/provider";
import type { AppNavActivationResult } from "@/lib/panes/targetLinkActivation";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import { NAV_UTILITIES, type AccountNavigation, type NavItem } from "./navModel";
import styles from "./AppNav.module.css";
import { accountSignOutOwner } from "./accountSignOut";

export default function AccountMenu({
  account,
  activeId,
  utilityActiveId,
  placement,
  align,
  renderTrigger,
  onNavigate,
}: {
  account: AccountNavigation;
  activeId: NavItem["id"] | null;
  /** The utility destination the workspace is on, which is not an Account one. */
  utilityActiveId: NavItem["id"] | null;
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
  const offlineMedia = useOfflineMediaCapability();
  const offlineReading = useOfflineReadingCapability();
  const androidShell = useAndroidShell();
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const signOutOwner = accountSignOutOwner(androidShell, offlineReading.kind);
  const imports = NAV_UTILITIES.imports;
  const ImportsIcon = imports.icon;
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
      label: imports.label,
      render: ({ closeMenu, closeMenuWithoutFocus }) => (
        <Link
          href={imports.href}
          role="menuitem"
          className={styles.menuItem}
          aria-current={utilityActiveId === imports.id ? "page" : undefined}
          onClick={(event) => {
            const result = onNavigate(event, imports);
            if (result === "unhandled") return;
            if (result === "handled-source-focus") closeMenu();
            else closeMenuWithoutFocus();
          }}
        >
          <ImportsIcon size={16} aria-hidden="true" />
          <ImportsBadge label={imports.label} labelVisible />
        </Link>
      ),
    },
  ];
  // The single Downloads surface lists both capabilities, so its entry point
  // appears whenever either one is connected.
  if (offlineMedia.kind === "Ready" || offlineReading.kind === "Ready") {
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
            requestDownloadsOpen();
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
      render: ({ closeMenuWithoutFocus }) => signOutOwner === "Native" && offlineReading.kind === "Ready" ? (
        <button
          type="button"
          role="menuitem"
          className={`${styles.menuItem} ${styles.menuItemDanger}`}
          disabled={signingOut}
          onClick={() => {
            closeMenuWithoutFocus();
            setSigningOut(true);
            setSignOutError(null);
            void offlineReading.controller.logoutAndPurge().catch(() => {
              setSigningOut(false);
              setSignOutError("Sign out could not safely remove offline data. Try again.");
            });
          }}
        >
          <LogOut size={16} aria-hidden="true" />
          Sign Out
        </button>
      ) : signOutOwner === "WebPost" ? (
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
      ) : (
        <button
          type="button"
          role="menuitem"
          className={`${styles.menuItem} ${styles.menuItemDanger}`}
          disabled
        >
          <LogOut size={16} aria-hidden="true" />
          Sign Out temporarily unavailable
        </button>
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
