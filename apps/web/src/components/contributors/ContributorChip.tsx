"use client";

import { isProdBuild } from "@/lib/build-mode";
import type { ContributorCredit, ContributorSummary } from "@/lib/contributors/types";
import { formatContributorRole } from "@/lib/contributors/formatting";
import { contributorAuthorHref } from "@/lib/contributors/routes";
import { cx } from "@/lib/ui/cx";
import styles from "./ContributorChip.module.css";

interface ContributorChipProps {
  credit?: ContributorCredit;
  contributor?: ContributorSummary;
  className?: string;
  showRole?: boolean;
}

export default function ContributorChip({
  credit,
  contributor,
  className,
  showRole = false,
}: ContributorChipProps) {
  const handle =
    credit?.contributor_handle?.trim() ||
    contributor?.contributor_handle?.trim() ||
    contributor?.handle?.trim() ||
    "";
  if (!handle) {
    if (!isProdBuild()) {
      throw new Error("ContributorChip requires a contributor handle");
    }
    return null;
  }

  const creditedName = credit?.credited_name?.trim();
  const displayName =
    credit?.contributor_display_name?.trim() ||
    contributor?.display_name?.trim() ||
    "";
  const label = creditedName || displayName;
  if (!label) {
    if (!isProdBuild()) {
      throw new Error("ContributorChip requires a contributor display label");
    }
    return null;
  }

  const roleLabel = showRole ? formatContributorRole(credit?.role) : null;
  const title =
    creditedName && displayName && creditedName !== displayName
      ? `${creditedName} (${displayName})`
      : label;
  const isUnlinkedCredit = Boolean(
    credit && !credit.id && credit.resolution_status === "unverified"
  );
  if (isUnlinkedCredit) {
    return (
      <span className={cx(styles.chip, className)} title={title}>
        <span className={styles.label}>{label}</span>
        {roleLabel ? <span className={styles.role}>{roleLabel}</span> : null}
      </span>
    );
  }

  const suppliedHref = credit?.href?.trim() || contributor?.href?.trim() || "";
  if (credit && !suppliedHref) {
    if (!isProdBuild()) {
      throw new Error("ContributorChip requires a contributor href");
    }
    return null;
  }
  const href = suppliedHref || contributorAuthorHref(handle);

  return (
    <a
      href={href}
      className={cx(styles.chip, className)}
      title={title}
      data-pane-title-hint={label}
    >
      <span className={styles.label}>{label}</span>
      {roleLabel ? <span className={styles.role}>{roleLabel}</span> : null}
    </a>
  );
}
