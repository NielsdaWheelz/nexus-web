import type { ContributorCredit } from "@/lib/contributors/types";

function getContributorCreditLabel(credit: ContributorCredit): string | null {
  const creditedName = credit.credited_name?.trim();
  if (creditedName) {
    return creditedName;
  }
  const displayName =
    credit.contributor_display_name?.trim() || credit.display_name?.trim();
  return displayName || null;
}

export function formatContributorCreditSummary(
  credits: ContributorCredit[] | null | undefined,
  maxNames: number = Number.POSITIVE_INFINITY,
): string | null {
  if (!Array.isArray(credits)) {
    return null;
  }

  const seen = new Set<string>();
  const names: string[] = [];
  for (const credit of credits) {
    const handle = credit.contributor_handle?.trim();
    if (!handle) {
      continue;
    }
    const name = getContributorCreditLabel(credit);
    if (!name) {
      continue;
    }
    if (seen.has(handle)) {
      continue;
    }
    seen.add(handle);
    names.push(name);
  }

  if (names.length === 0) {
    return null;
  }

  const visibleCount =
    Number.isFinite(maxNames) && maxNames > 0
      ? Math.max(1, Math.floor(maxNames))
      : names.length;
  if (names.length <= visibleCount) {
    return names.join(", ");
  }
  return `${names.slice(0, visibleCount).join(", ")} +${names.length - visibleCount}`;
}

export function formatContributorRole(
  role: string | null | undefined,
): string | null {
  const trimmed = role?.trim();
  return trimmed ? trimmed.replace(/_/g, " ") : null;
}
