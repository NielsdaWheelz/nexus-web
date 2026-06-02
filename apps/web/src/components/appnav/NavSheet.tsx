"use client";

import { useEffect, useRef, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { LogOut, Plus, Search } from "lucide-react";
import Link from "next/link";
import AsterismMark from "@/components/AsterismMark";
import { useBodyOverflowLock } from "@/lib/ui/useBodyOverflowLock";
import { useFocusTrap } from "@/lib/ui/useFocusTrap";
import { useDismissOnOutsideOrEscape } from "@/lib/ui/useDismissOnOutsideOrEscape";
import { getFocusableElements } from "@/lib/ui/getFocusableElements";
import type { NavGroup, NavItem } from "./navModel";
import styles from "./AppNav.module.css";

export default function NavSheet({
  open,
  onClose,
  groups,
  account,
  activeId,
  settingsActive,
  commandHint,
  onOpenCommand,
  onOpenAdd,
  onNavigate,
}: {
  open: boolean;
  onClose: () => void;
  groups: NavGroup[];
  account: NavItem;
  activeId: string | null;
  settingsActive: boolean;
  commandHint: string;
  onOpenCommand: () => void;
  onOpenAdd: () => void;
  onNavigate: (event: MouseEvent<HTMLElement>, href: string) => void;
}) {
  const sheetRef = useRef<HTMLElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useBodyOverflowLock(open);
  useFocusTrap(sheetRef, open);
  useDismissOnOutsideOrEscape({ enabled: open, refs: [sheetRef], onDismiss: onClose });

  useEffect(() => {
    if (!open) return;
    returnFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      if (returnFocusRef.current?.isConnected) returnFocusRef.current.focus();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      if (sheetRef.current) (getFocusableElements(sheetRef.current)[0] ?? sheetRef.current).focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  if (!open) return null;

  const navigate = (event: MouseEvent<HTMLElement>, href: string) => {
    onNavigate(event, href);
    onClose();
  };
  const AccountIcon = account.icon;

  return createPortal(
    <div className={styles.sheetBackdrop} role="presentation">
      <aside
        ref={sheetRef}
        className={styles.sheet}
        role="dialog"
        aria-modal="true"
        aria-label="Navigation"
        tabIndex={-1}
      >
        <div className={styles.brand}>
          <Link
            href="/libraries"
            className={styles.brandLink}
            aria-label="Nexus — Home"
            onClick={(event) => navigate(event, "/libraries")}
          >
            <AsterismMark size={20} className={styles.brandMark} />
            <span className={styles.brandText}>Nexus</span>
          </Link>
        </div>

        <div className={styles.commandWrap}>
          <button
            type="button"
            className={styles.commandBar}
            onClick={() => {
              onOpenCommand();
              onClose();
            }}
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
          {groups.map((group) =>
            group.items.length === 0 ? null : (
              <div key={group.id} className={styles.group}>
                <div className={styles.groupLabel}>{group.label}</div>
                <ul className={styles.groupList}>
                  {group.items.map((item) => {
                    const Icon = item.icon;
                    const active = item.id === activeId;
                    return (
                      <li key={item.id}>
                        <Link
                          href={item.href}
                          className={`${styles.item} ${active ? styles.active : ""} ${
                            item.signature === "oracle" ? styles.oracle : ""
                          }`}
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
            ),
          )}
        </div>

        <div className={styles.sheetFooter}>
          <button
            type="button"
            className={styles.addButton}
            onClick={() => {
              onOpenAdd();
              onClose();
            }}
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
