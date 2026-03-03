"use client";

import { useState } from "react";
import Navbar from "@/components/Navbar";
import { ToastProvider } from "@/components/Toast";
import styles from "./layout.module.css";

export default function AuthenticatedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [navbarCollapsed, setNavbarCollapsed] = useState(false);

  return (
    <ToastProvider>
      <div
        className={`${styles.layout} ${navbarCollapsed ? styles.navCollapsed : ""}`}
      >
        <Navbar onToggle={setNavbarCollapsed} />
        <main className={styles.main}>{children}</main>
      </div>
    </ToastProvider>
  );
}
