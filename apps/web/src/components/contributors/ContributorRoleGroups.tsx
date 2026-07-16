"use client";

import { Fragment } from "react";
import type { ContributorCredit } from "@/lib/contributors/types";
import { contributorAuthorHref } from "@/lib/contributors/routes";
import { cx } from "@/lib/ui/cx";
import styles from "./ContributorRoleGroups.module.css";

/**
 * `ContributorRoleGroups` is the single presentation owner for the media and
 * podcast **detail** byline (content spec §1). It groups the effective credit
 * list under truthful, pluralized role eyebrows in a fixed vocabulary order
 * (Authors first) and renders ordered literal credited names as inline links to
 * `/authors/<handle>` (plain text when a credit has no handle — podcast preview
 * facts). Names use `dir="auto"`, wrap, and are never ellipsized.
 *
 * Podcast **discovery / browse / list cards** are a different surface (§5) and
 * keep `ContributorCreditList`; do not route cards through this component.
 */

// Canonical role order + singular/plural labels (content spec §0.2 / D-2). Any
// role outside this closed vocabulary — including a null role — buckets into
// `unknown` ("Contributor" / "Contributors").
const ROLE_ORDER = [
  "author",
  "editor",
  "translator",
  "host",
  "guest",
  "narrator",
  "creator",
  "producer",
  "publisher",
  "channel",
  "organization",
  "unknown",
] as const;

type RoleToken = (typeof ROLE_ORDER)[number];

const ROLE_LABELS: Record<RoleToken, readonly [string, string]> = {
  author: ["Author", "Authors"],
  editor: ["Editor", "Editors"],
  translator: ["Translator", "Translators"],
  host: ["Host", "Hosts"],
  guest: ["Guest", "Guests"],
  narrator: ["Narrator", "Narrators"],
  creator: ["Creator", "Creators"],
  producer: ["Producer", "Producers"],
  publisher: ["Publisher", "Publishers"],
  channel: ["Channel", "Channels"],
  organization: ["Organization", "Organizations"],
  unknown: ["Contributor", "Contributors"],
};

const KNOWN_ROLES = new Set<string>(ROLE_ORDER);

// The one place the pin is explained in plain language (content spec §1.4).
const PIN_TOOLTIP =
  "These authors were set by hand and won't be changed automatically.";

function roleBucket(role: string | null | undefined): RoleToken {
  const token = role?.trim();
  return token && KNOWN_ROLES.has(token) ? (token as RoleToken) : "unknown";
}

function creditLabel(credit: ContributorCredit): string {
  return (
    credit.credited_name?.trim() ||
    credit.contributor_display_name?.trim() ||
    ""
  );
}

function roleLabel(role: RoleToken, count: number): string {
  const [singular, plural] = ROLE_LABELS[role];
  return count === 1 ? singular : plural;
}

interface AuthorControls {
  canEditAuthors: boolean;
  authorMode: "automatic" | "manual";
  /** Present only when `canEditAuthors`; opens the media authors editor. */
  onEditAuthors?: () => void;
}

export interface ContributorRoleGroupsProps {
  credits: ContributorCredit[] | null | undefined;
  className?: string;
  /**
   * Media-detail author controls. Their presence marks this as a **media**
   * byline: the Authors group is always rendered (showing "No authors" when
   * empty, for editors and non-editors alike — AC 26), the pinned marker and
   * edit affordance become available. Omit for a **podcast** byline — read-only,
   * no forced empty-author slice, no edit affordance (AC 18).
   */
  media?: AuthorControls;
}

export default function ContributorRoleGroups({
  credits,
  className,
  media,
}: ContributorRoleGroupsProps) {
  const grouped = new Map<RoleToken, ContributorCredit[]>();
  for (const credit of Array.isArray(credits) ? credits : []) {
    if (!creditLabel(credit)) continue;
    const bucket = roleBucket(credit.role);
    const list = grouped.get(bucket);
    if (list) {
      list.push(credit);
    } else {
      grouped.set(bucket, [credit]);
    }
  }

  const groups = ROLE_ORDER.map((role) => {
    const roleCredits = grouped.get(role) ?? [];
    const isAuthors = role === "author";
    // Media always shows the Authors slice (empty → "No authors"). Every other
    // group — and the Authors group on a podcast byline — is omitted when empty.
    if (roleCredits.length === 0 && !(isAuthors && media)) {
      return null;
    }
    return { role, roleCredits, isAuthors };
  }).filter((group): group is NonNullable<typeof group> => group !== null);

  if (groups.length === 0) {
    return null;
  }

  return (
    <div className={cx(styles.root, className)}>
      {groups.map(({ role, roleCredits, isAuthors }) => {
        const showEdit =
          isAuthors &&
          media !== undefined &&
          media.canEditAuthors &&
          media.onEditAuthors !== undefined;
        const showPin =
          isAuthors &&
          media !== undefined &&
          media.authorMode === "manual" &&
          media.canEditAuthors;
        // An empty author slice reads under the plural "Authors" eyebrow
        // (content spec §1.3); `roleLabel` maps count 0 → plural.
        const count = roleCredits.length;

        return (
          <div key={role} className={styles.group}>
            <span className={styles.eyebrow}>{roleLabel(role, count)}</span>
            <div className={styles.names}>
              {roleCredits.length === 0 ? (
                <span className={styles.empty}>No authors</span>
              ) : (
                roleCredits.map((credit, index) => {
                  const label = creditLabel(credit);
                  const handle = credit.contributor_handle?.trim();
                  const href =
                    credit.href?.trim() ||
                    (handle ? contributorAuthorHref(handle) : "");
                  return (
                    <Fragment key={`${handle ?? "text"}-${role}-${index}`}>
                      {index > 0 ? ", " : null}
                      {href ? (
                        <a dir="auto" className={styles.name} href={href}>
                          {label}
                        </a>
                      ) : (
                        <span dir="auto" className={styles.nameText}>
                          {label}
                        </span>
                      )}
                    </Fragment>
                  );
                })
              )}
              {showPin || showEdit ? (
                <span className={styles.controls}>
                  {showPin ? (
                    <span className={styles.pinned} title={PIN_TOOLTIP}>
                      Authors edited manually
                    </span>
                  ) : null}
                  {showEdit ? (
                    <button
                      type="button"
                      className={styles.editButton}
                      onClick={media?.onEditAuthors}
                    >
                      {roleCredits.length > 0 ? "Edit authors" : "Add author"}
                    </button>
                  ) : null}
                </span>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
