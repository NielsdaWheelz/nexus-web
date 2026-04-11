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
  Plus,
  Search,
  Settings,
  X,
} from "lucide-react";
import Link from "next/link";
import { useWorkspaceStore } from "@/lib/workspace/store";
import { requestOpenInAppPane } from "@/lib/panes/openInAppPane";
import { OPEN_UPLOAD_EVENT } from "@/components/CommandPalette";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import { getFocusableElements } from "@/lib/ui/getFocusableElements";
import { useFocusTrap } from "@/lib/ui/useFocusTrap";
import FileUpload from "@/components/FileUpload";
import AddFromUrl from "@/components/AddFromUrl";
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
  const [uploadOpen, setUploadOpen] = useState(false);
  const uploadPopoverId = useId();
  const uploadButtonRef = useRef<HTMLButtonElement>(null);
  const uploadPopoverRef = useRef<HTMLElement>(null);
  const isMobile = useIsMobileViewport();
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

  const handleCloseUpload = useCallback(() => {
    setUploadOpen(false);
  }, []);

  const handleUploadNavigate = useCallback(
    (href: string) => {
      setUploadOpen(false);
      requestOpenInAppPane(href);
    },
    [],
  );

  // Open upload popover when command palette dispatches the event
  useEffect(() => {
    const handler = () => setUploadOpen(true);
    window.addEventListener(OPEN_UPLOAD_EVENT, handler);
    return () => window.removeEventListener(OPEN_UPLOAD_EVENT, handler);
  }, []);

  // Desktop: close upload popover on click-outside or Escape
  useEffect(() => {
    if (isMobile || !uploadOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        handleCloseUpload();
      }
    };

    const handleClickOutside = (e: globalThis.MouseEvent) => {
      if (
        uploadPopoverRef.current &&
        !uploadPopoverRef.current.contains(e.target as Node) &&
        uploadButtonRef.current &&
        !uploadButtonRef.current.contains(e.target as Node)
      ) {
        handleCloseUpload();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isMobile, uploadOpen, handleCloseUpload]);

  // Mobile: lock scroll when upload sheet is open
  useEffect(() => {
    if (!isMobile || !uploadOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isMobile, uploadOpen]);

  // Mobile: focus trap for upload sheet
  useFocusTrap(uploadPopoverRef, isMobile && uploadOpen);

  // Mobile: initial focus, Escape handling, and focus restoration for upload sheet
  useEffect(() => {
    if (!isMobile || !uploadOpen || !uploadPopoverRef.current) return;
    const sheet = uploadPopoverRef.current;
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const focusable = getFocusableElements(sheet);
    (focusable[0] ?? sheet).focus();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        handleCloseUpload();
      }
    };

    const uploadButton = uploadButtonRef.current;
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      if (uploadButton) {
        uploadButton.focus();
      } else {
        previouslyFocused?.focus();
      }
    };
  }, [isMobile, uploadOpen, handleCloseUpload]);

  if (isMobile) {
    if (!uploadOpen) return null;
    return (
      <div
        className={styles.mobileTabSwitcherBackdrop}
        onClick={handleCloseUpload}
      >
        <section
          ref={uploadPopoverRef}
          id={uploadPopoverId}
          className={styles.mobileTabSwitcher}
          role="dialog"
          aria-modal="true"
          aria-label="Add content"
          tabIndex={-1}
          onClick={(event) => event.stopPropagation()}
        >
          <div className={styles.mobileTabSwitcherHandle} aria-hidden="true" />
          <header className={styles.mobileTabSwitcherHeader}>
            <h2>Add content</h2>
            <button
              type="button"
              className={styles.mobileTabSwitcherClose}
              onClick={handleCloseUpload}
              aria-label="Close"
            >
              <X size={16} aria-hidden="true" />
            </button>
          </header>
          <div className={styles.uploadSheetBody}>
            <FileUpload onNavigate={handleUploadNavigate} />
            <AddFromUrl onNavigate={handleUploadNavigate} />
          </div>
        </section>
      </div>
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

      <div className={styles.uploadSection}>
        <button
          ref={uploadButtonRef}
          type="button"
          className={`${styles.navItem} ${uploadOpen ? styles.active : ""}`}
          aria-label="Add content"
          aria-haspopup="dialog"
          aria-expanded={uploadOpen}
          aria-controls={uploadPopoverId}
          onClick={() => setUploadOpen((prev) => !prev)}
        >
          <span className={styles.icon} aria-hidden="true">
            <Plus size={18} strokeWidth={2} />
          </span>
          {!collapsed && <span className={styles.label}>Add</span>}
        </button>
        {uploadOpen && (
          <section
            ref={uploadPopoverRef}
            id={uploadPopoverId}
            className={styles.uploadPopover}
            role="dialog"
            aria-modal="false"
            aria-label="Add content"
          >
            <FileUpload onNavigate={handleUploadNavigate} />
            <AddFromUrl onNavigate={handleUploadNavigate} />
          </section>
        )}
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
