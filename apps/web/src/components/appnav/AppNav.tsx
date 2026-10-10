"use client";

import { useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import { ChevronLeft, ChevronRight, CircleUser, Plus, Search } from "lucide-react";
import Link from "next/link";
import AsterismMark from "@/components/AsterismMark";
import ImportsBadge from "@/components/imports/ImportsBadge";
import { DEFAULT_KEYBINDINGS } from "@/lib/keybindings";
import { useKeybinding, useKeybindingLabel } from "@/lib/keybindingsProvider";
import { requestNexusOpen } from "@/lib/nexus/events";
import { sectionDestinationIdForHref } from "@/lib/panes/paneRouteModel";
import {
  activateTargetLink,
  type AppNavActivationResult,
} from "@/lib/panes/targetLinkActivation";
import { useRenderEnvironment } from "@/lib/renderEnvironment/provider";
import { NAV_COLLAPSED_COOKIE } from "@/lib/renderEnvironment/types";
import { cx } from "@/lib/ui/cx";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import { findPaneChromeFocusTarget } from "@/lib/workspace/paneDom";
import { useWorkspaceStore } from "@/lib/workspace/store";
import type { WorkspaceTargetActivationResult } from "@/lib/workspace/targetActivation";
import AccountMenu from "./AccountMenu";
import MobilePaneBar from "./MobilePaneBar";
import {
  isAccountDestinationId,
  NAV_ACCENT,
  NAV_IMPORTS,
  NAV_RAIL,
  type NavItem,
} from "./navModel";
import styles from "./AppNav.module.css";

export default function AppNav() {
  const { navCollapsed } = useRenderEnvironment();
  // Held here, above the mobile switch, so a resize across the breakpoint keeps it.
  const [collapsed, setCollapsed] = useState(navCollapsed);

  function toggle() {
    document.cookie = `${NAV_COLLAPSED_COOKIE}=${collapsed ? 0 : 1}; path=/; max-age=31536000; samesite=lax`;
    setCollapsed(!collapsed);
  }

  return useIsMobileViewport() ? (
    <MobilePaneBar />
  ) : (
    <NavRail collapsed={collapsed} onToggle={toggle} />
  );
}

function NavRail({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const { state, activateWorkspaceTarget } = useWorkspaceStore();
  const [tip, setTip] = useState<{ label: string; top: number } | null>(null);
  const [indicator, setIndicator] = useState<{ top: number; height: number } | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const combo = useKeybinding("Nexus.Open") ?? DEFAULT_KEYBINDINGS["Nexus.Open"];
  const hint = useKeybindingLabel("Nexus.Open") ?? combo;
  const activeHref = state.panes.find((pane) => pane.id === state.activePrimaryPaneId)
    ?.currentVisit.href;
  const section = activeHref ? sectionDestinationIdForHref(activeHref) : null;
  const accountActive = isAccountDestinationId(section);

  useLayoutEffect(() => {
    const item = listRef.current?.querySelector<HTMLElement>("[aria-current='page']");
    setIndicator(item ? { top: item.offsetTop, height: item.offsetHeight } : null);
  }, [section, collapsed]);

  // Follow, Fork or the browser's; only an unchanged or rejected activation keeps focus here.
  // A menu item is gone once its menu closes, so from a menu the landed pane takes focus.
  function navigate(
    event: MouseEvent<HTMLElement>,
    item: NavItem,
    fromMenu = false,
  ): AppNavActivationResult {
    let result = null as WorkspaceTargetActivationResult | null;
    const handled = activateTargetLink({
      event,
      href: item.href,
      runtime: {
        activateTarget: ({ target, disposition }) => {
          result = activateWorkspaceTarget({
            originPaneId: state.activePrimaryPaneId,
            target,
            disposition,
          });
        },
      },
    });
    if (handled === "unhandled") return handled;
    if (result?.kind === "Unchanged" || result?.kind === "Rejected") return "handled-source-focus";
    const paneId = result?.paneId;
    if (fromMenu && paneId) {
      requestAnimationFrame(() => findPaneChromeFocusTarget(paneId)?.focus({ preventScroll: true }));
    }
    return "handled-destination-focus";
  }

  // The collapsed rail's tooltip sits beside the item, centred on it.
  function showTip(event: { currentTarget: HTMLElement }, label: string) {
    const box = event.currentTarget.getBoundingClientRect();
    setTip({ label, top: box.top + box.height / 2 });
  }

  const home = NAV_RAIL[0];
  const ImportsIcon = NAV_IMPORTS.icon;
  return (
    <nav className={cx(styles.rail, collapsed && styles.collapsed)} aria-label="Primary">
      <div className={styles.brand}>
        <Link
          href={home.href}
          className={styles.brandLink}
          aria-label="Nexus — Home"
          onClick={(event) => navigate(event, home)}
        >
          <AsterismMark size={20} className={styles.brandMark} />
          <span className={styles.brandText}>Nexus</span>
        </Link>
        <button
          type="button"
          className={styles.collapseButton}
          aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
          onClick={() => {
            onToggle();
            setTip(null);
          }}
        >
          {collapsed ? (
            <ChevronRight size={16} aria-hidden="true" />
          ) : (
            <ChevronLeft size={16} aria-hidden="true" />
          )}
        </button>
      </div>

      <button
        type="button"
        className={styles.command}
        aria-haspopup="dialog"
        aria-keyshortcuts={combo}
        aria-label="Search or ask anything"
        onClick={() => requestNexusOpen({ kind: "Root" })}
      >
        <Search size={16} aria-hidden="true" />
        <span className={styles.commandText}>Search or ask anything…</span>
        <kbd className={styles.commandKbd}>{hint}</kbd>
      </button>

      <div className={styles.scroll}>
        {indicator ? (
          <span
            className={styles.indicator}
            style={{ height: indicator.height, transform: `translateY(${indicator.top}px)` }}
            aria-hidden="true"
          />
        ) : null}
        <ul ref={listRef} className={styles.list}>
          {NAV_RAIL.map((item) => {
            const Icon = item.icon;
            const active = item.id === section;
            return (
              <li key={item.id}>
                <Link
                  href={item.href}
                  className={cx(styles.item, active && styles.active)}
                  data-accent={item.id === NAV_ACCENT || undefined}
                  aria-label={item.label}
                  aria-current={active ? "page" : undefined}
                  onClick={(event) => navigate(event, item)}
                  onMouseEnter={(event) => showTip(event, item.label)}
                  onFocus={(event) => showTip(event, item.label)}
                  onMouseLeave={() => setTip(null)}
                  onBlur={() => setTip(null)}
                >
                  <Icon className={styles.icon} size={20} aria-hidden="true" />
                  <span className={styles.label}>{item.label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </div>

      <div className={styles.footer}>
        <Link
          href={NAV_IMPORTS.href}
          className={cx(styles.item, styles.imports, section === "imports" && styles.active)}
          aria-current={section === "imports" ? "page" : undefined}
          onClick={(event) => navigate(event, NAV_IMPORTS)}
        >
          <ImportsIcon className={styles.icon} size={20} aria-hidden="true" />
          {/* Collapsed, the count stays: a chip above the icon, inside this link. */}
          <span className={collapsed ? styles.importsChip : cx(styles.label, styles.importsLabel)}>
            <ImportsBadge label={NAV_IMPORTS.label} labelVisible={!collapsed} />
          </span>
        </Link>
        <button
          type="button"
          className={cx(styles.item, styles.add)}
          aria-haspopup="dialog"
          aria-label="Add content"
          onClick={() =>
            requestNexusOpen({
              kind: "Add",
              seed: { kind: "Content", initialFocus: "Url", initialDestinations: [] },
            })
          }
        >
          <Plus className={styles.icon} size={20} aria-hidden="true" />
          <span className={styles.label}>Add</span>
        </button>
        <AccountMenu
          activeId={accountActive ? section : null}
          importsActive={section === "imports"}
          placement="above"
          align="start"
          onNavigate={(event, item) => navigate(event, item, true)}
          renderTrigger={(trigger) => (
            <button
              {...trigger}
              type="button"
              className={cx(styles.item, accountActive && styles.active)}
              aria-current={accountActive ? "page" : undefined}
            >
              <CircleUser className={styles.icon} size={20} aria-hidden="true" />
              <span className={styles.label}>Account</span>
            </button>
          )}
        />
      </div>

      {collapsed && tip ? (
        <div className={styles.tooltip} style={{ top: tip.top }} role="tooltip">
          {tip.label}
        </div>
      ) : null}
    </nav>
  );
}
