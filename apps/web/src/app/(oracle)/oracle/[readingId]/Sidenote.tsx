"use client";

import { useState, type ReactNode } from "react";
import styles from "../oracle.module.css";

export default function Sidenote({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className={styles.sidenoteToggle}
        aria-expanded={open}
        aria-label={open ? "Hide marginal note" : "Show marginal note"}
        onClick={() => setOpen((o) => !o)}
      >
        ⊕
      </button>
      <aside className={styles.marginalia} data-open={open}>
        {children}
      </aside>
    </>
  );
}
