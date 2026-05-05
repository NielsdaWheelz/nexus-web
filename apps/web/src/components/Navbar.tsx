"use client";

import { useCallback, useMemo, useState, type MouseEvent } from "react";
import {
  BookOpen,
  ChevronLeft,
  ChevronRight,
  Compass,
  LogOut,
  MessageSquare,
  Mic,
  Plus,
  Search,
  Settings,
  Sparkles,
} from "lucide-react";
import Link from "next/link";
import { useWorkspaceStore } from "@/lib/workspace/store";
import { dispatchOpenAddContent } from "@/components/addContentEvents";
import styles from "./Navbar.module.css";

interface NavbarProps {
  onToggle?: (collapsed: boolean) => void;
}

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
  const librariesActive =
    currentPathname === "/libraries" || currentPathname.startsWith("/libraries/");
  const browseActive = currentPathname === "/browse";
  const podcastsActive =
    currentPathname === "/podcasts" || currentPathname.startsWith("/podcasts/");
  const chatsActive =
    currentPathname === "/conversations" || currentPathname.startsWith("/conversations/");
  const searchActive = currentPathname === "/search";
  const oracleActive =
    currentPathname === "/oracle" || currentPathname.startsWith("/oracle/");
  const settingsActive =
    currentPathname === "/settings" || currentPathname.startsWith("/settings/");

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

  const ToggleIcon = collapsed ? ChevronRight : ChevronLeft;

  const handleAddContent = useCallback(() => {
    dispatchOpenAddContent("content");
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
        <Link
          href="/libraries"
          className={`${styles.navItem} ${librariesActive ? styles.active : ""}`}
          onClick={(e) => handleNavClick(e, "/libraries")}
        >
          <span className={styles.icon} aria-hidden="true">
            <BookOpen size={18} strokeWidth={2} />
          </span>
          {!collapsed && <span className={styles.label}>Libraries</span>}
        </Link>
        <Link
          href="/browse"
          className={`${styles.navItem} ${browseActive ? styles.active : ""}`}
          onClick={(e) => handleNavClick(e, "/browse")}
        >
          <span className={styles.icon} aria-hidden="true">
            <Compass size={18} strokeWidth={2} />
          </span>
          {!collapsed && <span className={styles.label}>Browse</span>}
        </Link>
        <Link
          href="/podcasts"
          className={`${styles.navItem} ${podcastsActive ? styles.active : ""}`}
          onClick={(e) => handleNavClick(e, "/podcasts")}
        >
          <span className={styles.icon} aria-hidden="true">
            <Mic size={18} strokeWidth={2} />
          </span>
          {!collapsed && <span className={styles.label}>Podcasts</span>}
        </Link>
        <Link
          href="/conversations"
          className={`${styles.navItem} ${chatsActive ? styles.active : ""}`}
          onClick={(e) => handleNavClick(e, "/conversations")}
        >
          <span className={styles.icon} aria-hidden="true">
            <MessageSquare size={18} strokeWidth={2} />
          </span>
          {!collapsed && <span className={styles.label}>Chats</span>}
        </Link>
        <a
          href="/search"
          className={`${styles.navItem} ${searchActive ? styles.active : ""}`}
          onClick={(e) => handleNavClick(e, "/search")}
        >
          <span className={styles.icon} aria-hidden="true">
            <Search size={18} strokeWidth={2} />
          </span>
          {!collapsed && <span className={styles.label}>Search</span>}
        </a>
        <Link
          href="/oracle"
          className={`${styles.navItem} ${oracleActive ? styles.active : ""}`}
          onClick={(e) => handleNavClick(e, "/oracle")}
        >
          <span className={styles.icon} aria-hidden="true">
            <Sparkles size={18} strokeWidth={2} />
          </span>
          {!collapsed && <span className={styles.label}>Oracle</span>}
        </Link>
        <a
          href="/settings"
          className={`${styles.navItem} ${settingsActive ? styles.active : ""}`}
          onClick={(e) => handleNavClick(e, "/settings")}
        >
          <span className={styles.icon} aria-hidden="true">
            <Settings size={18} strokeWidth={2} />
          </span>
          {!collapsed && <span className={styles.label}>Settings</span>}
        </a>
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
