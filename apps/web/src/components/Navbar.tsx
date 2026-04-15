"use client";

import {
  useCallback,
  useMemo,
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
  Plus,
  Search,
  Settings,
} from "lucide-react";
import Link from "next/link";
import { useWorkspaceStore } from "@/lib/workspace/store";
import { OPEN_UPLOAD_EVENT } from "@/components/CommandPalette";
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
  const { state, navigatePane } = useWorkspaceStore();

  const activePane = useMemo(
    () => state.panes.find((p) => p.id === state.activePaneId) ?? null,
    [state],
  );
  const currentPathname = useMemo(
    () => (activePane ? pathnameFromHref(activePane.href) : ""),
    [activePane],
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

  const handleAddContent = useCallback(() => {
    window.dispatchEvent(new CustomEvent(OPEN_UPLOAD_EVENT));
  }, []);

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

      <div className={styles.uploadSection}>
        <button
          type="button"
          className={styles.navItem}
          aria-label="Add content"
          aria-haspopup="dialog"
          onClick={handleAddContent}
        >
          <span className={styles.icon} aria-hidden="true">
            <Plus size={18} strokeWidth={2} />
          </span>
          {!collapsed && <span className={styles.label}>Add</span>}
        </button>
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
