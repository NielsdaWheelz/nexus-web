"use client";

import Pill from "@/components/ui/Pill";
import { countText, importAttentionDescription } from "@/lib/imports/copy";
import styles from "./Imports.module.css";

/**
 * Account's passive Imports label and count. The hidden maximum-width pill
 * reserves menu geometry at zero or unknown; positive counts have one complete
 * accessible description, including a retained read failure and the exact count.
 */
export default function ImportsBadge({
  label,
  count,
  refresh_failed,
}: {
  readonly label: string;
  readonly count: number | null;
  readonly refresh_failed: boolean;
}) {
  const description = count !== null && count > 0
    ? importAttentionDescription(count, refresh_failed) : null;
  return (
    <>
      <span className={styles.badgeLabel} aria-hidden={description !== null}>{label}</span>
      <Pill tone="warning" size="sm" className={styles.attentionCount} data-visible={description !== null} aria-hidden="true">
        {count !== null && count > 0 ? countText(count) : "99+"}
      </Pill>
      {description !== null ? <span className="sr-only">{description}</span> : null}
    </>
  );
}
