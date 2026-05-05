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
  gap: "0.35rem",
  minWidth: 0,
};

const overflowStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  border: "1px solid var(--color-border)",
  borderRadius: "999px",
  padding: "2px 8px",
  background: "var(--color-bg-secondary)",
  color: "var(--color-text-muted)",
  fontSize: "var(--font-size-xs)",
  lineHeight: 1.4,
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
