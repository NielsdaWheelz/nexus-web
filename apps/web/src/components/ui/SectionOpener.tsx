"use client";

import type { ReactNode } from "react";
import styles from "./SectionOpener.module.css";

interface SectionOpenerProps {
  heading: ReactNode; // the display line (static index title or dynamic detail title)
  scale?: "display" | "title"; // "display" → --text-display-1; "title" → --text-3xl
  standfirst?: ReactNode; // optional editorial lede, measure-constrained
  pending?: boolean; // skeleton for async dynamic headings
  actions?: ReactNode; // rare opener-level action (e.g. "New library")
}

/**
 * SectionOpener — the once-per-surface grand entrance at the top of a list
 * body: a flush-left display headline (the real display type ladder), an
 * optional standfirst, then a single hairline rule and generous air. It owns
 * the accessible page `<h1>`. Domain-free (css only); it scrolls away, which is
 * exactly what a section opener is (the sticky RunningHead carries continuity).
 */
export default function SectionOpener({
  heading,
  scale = "display",
  standfirst,
  pending = false,
  actions,
}: SectionOpenerProps) {
  return (
    <header className={styles.opener} data-section-opener="true">
      <div className={styles.headingRow}>
        <h1
          className={styles.display}
          data-pane-return-heading="true"
          data-scale={scale}
          aria-busy={pending || undefined}
          tabIndex={-1}
        >
          {pending ? (
            <>
              <span className={styles.headingSkeleton} aria-hidden="true" />
              <span className="sr-only">{heading}</span>
            </>
          ) : (
            heading
          )}
        </h1>
        {actions ? <div className={styles.actions}>{actions}</div> : null}
      </div>
      {standfirst ? <p className={styles.standfirst}>{standfirst}</p> : null}
    </header>
  );
}
