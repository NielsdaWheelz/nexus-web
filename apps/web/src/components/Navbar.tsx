"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import type { LucideIcon } from "lucide-react";
import {
  BookOpen,
  ChevronLeft,
  ChevronRight,
  Compass,
  LogOut,
  MessageSquare,
  PanelsTopLeft,
  Search,
  Settings,
  X,
} from "lucide-react";
import Link from "next/link";
import { useWorkspaceStore } from "@/lib/workspace/store";
import { resolvePaneDescriptor } from "@/lib/workspace/paneDescriptor";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import styles from "./Navbar.module.css";

interface NavbarProps {
  onToggle?: (collapsed: boolean) => void;
}

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  isActive?: (pathname: string) => boolean;
}

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  const selectors = [
    "button:not([disabled])",
    "[href]",
    "input:not([disabled])",
    "select:not([disabled])",
    "textarea:not([disabled])",
    "[tabindex]:not([tabindex='-1'])",
  ].join(",");
  return Array.from(container.querySelectorAll<HTMLElement>(selectors)).filter(
    (element) => !element.hasAttribute("hidden")
  );
}

const NAV_ITEMS: NavItem[] = [
  { href: "/libraries", label: "Libraries", icon: BookOpen },
  {
    href: "/discover",
    label: "Discover",
    icon: Compass,
    isActive: (pathname) =>
      pathname.startsWith("/discover") ||
      pathname.startsWith("/documents") ||
      pathname.startsWith("/podcasts") ||
      pathname.startsWith("/videos"),
  },
  { href: "/conversations", label: "Chat", icon: MessageSquare },
  { href: "/search", label: "Search", icon: Search },
  {
    href: "/settings",
    label: "Settings",
    icon: Settings,
    isActive: (pathname) => pathname.startsWith("/settings"),
  },
];

function pathnameFromHref(href: string): string {
  try {
    return new URL(href, "http://localhost").pathname;
  } catch {
    return "";
  }
}

export default function Navbar({ onToggle }: NavbarProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [tabSwitcherOpen, setTabSwitcherOpen] = useState(false);
  const tabSwitcherId = useId();
  const tabsButtonRef = useRef<HTMLButtonElement>(null);
  const tabSwitcherRef = useRef<HTMLElement>(null);
  const isMobile = useIsMobileViewport();
  const {
    state,
    runtimeTitleByPaneId,
    openHintByPaneId,
    resourceTitleByRef,
    navigatePane,
    activatePane,
  } = useWorkspaceStore();

  const activePane = useMemo(
    () => state.panes.find((p) => p.id === state.activePaneId) ?? null,
    [state],
  );
  const currentPathname = useMemo(
    () => (activePane ? pathnameFromHref(activePane.href) : ""),
    [activePane],
  );

  const tabSwitcherItems = useMemo(
    () =>
      state.panes.map((pane) => {
        const descriptor = resolvePaneDescriptor(pane, {
          nowMs: Date.now(),
          runtimeTitleByPaneId,
          openHintByPaneId,
          resourceTitleByRef,
        });
        return {
          paneId: pane.id,
          title: descriptor.resolvedTitle,
          isActive: pane.id === state.activePaneId,
        };
      }),
    [openHintByPaneId, resourceTitleByRef, runtimeTitleByPaneId, state],
  );

  const handleToggle = () => {
    const newState = !collapsed;
    setCollapsed(newState);
    onToggle?.(newState);
  };

  const navigateToHref = useCallback(
    (href: string) => {
      if (activePane) {
        navigatePane(activePane.id, href);
      } else {
        window.location.assign(href);
      }
    },
    [activePane, navigatePane],
  );

  const handleNavClick = useCallback(
    (event: MouseEvent<HTMLAnchorElement>, href: string) => {
      event.preventDefault();
      navigateToHref(href);
    },
    [navigateToHref],
  );

  const isActive = (item: NavItem) => {
    if (!currentPathname) {
      return false;
    }
    if (item.isActive) {
      return item.isActive(currentPathname);
    }
    return currentPathname === item.href || currentPathname.startsWith(`${item.href}/`);
  };

  const ToggleIcon = collapsed ? ChevronRight : ChevronLeft;

  const handleTabSelect = useCallback(
    (paneId: string) => {
      activatePane(paneId);
      setTabSwitcherOpen(false);
    },
    [activatePane],
  );

  const handleCloseTabSwitcher = useCallback(() => {
    setTabSwitcherOpen(false);
  }, []);

  useEffect(() => {
    if (!isMobile || !tabSwitcherOpen) {
      return;
    }
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isMobile, tabSwitcherOpen]);

  useEffect(() => {
    if (!isMobile || !tabSwitcherOpen || !tabSwitcherRef.current) {
      return;
    }
    const dialog = tabSwitcherRef.current;
    const tabsButton = tabsButtonRef.current;
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const initialFocusable = getFocusableElements(dialog);
    (initialFocusable[0] ?? dialog).focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        handleCloseTabSwitcher();
        return;
      }
      if (event.key !== "Tab") {
        return;
      }

      const focusable = getFocusableElements(dialog);
      if (focusable.length === 0) {
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;

      if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
        return;
      }
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      if (tabsButton) {
        tabsButton.focus();
      } else {
        previouslyFocused?.focus();
      }
    };
  }, [handleCloseTabSwitcher, isMobile, tabSwitcherOpen]);

  if (isMobile) {
    return (
      <>
        <nav className={styles.mobileNav} aria-label="Mobile navigation">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = isActive(item);
            return (
              <button
                key={item.href}
                type="button"
                className={`${styles.mobileNavItem} ${active ? styles.active : ""}`}
                aria-label={item.label}
                onClick={() => navigateToHref(item.href)}
              >
                <Icon size={18} strokeWidth={2} aria-hidden="true" />
              </button>
            );
          })}
          <button
            ref={tabsButtonRef}
            type="button"
            className={`${styles.mobileNavItem} ${tabSwitcherOpen ? styles.mobileNavItemActive : ""}`}
            aria-label="Tabs"
            aria-haspopup="dialog"
            aria-expanded={tabSwitcherOpen}
            aria-controls={tabSwitcherId}
            onClick={() => setTabSwitcherOpen((prev) => !prev)}
          >
            <PanelsTopLeft size={18} strokeWidth={2} aria-hidden="true" />
          </button>
        </nav>

        {tabSwitcherOpen && (
          <div
            className={styles.mobileTabSwitcherBackdrop}
            onClick={handleCloseTabSwitcher}
          >
            <section
              ref={tabSwitcherRef}
              id={tabSwitcherId}
              className={styles.mobileTabSwitcher}
              role="dialog"
              aria-modal="true"
              aria-label="Open tabs"
              tabIndex={-1}
              onClick={(event) => event.stopPropagation()}
            >
              <div className={styles.mobileTabSwitcherHandle} aria-hidden="true" />
              <header className={styles.mobileTabSwitcherHeader}>
                <h2>Open tabs</h2>
                <button
                  type="button"
                  className={styles.mobileTabSwitcherClose}
                  onClick={handleCloseTabSwitcher}
                  aria-label="Close tabs"
                >
                  <X size={16} aria-hidden="true" />
                </button>
              </header>
              <div className={styles.mobileTabList}>
                {tabSwitcherItems.map((item) => (
                  <button
                    key={item.paneId}
                    type="button"
                    className={`${styles.mobileTabItem} ${item.isActive ? styles.mobileTabItemActive : ""}`}
                    aria-current={item.isActive ? "page" : undefined}
                    onClick={() => handleTabSelect(item.paneId)}
                  >
                    {item.title}
                  </button>
                ))}
              </div>
              <div className={styles.mobileTabActions}>
                <form action="/auth/signout" method="post" className={styles.mobileSignOutForm}>
                  <button type="submit" className={styles.mobileTabActionBtn}>
                    <LogOut size={16} aria-hidden="true" />
                    <span>Sign Out</span>
                  </button>
                </form>
              </div>
            </section>
          </div>
        )}
      </>
    );
  }

  return (
    <nav className={`${styles.navbar} ${collapsed ? styles.collapsed : ""}`}>
      <div className={styles.header}>
        <Link
          href="/libraries"
          className={styles.logo}
          onClick={(e) => handleNavClick(e, "/libraries")}
        >
          {collapsed ? "N" : "Nexus"}
        </Link>
        <button
          className={styles.toggleBtn}
          onClick={handleToggle}
          aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
        >
          <ToggleIcon size={14} aria-hidden="true" />
        </button>
      </div>

      <div className={styles.nav}>
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          return (
            <a
              key={item.href}
              href={item.href}
              className={`${styles.navItem} ${isActive(item) ? styles.active : ""}`}
              onClick={(e) => handleNavClick(e, item.href)}
            >
              <span className={styles.icon} aria-hidden="true">
                <Icon size={18} strokeWidth={2} />
              </span>
              {!collapsed && <span className={styles.label}>{item.label}</span>}
            </a>
          );
        })}
      </div>

      <div className={styles.footer}>
        <form action="/auth/signout" method="post">
          <button type="submit" className={styles.navItem}>
            <span className={styles.icon} aria-hidden="true">
              <LogOut size={18} strokeWidth={2} />
            </span>
            {!collapsed && <span className={styles.label}>Sign Out</span>}
          </button>
        </form>
      </div>
    </nav>
  );
}
