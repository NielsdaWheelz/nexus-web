import type { ContributorCredit } from "@/lib/contributors/types";
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

export function formatContributorRole(
  role: string | null | undefined,
): string | null {
  const trimmed = role?.trim();
  return trimmed ? trimmed.replace(/_/g, " ") : null;
}
