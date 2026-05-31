"use client";

import type { CSSProperties } from "react";
import type { ContributorCredit, ContributorSummary } from "@/lib/contributors/types";
import { formatContributorRole } from "@/lib/contributors/formatting";
import { contributorAuthorHref } from "@/lib/contributors/routes";
import { cx } from "@/lib/ui/cx";

interface ContributorChipProps {
  credit?: ContributorCredit;
  contributor?: ContributorSummary;
  className?: string;
  showRole?: boolean;
}

const chipStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "var(--space-1)",
  maxWidth: "100%",
  border: "1px solid var(--edge-subtle)",
  borderRadius: "var(--radius-full)",
  padding: "2px var(--space-2)",
  background: "var(--surface-2)",
  color: "var(--ink)",
  fontSize: "var(--text-xs)",
  lineHeight: "var(--leading-snug)",
  textDecoration: "none",
  whiteSpace: "nowrap",
};

const roleStyle: CSSProperties = {
  color: "var(--ink-muted)",
};

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
    if (process.env.NODE_ENV !== "production") {
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
    if (process.env.NODE_ENV !== "production") {
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
      <span className={cx(className)} style={chipStyle} title={title}>
        <span>{label}</span>
        {roleLabel ? <span style={roleStyle}>{roleLabel}</span> : null}
      </span>
    );
  }

  const suppliedHref = credit?.href?.trim() || contributor?.href?.trim() || "";
  if (credit && !suppliedHref) {
    if (process.env.NODE_ENV !== "production") {
      throw new Error("ContributorChip requires a contributor href");
    }
    return null;
  }
  const href = suppliedHref || contributorAuthorHref(handle);

  return (
    <a
      href={href}
      className={cx(className)}
      style={chipStyle}
      title={title}
      data-pane-title-hint={label}
    >
      <span>{label}</span>
      {roleLabel ? <span style={roleStyle}>{roleLabel}</span> : null}
    </a>
  );
}
