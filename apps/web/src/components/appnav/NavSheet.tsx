"use client";

import { useEffect, useRef, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { LogOut, Plus, Search, X } from "lucide-react";
import Link from "next/link";
import AsterismMark from "@/components/AsterismMark";
import { OPEN_LAUNCHER_EVENT } from "@/lib/launcher/launcherEvents";
import { useDialogOverlay } from "@/lib/ui/useDialogOverlay";
import { useHistoryDismiss } from "@/lib/ui/useHistoryDismiss";
import type { AppNavActivationResult } from "./navActivation";
import type { NavItem } from "./navModel";
import styles from "./AppNav.module.css";

export default function NavSheet({
  open,
  onClose,
  items,
  home,
  account,
  activeId,
  activeHref,
  settingsActive,
  commandHint,
  onOpenCommand,
  onOpenAdd,
  onNavigate,
}: {
  open: boolean;
  onClose: () => void;
  items: readonly NavItem[];
  home: NavItem;
  account: NavItem;
  activeId: NavItem["id"] | null;
  activeHref: string | null;
  settingsActive: boolean;
  commandHint: string;
  onOpenCommand: () => void;
  onOpenAdd: () => void;
  onNavigate: (event: MouseEvent<HTMLElement>, href: string) => AppNavActivationResult;
}) {
  const sheetRef = useRef<HTMLElement>(null);
  const navigationClaimedFocusRef = useRef(false);
  const previousActiveHrefRef = useRef(activeHref);

  useEffect(() => {
    if (open) navigationClaimedFocusRef.current = false;
  }, [open]);

  useDialogOverlay({
    ref: sheetRef,
    active: open,
    onDismiss: onClose,
    // Destination/Launcher dispatch takes responsibility for focus. Ordinary
    // Escape, backdrop, close-button, and history dismissal still restore it.
    skipReturnFocus: () => navigationClaimedFocusRef.current,
  });
  // Stays mounted across open/close (AppNav renders NavSheet unconditionally;
  // the `!open` gate below is after the hooks) — required by useHistoryDismiss.
  useHistoryDismiss(open, onClose);

  useEffect(() => {
    const changed = previousActiveHrefRef.current !== activeHref;
    previousActiveHrefRef.current = activeHref;
    if (!open || !changed) {
      return;
    }
    navigationClaimedFocusRef.current = true;
    onClose();
  }, [activeHref, onClose, open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const closeForLauncherHandoff = () => {
      navigationClaimedFocusRef.current = true;
      onClose();
    };
    window.addEventListener(OPEN_LAUNCHER_EVENT, closeForLauncherHandoff);
    return () =>
      window.removeEventListener(OPEN_LAUNCHER_EVENT, closeForLauncherHandoff);
  }, [onClose, open]);

  if (!open) return null;

  const navigate = (event: MouseEvent<HTMLElement>, href: string) => {
    const result = onNavigate(event, href);
    if (result === "unhandled") return;
    navigationClaimedFocusRef.current = result === "handled-destination-focus";
    onClose();
  };
  const handOff = (action: () => void) => {
    navigationClaimedFocusRef.current = true;
    action();
    onClose();
  };
  const AccountIcon = account.icon;

  return createPortal(
    <div className={styles.sheetBackdrop} role="presentation" onClick={onClose}>
      <aside
        ref={sheetRef}
        className={styles.sheet}
        role="dialog"
        aria-modal="true"
        aria-label="Navigation"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.brand}>
          <Link
            href={home.href}
            className={styles.brandLink}
            aria-label="Nexus — Home"
            onClick={(event) => navigate(event, home.href)}
          >
            <AsterismMark size={20} className={styles.brandMark} />
            <span className={styles.brandText}>Nexus</span>
          </Link>
          <button
            type="button"
            className={styles.sheetClose}
            onClick={onClose}
            aria-label="Close navigation"
          >
            <X size={20} aria-hidden="true" />
          </button>
        </div>

        <div className={styles.commandWrap}>
          <button
            type="button"
            className={styles.commandBar}
            onClick={() => handOff(onOpenCommand)}
            aria-haspopup="dialog"
            aria-label="Search or ask anything"
          >
            <span className={styles.commandIcon}>
              <Search size={16} aria-hidden="true" />
            </span>
            <span className={styles.commandText}>Search or ask anything…</span>
            <kbd className={styles.commandKbd}>{commandHint}</kbd>
          </button>
        </div>

        <div className={styles.scroll}>
          <ul className={styles.navList}>
            {items.map((item) => {
              const Icon = item.icon;
              const active = item.id === activeId;
              return (
                <li key={item.id}>
                  <Link
                    href={item.href}
                    className={`${styles.item} ${active ? styles.active : ""}`}
                    data-presentation={item.presentation}
                    aria-current={active ? "page" : undefined}
                    onClick={(event) => navigate(event, item.href)}
                  >
                    <span className={styles.itemIcon}>
                      <Icon size={20} strokeWidth={2} aria-hidden="true" />
                    </span>
                    <span className={styles.itemLabel}>{item.label}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>

        <div className={styles.sheetFooter}>
          <button
            type="button"
            className={styles.addButton}
            onClick={() => handOff(onOpenAdd)}
            aria-haspopup="dialog"
            aria-label="Add content"
          >
            <span className={styles.itemIcon}>
              <Plus size={20} strokeWidth={2} aria-hidden="true" />
            </span>
            <span className={styles.itemLabel}>Add</span>
          </button>
          <Link
            href={account.href}
            className={`${styles.item} ${settingsActive ? styles.active : ""}`}
            aria-current={settingsActive ? "page" : undefined}
            onClick={(event) => navigate(event, account.href)}
          >
            <span className={styles.itemIcon}>
              <AccountIcon size={20} strokeWidth={2} aria-hidden="true" />
            </span>
            <span className={styles.itemLabel}>{account.label}</span>
          </Link>
          <form action="/auth/signout" method="post" className={styles.menuForm}>
            <button type="submit" className={styles.item}>
              <span className={styles.itemIcon}>
                <LogOut size={20} strokeWidth={2} aria-hidden="true" />
              </span>
              <span className={styles.itemLabel}>Sign Out</span>
            </button>
          </form>
        </div>
      </aside>
    </div>,
    document.body,
  );
}
