"use client";

import { Fragment } from "react";
import ContributorChip from "@/components/contributors/ContributorChip";
import type { ContributorCredit } from "@/lib/contributors/types";
import { cx } from "@/lib/ui/cx";
import styles from "./ContributorCreditList.module.css";

interface ContributorCreditListProps {
  credits: readonly ContributorCredit[] | null | undefined;
  className?: string;
  maxVisible?: number;
  showRole?: boolean;
}

// Dense collection/discovery credit line (Surface 5). Renders every credit as an
// inline, comma-separated `dir="auto"` name run — handle-less text facts included
// (D-9: dropping the old handle-less filter here is what keeps podcast browse/
// discovery author lines from vanishing once previews became text facts). The whole
// line may clamp at the slot level; overflow shows the compact `+N` grammar.
export default function ContributorCreditList({
  credits,
  className,
  maxVisible = 3,
  showRole = false,
}: ContributorCreditListProps) {
  if (!Array.isArray(credits) || credits.length === 0) {
    return null;
  }

  const visibleCount = Math.max(1, Math.floor(maxVisible));
  const visibleCredits = credits.slice(0, visibleCount);
  const overflowCount = credits.length - visibleCredits.length;

  return (
    <span className={cx(styles.list, className)}>
      {visibleCredits.map((credit, index) => (
        <Fragment
          key={`${credit.contributor_handle ?? credit.credited_name}-${credit.role ?? "role"}-${index}`}
        >
          {index > 0 ? <span className={styles.separator}>, </span> : null}
          <ContributorChip credit={credit} showRole={showRole} />
        </Fragment>
      ))}
      {overflowCount > 0 ? <span className={styles.overflow}>, +{overflowCount}</span> : null}
    </span>
  );
}
