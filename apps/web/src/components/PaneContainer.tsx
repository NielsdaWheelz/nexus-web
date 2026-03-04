"use client";

import { useState, useEffect } from "react";
import styles from "./PaneContainer.module.css";

const MOBILE_BREAKPOINT = 768;

interface PaneContainerProps {
  children: React.ReactNode;
  /** When provided and viewport is mobile, show tab bar to switch between panes. */
  mobileLabels?: [string, string];
}

export default function PaneContainer({
  children,
  mobileLabels,
}: PaneContainerProps) {
  const [activeMobilePane, setActiveMobilePane] = useState(0);
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const check = () =>
      setIsMobile(typeof window !== "undefined" && window.innerWidth <= MOBILE_BREAKPOINT);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  const childArray = Array.isArray(children) ? children : [children];
  const hasTwoPanes =
    mobileLabels &&
    childArray.length >= 2 &&
    mobileLabels.length >= 2;

  const showMobileTabs = isMobile && hasTwoPanes;

  return (
    <div className={styles.container}>
      {showMobileTabs && (
        <div
          className={styles.mobileTabs}
          role="tablist"
          aria-label="Content and highlights"
        >
          <button
            role="tab"
            aria-selected={activeMobilePane === 0}
            aria-controls="pane-content"
            id="tab-content"
            className={`${styles.mobileTab} ${activeMobilePane === 0 ? styles.mobileTabActive : ""}`}
            onClick={() => setActiveMobilePane(0)}
          >
            {mobileLabels[0]}
          </button>
          <button
            role="tab"
            aria-selected={activeMobilePane === 1}
            aria-controls="pane-highlights"
            id="tab-highlights"
            className={`${styles.mobileTab} ${activeMobilePane === 1 ? styles.mobileTabActive : ""}`}
            onClick={() => setActiveMobilePane(1)}
          >
            {mobileLabels[1]}
          </button>
        </div>
      )}
      <div className={styles.panesWrapper}>
        {showMobileTabs
          ? childArray.slice(0, 2).map((child, i) => (
              <div
                key={i}
                id={i === 0 ? "pane-content" : "pane-highlights"}
                role="tabpanel"
                aria-labelledby={i === 0 ? "tab-content" : "tab-highlights"}
                hidden={i !== activeMobilePane}
                className={styles.mobilePane}
              >
                {child}
              </div>
            ))
          : children}
      </div>
      {showMobileTabs && childArray.length > 2 && childArray.slice(2)}
    </div>
  );
}
