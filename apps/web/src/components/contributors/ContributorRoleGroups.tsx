"use client";

import { Fragment } from "react";
import type { ContributorCredit } from "@/lib/contributors/types";
import { groupContributorCredits } from "@/lib/contributors/formatting";
import { cx } from "@/lib/ui/cx";
import styles from "./ContributorRoleGroups.module.css";

/**
 * `ContributorRoleGroups` presents the wrapping podcast-detail credit list.
 * Shared grouping lives in `groupContributorCredits`, which also feeds resource
 * headers. This component groups the effective credit list under truthful,
 * pluralized role eyebrows in a fixed vocabulary order (Authors first) and
 * renders ordered literal credited names as inline links to `/authors/<handle>`
 * (plain text when a credit has no handle — podcast preview facts). Names use
 * `dir="auto"`, wrap, and are never ellipsized.
 *
 * Podcast **discovery / browse / list cards** are a different surface (§5) and
 * keep `ContributorCreditList`; do not route cards through this component.
 */

interface ContributorRoleGroupsProps {
  credits: ContributorCredit[] | null | undefined;
  className?: string;
}

export default function ContributorRoleGroups({
  credits,
  className,
}: ContributorRoleGroupsProps) {
  const groups = groupContributorCredits(credits);

  if (groups.length === 0) {
    return null;
  }

  return (
    <div className={cx(styles.root, className)}>
      {groups.map(({ role, label, credits: roleCredits }) => (
        <div key={role} className={styles.group}>
          <span className={styles.eyebrow}>{label}</span>
          <div className={styles.names}>
            {roleCredits.map((credit, index) => (
              <Fragment key={`${credit.href ?? "text"}-${role}-${index}`}>
                {index > 0 ? ", " : null}
                {credit.href ? (
                  <a dir="auto" className={styles.name} href={credit.href}>
                    {credit.label}
                  </a>
                ) : (
                  <span dir="auto" className={styles.nameText}>
                    {credit.label}
                  </span>
                )}
              </Fragment>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
