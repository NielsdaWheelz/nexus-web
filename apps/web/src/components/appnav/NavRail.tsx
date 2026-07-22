"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, Plus, Search } from "lucide-react";
import Link from "next/link";
import AsterismMark from "@/components/AsterismMark";
import { useAnchoredPosition } from "@/lib/ui/useAnchoredPosition";
import NavAccount from "./NavAccount";
import type { AppNavActivationResult } from "./navActivation";
import type { NavItem } from "./navModel";
import styles from "./AppNav.module.css";

export default function NavRail({
  items,
  home,
  account,
  settingsActive,
  activeId,
  collapsed,
  onToggleCollapse,
  commandHint,
  commandCombo,
  onOpenCommand,
  onOpenAdd,
  onNavigate,
}: {
  items: readonly NavItem[];
  home: NavItem;
  account: NavItem;
  settingsActive: boolean;
  activeId: NavItem["id"] | null;
  collapsed: boolean;
  onToggleCollapse: () => void;
  commandHint: string;
  commandCombo: string;
  onOpenCommand: () => void;
  onOpenAdd: () => void;
  onNavigate: (event: MouseEvent<HTMLElement>, href: string) => AppNavActivationResult;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Map<string, HTMLElement>>(new Map());
  const [indicator, setIndicator] = useState({ top: 0, height: 0, visible: false });
  const [tip, setTip] = useState<NavItem | null>(null);

  const measure = useCallback(() => {
    const list = listRef.current;
    const el = activeId ? itemRefs.current.get(activeId) : null;
    if (!list || !el) {
      setIndicator((prev) => ({ ...prev, visible: false }));
      return;
    }
    const listBox = list.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    setIndicator({
      top: box.top - listBox.top + list.scrollTop,
      height: box.height,
      visible: true,
    });
  }, [activeId]);

  useLayoutEffect(() => measure(), [measure, collapsed, items]);
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(list);
    return () => observer.disconnect();
  }, [measure]);

  const tipAnchor = tip ? itemRefs.current.get(tip.id) ?? null : null;
  const { ref: tipRef, style: tipStyle } = useAnchoredPosition<HTMLDivElement>(tipAnchor, {
    enabled: collapsed && tip !== null,
    placement: "right",
    align: "center",
    gap: 8,
    flip: true,
  });

  return (
    <nav className={`${styles.rail} ${collapsed ? styles.collapsed : ""}`} aria-label="Primary">
      <div className={styles.brand}>
        <Link
          href={home.href}
          className={styles.brandLink}
          aria-label="Nexus — Home"
          onClick={(event) => onNavigate(event, home.href)}
        >
          <AsterismMark size={20} className={styles.brandMark} />
          <span className={styles.brandText}>Nexus</span>
        </Link>
        <button
          type="button"
          className={styles.collapseButton}
          onClick={onToggleCollapse}
          aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
        >
          {collapsed ? <ChevronRight size={16} aria-hidden="true" /> : <ChevronLeft size={16} aria-hidden="true" />}
        </button>
      </div>

      <div className={styles.commandWrap}>
        <button
          type="button"
          className={`${styles.commandBar} ${collapsed ? styles.commandBarCollapsed : ""}`}
          onClick={onOpenCommand}
          aria-haspopup="dialog"
          aria-keyshortcuts={commandCombo}
          aria-label="Search or ask anything"
        >
          <span className={styles.commandIcon}>
            <Search size={16} aria-hidden="true" />
          </span>
          {!collapsed && (
            <>
              <span className={styles.commandText}>Search or ask anything…</span>
              <kbd className={styles.commandKbd}>{commandHint}</kbd>
            </>
          )}
        </button>
      </div>

      <div ref={listRef} className={styles.scroll}>
        <span
          className={`${styles.indicator} ${indicator.visible ? styles.visible : ""}`}
          style={{ height: indicator.height, transform: `translateY(${indicator.top}px)` }}
          aria-hidden="true"
        />
        <ul className={styles.navList}>
          {items.map((item) => {
            const Icon = item.icon;
            const active = item.id === activeId;
            return (
              <li key={item.id}>
                <Link
                  ref={(el) => {
                    if (el) itemRefs.current.set(item.id, el);
                    else itemRefs.current.delete(item.id);
                  }}
                  href={item.href}
                  className={`${styles.item} ${active ? styles.active : ""}`}
                  data-presentation={item.presentation}
                  aria-label={item.label}
                  aria-current={active ? "page" : undefined}
                  onClick={(event) => onNavigate(event, item.href)}
                  onMouseEnter={() => setTip(item)}
                  onMouseLeave={() => setTip((current) => (current === item ? null : current))}
                  onFocus={() => setTip(item)}
                  onBlur={() => setTip((current) => (current === item ? null : current))}
                >
                  <span className={styles.itemIcon}>
                    <Icon size={20} strokeWidth={2} aria-hidden="true" />
                  </span>
                  {!collapsed && <span className={styles.itemLabel}>{item.label}</span>}
                </Link>
              </li>
            );
          })}
        </ul>
      </div>

      <div className={styles.footer}>
        <button
          type="button"
          className={styles.addButton}
          onClick={onOpenAdd}
          aria-haspopup="dialog"
          aria-label="Add content"
        >
          <span className={styles.itemIcon}>
            <Plus size={20} strokeWidth={2} aria-hidden="true" />
          </span>
          {!collapsed && <span className={styles.itemLabel}>Add</span>}
        </button>
        <NavAccount
          settings={account}
          active={settingsActive}
          collapsed={collapsed}
          onNavigate={onNavigate}
        />
      </div>

      {collapsed &&
        tip &&
        createPortal(
          <div ref={tipRef} className={styles.tooltip} style={tipStyle} role="tooltip">
            {tip.label}
          </div>,
          document.body,
        )}
    </nav>
  );
}
