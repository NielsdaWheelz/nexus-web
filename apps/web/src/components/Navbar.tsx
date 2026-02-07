"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import styles from "./Navbar.module.css";

interface NavbarProps {
  onToggle?: (collapsed: boolean) => void;
}

export default function Navbar({ onToggle }: NavbarProps) {
  const [collapsed, setCollapsed] = useState(false);
  const pathname = usePathname();

  const handleToggle = () => {
    const newState = !collapsed;
    setCollapsed(newState);
    onToggle?.(newState);
  };

  const isActive = (path: string) => pathname?.startsWith(path);

  return (
    <nav className={`${styles.navbar} ${collapsed ? styles.collapsed : ""}`}>
      <div className={styles.header}>
        <Link href="/libraries" className={styles.logo}>
          {collapsed ? "N" : "Nexus"}
        </Link>
        <button
          className={styles.toggleBtn}
          onClick={handleToggle}
          aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
        >
          {collapsed ? "→" : "←"}
        </button>
      </div>

      <div className={styles.nav}>
        <Link
          href="/libraries"
          className={`${styles.navItem} ${isActive("/libraries") ? styles.active : ""}`}
        >
          <span className={styles.icon}>📚</span>
          {!collapsed && <span className={styles.label}>Libraries</span>}
        </Link>
        <Link
          href="/conversations"
          className={`${styles.navItem} ${isActive("/conversations") ? styles.active : ""}`}
        >
          <span className={styles.icon}>💬</span>
          {!collapsed && <span className={styles.label}>Chat</span>}
        </Link>
        <Link
          href="/search"
          className={`${styles.navItem} ${isActive("/search") ? styles.active : ""}`}
        >
          <span className={styles.icon}>🔍</span>
          {!collapsed && <span className={styles.label}>Search</span>}
        </Link>
        <Link
          href="/settings/keys"
          className={`${styles.navItem} ${isActive("/settings") ? styles.active : ""}`}
        >
          <span className={styles.icon}>🔑</span>
          {!collapsed && <span className={styles.label}>API Keys</span>}
        </Link>
      </div>

      <div className={styles.footer}>
        <form action="/auth/signout" method="post">
          <button type="submit" className={styles.navItem}>
            <span className={styles.icon}>🚪</span>
            {!collapsed && <span className={styles.label}>Sign Out</span>}
          </button>
        </form>
      </div>
    </nav>
  );
}
