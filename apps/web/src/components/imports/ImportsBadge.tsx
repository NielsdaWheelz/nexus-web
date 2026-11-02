"use client";

import Pill from "@/components/ui/Pill";
import { countText, importAttentionDescription } from "@/lib/imports/copy";
import styles from "./Imports.module.css";

/**
 * Account's passive Imports label and count. The count stands only while something needs
 * attention, with one complete accessible description that speaks the exact count. A failed
 * refresh over a shown count says nothing. `refresh_failed` is read by nothing: optional so the
 * account menu can stop passing it, then deleted (L7).
 */
export default function ImportsBadge({
  label,
  count,
}: {
  readonly label: string;
  readonly count: number | null;
  readonly refresh_failed?: boolean;
}) {
  const attention = count !== null && count > 0 ? count : null;
  return (
    <>
      <span className={styles.badgeLabel} aria-hidden={attention !== null}>{label}</span>
      {attention === null ? null : <>
        <Pill tone="warning" size="sm" className={styles.attentionCount} aria-hidden="true">{countText(attention)}</Pill>
        <span className="sr-only">{importAttentionDescription(attention)}</span>
      </>}
    </>
  );
}
