import type { ContributorCredit, MediaAuthorCredit } from "@/lib/contributors/types";
import { tryParseContributorHandle } from "@/lib/contributors/handle";
import { contributorAuthorHref } from "@/lib/contributors/routes";
import {
  CONTRIBUTOR_ROLE_ORDER,
  contributorRoleLabel,
  normalizeContributorRoleToken,
  type ContributorRoleToken,
} from "@/lib/contributors/vocab";

interface ContributorDisplayCredit {
  readonly label: string;
  readonly href?: string;
}

interface ContributorDisplayGroup {
  readonly role: ContributorRoleToken;
  readonly label: string;
  readonly credits: readonly ContributorDisplayCredit[];
}

/** Preserve the canonical credit order; other roles never stand in for authors. */
export function selectMediaAuthors(
  credits: readonly ContributorCredit[],
): readonly ContributorCredit[] {
  return credits.filter((credit) => credit.role === "author");
}

export function groupContributorCredits(
  credits: readonly ContributorCredit[] | null | undefined,
): readonly ContributorDisplayGroup[] {
  const grouped = new Map<ContributorRoleToken, ContributorDisplayCredit[]>();
  for (const credit of credits ?? []) {
    const label = getContributorCreditLabel(credit);
    if (!label) continue;
    const handle = credit.contributor_handle?.trim();
    const explicitHref = credit.href?.trim();
    const displayCredit: ContributorDisplayCredit = {
      label,
      ...(explicitHref
        ? { href: explicitHref }
        : handle
          ? { href: contributorAuthorHref(handle) }
          : {}),
    };
    const role = normalizeContributorRoleToken(credit.role);
    const existing = grouped.get(role);
    if (existing) existing.push(displayCredit);
    else grouped.set(role, [displayCredit]);
  }

  return CONTRIBUTOR_ROLE_ORDER.flatMap((role) => {
    const roleCredits = grouped.get(role);
    if (!roleCredits?.length) return [];
    return [
      {
        role,
        label: contributorRoleLabel(role, roleCredits.length),
        credits: roleCredits,
      },
    ];
  });
}

function getContributorCreditLabel(credit: ContributorCredit): string | null {
  const creditedName = credit.credited_name?.trim();
  if (creditedName) {
    return creditedName;
  }
  return credit.contributor_display_name?.trim() || null;
}

/**
 * A media's author-role credits as the authors editor's rows. A credit without a
 * canonical handle is an anomaly and is skipped: seeding it would 422 the save.
 */
export function mapMediaAuthorCredits(
  contributors: readonly ContributorCredit[] | null | undefined,
): MediaAuthorCredit[] {
  const rows: MediaAuthorCredit[] = [];
  for (const credit of contributors ?? []) {
    if (credit.role !== "author") continue;
    const handle = tryParseContributorHandle(credit.contributor_handle ?? "");
    if (!handle) continue;
    rows.push({
      contributorHandle: handle,
      href: credit.href ?? contributorAuthorHref(handle),
      displayName: credit.contributor_display_name ?? credit.credited_name,
      creditedName: credit.credited_name,
    });
  }
  return rows;
}
