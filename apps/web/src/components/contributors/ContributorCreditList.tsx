"use client";

import ContributorChip from "@/components/contributors/ContributorChip";
import type { ContributorCredit } from "@/lib/contributors/types";
import { cx } from "@/lib/ui/cx";
import styles from "./ContributorCreditList.module.css";

interface ContributorCreditListProps {
  credits: ContributorCredit[] | null | undefined;
  className?: string;
  maxVisible?: number;
  showRole?: boolean;
}

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
    <span className={cx(styles.list, className)}>
      {visibleCredits.map((credit, index) => (
        <ContributorChip
          key={`${credit.contributor_handle}-${credit.role ?? "role"}-${index}`}
          credit={credit}
          showRole={showRole}
        />
      ))}
      {overflowCount > 0 ? <span className={styles.overflow}>+{overflowCount}</span> : null}
    </span>
  );
}
