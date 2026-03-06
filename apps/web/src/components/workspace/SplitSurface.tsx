"use client";

import { useEffect, useId, useState } from "react";
import styles from "./SplitSurface.module.css";
import { SplitSurfaceOverlayContext } from "./SplitSurfaceContext";

interface SplitSurfaceProps {
  primary: React.ReactNode;
  secondary?: React.ReactNode;
  secondaryTitle?: string;
  secondaryFabLabel?: string;
  defaultSecondaryOpenMobile?: boolean;
}

export default function SplitSurface({
  primary,
  secondary,
  secondaryTitle = "Secondary pane",
  secondaryFabLabel = "Open context",
  defaultSecondaryOpenMobile = false,
}: SplitSurfaceProps) {
  const [secondaryOpenMobile, setSecondaryOpenMobile] = useState(defaultSecondaryOpenMobile);
  const secondarySurfaceId = useId();
  const hasSecondary = Boolean(secondary);

  useEffect(() => {
    if (!secondaryOpenMobile) {
      return;
    }
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [secondaryOpenMobile]);

  useEffect(() => {
    if (!secondaryOpenMobile) {
      return;
    }
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSecondaryOpenMobile(false);
      }
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [secondaryOpenMobile]);

  return (
    <div className={styles.surface}>
      <div className={styles.desktopRow}>
        <div className={styles.primary} data-split-role="primary">{primary}</div>
        {hasSecondary && <aside className={styles.secondaryDesktop}>{secondary}</aside>}
      </div>

      {hasSecondary && (
        <button
          type="button"
          className={`${styles.mobileFab} ${secondaryOpenMobile ? styles.mobileFabActive : ""}`}
          onClick={() => setSecondaryOpenMobile((prev) => !prev)}
          aria-label={secondaryFabLabel}
          aria-controls={secondarySurfaceId}
          aria-expanded={secondaryOpenMobile}
          data-open={secondaryOpenMobile ? "true" : "false"}
        >
          {secondaryFabLabel}
        </button>
      )}

      {hasSecondary && secondaryOpenMobile && (
        <div
          className={styles.mobileOverlayBackdrop}
          onClick={() => setSecondaryOpenMobile(false)}
        >
          <aside
            id={secondarySurfaceId}
            className={styles.mobileOverlay}
            role="dialog"
            aria-modal="true"
            aria-label={secondaryTitle}
            onClick={(event) => event.stopPropagation()}
          >
            <header className={styles.mobileOverlayHeader}>
              <h2>{secondaryTitle}</h2>
              <button
                type="button"
                className={styles.mobileOverlayClose}
                onClick={() => setSecondaryOpenMobile(false)}
              >
                Close
              </button>
            </header>
            <SplitSurfaceOverlayContext.Provider value={true}>
              <div className={styles.mobileOverlayContent}>{secondary}</div>
            </SplitSurfaceOverlayContext.Provider>
          </aside>
        </div>
      )}
    </div>
  );
}
