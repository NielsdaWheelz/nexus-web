"use client";

// Credit lines for rows and headers. A credit with a person links to its
// author pane; a text fact (a podcast preview credit) is plain text. Names are
// inline text with dir="auto", never chips, and wrap rather than truncate.

import { Fragment } from "react";
import {
  creditName,
  groupContributorCredits,
  type ContributorCredit,
} from "@/lib/contributors/credits";
import { cx } from "@/lib/ui/cx";
import styles from "./ContributorCredits.module.css";

function Name({ credit }: { readonly credit: ContributorCredit }) {
  const name = creditName(credit);
  if (name === null) return null;
  const canonical = credit.contributor_display_name?.trim();
  const title =
    canonical && canonical !== name.label
      ? `${name.label} (${canonical})`
      : name.label;
  return name.href ? (
    <a
      href={name.href}
      className={styles.link}
      title={title}
      dir="auto"
      data-pane-label-hint={name.label}
    >
      {name.label}
    </a>
  ) : (
    <span className={styles.name} title={title} dir="auto">
      {name.label}
    </span>
  );
}

/** A dense comma-separated credit line with a compact "+N" overflow. */
export function ContributorCreditList({
  credits,
  className,
  maxVisible = 3,
  overflowNoun = "contributors",
}: {
  readonly credits: readonly ContributorCredit[] | null | undefined;
  readonly className?: string;
  readonly maxVisible?: number;
  readonly overflowNoun?: string;
}) {
  if (!credits?.length) return null;
  const visible = credits.slice(0, Math.max(1, Math.floor(maxVisible)));
  const overflow = credits.length - visible.length;
  return (
    <span className={cx(styles.list, className)}>
      {visible.map((credit, index) => (
        <Fragment
          key={`${credit.contributor_handle ?? credit.credited_name}-${credit.role}-${index}`}
        >
          {index > 0 ? ", " : null}
          <Name credit={credit} />
        </Fragment>
      ))}
      {overflow > 0 ? (
        <span className={styles.overflow}>
          <span aria-hidden="true">, +{overflow}</span>
          <span className="sr-only">
            , {overflow} more {overflowNoun}
          </span>
        </span>
      ) : null}
    </span>
  );
}

/** A wrapping byline grouped under role labels, authors first (podcast detail). */
export function ContributorRoleGroups({
  credits,
  className,
}: {
  readonly credits: readonly ContributorCredit[] | null | undefined;
  readonly className?: string;
}) {
  const groups = groupContributorCredits(credits ?? []);
  if (groups.length === 0) return null;
  return (
    <div className={cx(styles.groups, className)}>
      {groups.map((group) => (
        <div key={group.role}>
          <span className={styles.eyebrow}>{group.label}</span>
          <div className={styles.names}>
            {group.credits.map((credit, index) => (
              <Fragment key={`${credit.label}-${index}`}>
                {index > 0 ? ", " : null}
                {credit.href ? (
                  <a dir="auto" className={styles.link} href={credit.href}>
                    {credit.label}
                  </a>
                ) : (
                  <span dir="auto">{credit.label}</span>
                )}
              </Fragment>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
