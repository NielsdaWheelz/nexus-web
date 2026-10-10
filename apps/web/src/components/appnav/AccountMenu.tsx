"use client";

import { useRef, useState, type ComponentProps, type MouseEvent } from "react";
import { Download, LogOut } from "lucide-react";
import Link from "next/link";
import ImportsBadge from "@/components/imports/ImportsBadge";
import ActionMenu from "@/components/ui/ActionMenu";
import type { DestinationId } from "@/lib/navigation/destinations";
import { offlineAvailable, offlineCall } from "@/lib/offline/bridge";
import type { AppNavActivationResult } from "@/lib/panes/targetLinkActivation";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import { NAV_IMPORTS, NAV_SETTINGS, NAV_STATS, type NavItem } from "./navModel";
import styles from "./AppNav.module.css";

/** Stats, Imports, Downloads (Android), Settings, Sign Out: the rail's and mobile Nexus's. */
export default function AccountMenu(props: {
  activeId: DestinationId | null;
  importsActive: boolean;
  placement: "above" | "below";
  align: "start" | "center" | "end";
  renderTrigger: ComponentProps<typeof ActionMenu>["renderTrigger"];
  onNavigate: (event: MouseEvent<HTMLElement>, item: NavItem) => AppNavActivationResult;
}) {
  const signOutForm = useRef<HTMLFormElement>(null);
  const [signOutError, setSignOutError] = useState<string | null>(null);

  const link = (item: NavItem, current: boolean): ActionDescriptor => ({
    kind: "custom",
    id: item.id,
    label: item.label,
    render: ({ closeMenu, closeMenuWithoutFocus }) => (
      <Link
        href={item.href}
        role="menuitem"
        className={styles.menuItem}
        aria-current={current ? "page" : undefined}
        onClick={(event) => {
          const result = props.onNavigate(event, item);
          if (result === "handled-source-focus") closeMenu();
          else if (result === "handled-destination-focus") closeMenuWithoutFocus();
        }}
      >
        <item.icon size={16} aria-hidden="true" />
        {item === NAV_IMPORTS ? <ImportsBadge label={item.label} labelVisible /> : item.label}
      </Link>
    ),
  });

  const options: ActionDescriptor[] = [
    link(NAV_STATS, props.activeId === "stats"),
    link(NAV_IMPORTS, props.importsActive),
    link(NAV_SETTINGS, props.activeId === "settings"),
    {
      kind: "command",
      id: "signout",
      label: "Sign Out",
      tone: "danger",
      icon: <LogOut size={16} aria-hidden="true" />,
      separatorBefore: true,
      // On Android the device's offline data goes first; the post then ends the session.
      onSelect: () => {
        const form = signOutForm.current!;
        if (!offlineAvailable) return form.submit();
        setSignOutError(null);
        offlineCall("purge").then(
          () => form.submit(),
          () => setSignOutError("Sign out could not remove offline data. Try again."),
        );
      },
    },
  ];
  // Android's packaged shelf; the bridge loads it in place of the workspace.
  if (offlineAvailable) {
    options.splice(2, 0, {
      kind: "command",
      id: "downloads",
      label: "Downloads",
      icon: <Download size={16} aria-hidden="true" />,
      onSelect: () => void offlineCall("showDownloads"),
    });
  }

  return (
    <>
      <ActionMenu
        className={styles.account}
        label="Account"
        placement={props.placement}
        align={props.align}
        renderTrigger={props.renderTrigger}
        options={options}
      />
      <form ref={signOutForm} action="/auth/signout" method="post" hidden />
      {signOutError === null ? null : <p role="alert">{signOutError}</p>}
    </>
  );
}
