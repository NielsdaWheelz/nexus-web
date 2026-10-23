"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, CircleUser, Plus, Search } from "lucide-react";
import AsterismMark from "@/components/AsterismMark";
import ImportsBadge from "@/components/imports/ImportsBadge";
import Button from "@/components/ui/Button";
import { buttonClassName } from "@/components/ui/control";
import Tooltip from "@/components/ui/Tooltip";
import { requestNexusOpen } from "@/lib/nexus/events";
import { sectionDestinationIdForHref } from "@/lib/panes/paneRouteModel";
import {
  activateTargetLink,
  type AppNavActivationResult,
} from "@/lib/panes/targetLinkActivation";
import { useRenderEnvironment } from "@/lib/renderEnvironment/provider";
import { NAV_COLLAPSED_COOKIE } from "@/lib/renderEnvironment/types";
import { formatShortcut, shortcutAriaKeys, SHORTCUTS } from "@/lib/shortcuts";
import { cx } from "@/lib/ui/cx";
import type { TargetActivationEvent } from "@/lib/ui/targetActivation";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import { useLatestWorkspace, useWorkspaceStore } from "@/lib/workspace/store";
import type { WorkspaceTargetActivationResult } from "@/lib/workspace/targetActivation";
import AccountMenu from "./AccountMenu";
import {
  isAccountDestinationId,
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

  // Phones navigate from the Nexus button; each pane draws its own top bar.
  return useIsMobileViewport() ? null : <NavRail collapsed={collapsed} onToggle={toggle} />;
}

function NavRail({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const { state, activateWorkspaceTarget } = useWorkspaceStore();
  const latestWorkspace = useLatestWorkspace();
  const [indicator, setIndicator] = useState<{ top: number; height: number } | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const { platform } = useRenderEnvironment();
  const shortcut = SHORTCUTS["Nexus.Open"];
  const hint = formatShortcut(shortcut, platform);
  const activeHref = state.panes.find((pane) => pane.id === state.active_primary_pane_id)
    ?.current_visit.href;
  const section = activeHref ? sectionDestinationIdForHref(activeHref) : null;
  const accountActive = isAccountDestinationId(section);

  useLayoutEffect(() => {
    const item = listRef.current?.querySelector<HTMLElement>("[aria-current='page']");
    setIndicator(item ? { top: item.offsetTop, height: item.offsetHeight } : null);
  }, [section, collapsed]);

  // An ordinary rail link survives navigation and keeps focus. A menu item
  // yields to a changed destination; an unchanged one returns to its trigger.
  function navigate(
    event: TargetActivationEvent,
    item: NavItem,
    fromMenu = false,
  ): AppNavActivationResult {
    let result = null as WorkspaceTargetActivationResult | null;
    const handled = activateTargetLink({
      event,
      target: { href: item.href },
      runtime: {
        activateTarget: ({ target, disposition }) => {
          return result = activateWorkspaceTarget({
            originPaneId: state.active_primary_pane_id,
            target,
            disposition,
          });
        },
      },
    });
    if (handled === "unhandled" || handled === "consumed" || result?.kind === "Cancelled") return handled === "unhandled" ? handled : "consumed";
    if (result?.kind === "Unchanged" || (!fromMenu && handled === "handled-default")) {
      const workspace = latestWorkspace();
      const focus = workspace.pendingPaneFocus;
      if (focus && focus.paneId === result?.paneId) workspace.claimPaneFocus(focus);
      return "handled-source-focus";
    }
    return "handled-destination-focus";
  }

  const home = NAV_RAIL[0];
  const ImportsIcon = NAV_IMPORTS.icon;
  return (
    <nav className={cx(styles.rail, collapsed && styles.collapsed)} aria-label="Primary">
      <div className={styles.brand}>
        <a
          href={home.href}
          className={styles.brandLink}
          aria-label="Nexus — Home"
          onClick={(event) => navigate(event, home)}
          onKeyDown={(event) => navigate(event, home)}
        >
          <AsterismMark size={20} className={styles.brandMark} />
          <span className={styles.brandText}>Nexus</span>
        </a>
        <Button
          iconOnly
          icon={collapsed ? <ChevronRight /> : <ChevronLeft />}
          className={styles.collapseButton}
          aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
          onClick={onToggle}
        />
      </div>

      <Tooltip
        text={`Search (${hint})`}
        placement="right"
        openDelayMs={0}
        disabled={!collapsed}
        renderTrigger={(tooltip) => (
          <button
            {...tooltip}
            type="button"
            className={cx(buttonClassName({}), styles.command)}
            aria-haspopup="dialog"
            aria-keyshortcuts={shortcutAriaKeys(shortcut, platform)}
            aria-label="Search"
            onClick={() => requestNexusOpen({ kind: "Root" })}
          >
            <Search className={styles.icon} size={20} aria-hidden="true" />
            <span className={styles.commandText}>Search</span>
            <kbd className={styles.commandKbd}>{hint}</kbd>
          </button>
        )}
      />

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
                <Tooltip
                  text={item.label}
                  placement="right"
                  openDelayMs={0}
                  disabled={!collapsed}
                  renderTrigger={(tooltip) => (
                    <a
                      {...tooltip}
                      href={item.href}
                      className={cx(buttonClassName({}), styles.item)}
                      aria-label={item.label}
                      aria-current={active ? "page" : undefined}
                      onClick={(event) => navigate(event, item)}
                      onKeyDown={(event) => navigate(event, item)}
                    >
                      <Icon className={styles.icon} size={20} aria-hidden="true" />
                      <span className={styles.label}>{item.label}</span>
                    </a>
                  )}
                />
              </li>
            );
          })}
        </ul>
      </div>

      <div className={styles.footer}>
        <Tooltip
          text={NAV_IMPORTS.label}
          placement="right"
          openDelayMs={0}
          disabled={!collapsed}
          renderTrigger={help => (
            <a
              {...help}
              href={NAV_IMPORTS.href}
              className={cx(buttonClassName({}), styles.item, styles.imports)}
              aria-current={section === "imports" ? "page" : undefined}
              onClick={(event) => navigate(event, NAV_IMPORTS)}
              onKeyDown={(event) => navigate(event, NAV_IMPORTS)}
            >
              <ImportsIcon className={styles.icon} size={20} aria-hidden="true" />
              {/* Collapsed, the count stays above the icon, inside this link. */}
              <span className={collapsed ? styles.importsChip : cx(styles.label, styles.importsLabel)}>
                <ImportsBadge label={NAV_IMPORTS.label} labelVisible={!collapsed} />
              </span>
            </a>
          )}
        />
        <Tooltip
          text="Add content"
          placement="right"
          openDelayMs={0}
          disabled={!collapsed}
          renderTrigger={help => (
            <button
              {...help}
              type="button"
              className={cx(buttonClassName({}), styles.item)}
              aria-haspopup="dialog"
              aria-label="Add content"
              onClick={() => requestNexusOpen({
                kind: "Add",
                seed: { kind: "Content", initialDestinations: [] },
              })}
            >
              <Plus className={styles.icon} size={20} aria-hidden="true" />
              <span className={styles.label}>Add</span>
            </button>
          )}
        />
        <AccountMenu
          activeId={accountActive ? section : null}
          importsActive={section === "imports"}
          placement="above"
          align="start"
          onNavigate={(event, item) => navigate(event, item, true)}
          renderTrigger={(trigger) => (
            <Tooltip text="account" placement="right" openDelayMs={0}
              disabled={!collapsed || trigger["aria-expanded"]} triggerRef={trigger.ref}
              renderTrigger={help => (
                <button
                  {...trigger}
                  {...help}
                  type="button"
                  className={cx(buttonClassName({}), styles.item)}
                  aria-describedby={cx(help["aria-describedby"], trigger["aria-describedby"]) || undefined}
                  aria-current={accountActive ? "page" : undefined}
                >
                  <CircleUser className={styles.icon} size={20} aria-hidden="true" />
                  <span className={styles.label}>Account</span>
                </button>
              )} />
          )}
        />
      </div>
    </nav>
  );
}
