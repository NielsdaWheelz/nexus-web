"use client";

import type { CSSProperties } from "react";
import ContributorChip from "@/components/contributors/ContributorChip";
import type { ContributorCredit } from "@/lib/contributors/types";
import { cx } from "@/lib/ui/cx";

interface ContributorCreditListProps {
  credits: ContributorCredit[] | null | undefined;
  className?: string;
  maxVisible?: number;
  showRole?: boolean;
}

const listStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  flexWrap: "wrap",
  gap: "var(--space-1)",
  minWidth: 0,
};

const overflowStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  border: "1px solid var(--edge-subtle)",
  borderRadius: "var(--radius-full)",
  padding: "2px var(--space-2)",
  background: "var(--surface-2)",
  color: "var(--ink-muted)",
  fontSize: "var(--text-xs)",
  lineHeight: "var(--leading-snug)",
  whiteSpace: "nowrap",
};

export default function ContributorCreditList({
  credits,
  className,
  maxVisible = 3,
  showRole = false,
}: ContributorCreditListProps) {
  if (!Array.isArray(credits) || credits.length === 0) {
    return null;
  }

  const linkableCredits = credits.filter((credit) => credit.contributor_handle?.trim());
  if (linkableCredits.length === 0) {
    return null;
  }

  const visibleCount = Math.max(1, Math.floor(maxVisible));
  const visibleCredits = linkableCredits.slice(0, visibleCount);
  const overflowCount = linkableCredits.length - visibleCredits.length;

  return (
    <span className={cx(className)} style={listStyle}>
      {visibleCredits.map((credit, index) => (
        <ContributorChip
          key={`${credit.contributor_handle}-${credit.role ?? "role"}-${index}`}
          credit={credit}
          showRole={showRole}
        />
      ))}
      {overflowCount > 0 ? <span style={overflowStyle}>+{overflowCount}</span> : null}
    </span>
  );
}
