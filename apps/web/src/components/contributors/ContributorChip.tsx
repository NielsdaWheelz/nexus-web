"use client";

import type { ContributorCredit } from "@/lib/contributors/types";
import { contributorAuthorHref } from "@/lib/contributors/routes";
import { cx } from "@/lib/ui/cx";
import styles from "./ContributorChip.module.css";

// A single credited name: a name with a handle is an
// inline link to author detail; a handle-less text fact (podcast preview) is plain
// inline text. Names are `dir="auto"` so RTL names read correctly. No border, no
// radius, no fill.

// `ContributorSummary` is a minimal shape kept only for the few call sites that pass
// a resolved contributor rather than a credit.
interface ContributorSummary {
  handle?: string | null;
  contributor_handle?: string | null;
  display_name?: string | null;
  href?: string | null;
}

interface ContributorChipProps {
  credit?: ContributorCredit;
  contributor?: ContributorSummary;
  className?: string;
}

export default function ContributorChip({
  credit,
  contributor,
  className,
}: ContributorChipProps) {
  const handle =
    credit?.contributor_handle?.trim() ||
    contributor?.contributor_handle?.trim() ||
    contributor?.handle?.trim() ||
    "";

  const creditedName = credit?.credited_name?.trim();
  const displayName =
    credit?.contributor_display_name?.trim() || contributor?.display_name?.trim() || "";
  const label = creditedName || displayName;
  if (!label) {
    return null;
  }

  const title =
    creditedName && displayName && creditedName !== displayName
      ? `${creditedName} (${displayName})`
      : label;

  const nameNode = (
    <span className={styles.label} dir="auto">
      {label}
    </span>
  );
  if (!handle) {
    return (
      <span className={cx(styles.name, className)} title={title}>
        {nameNode}
      </span>
    );
  }

  const href = credit?.href?.trim() || contributor?.href?.trim() || contributorAuthorHref(handle);
  return (
    <a
      href={href}
      className={cx(styles.link, className)}
      title={title}
      data-pane-label-hint={label}
    >
      {nameNode}
    </a>
  );
}
