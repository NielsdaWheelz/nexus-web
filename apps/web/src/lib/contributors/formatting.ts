import type { ContributorCredit } from "@/lib/contributors/types";
import { isPositiveFinite } from "@/lib/validation";

function getContributorCreditLabel(credit: ContributorCredit): string | null {
  const creditedName = credit.credited_name?.trim();
  if (creditedName) {
    return creditedName;
  }
  return credit.contributor_display_name?.trim() || null;
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
    const name = getContributorCreditLabel(credit);
    if (!name) {
      continue;
    }
    // Dedupe by handle when present; handle-less text-fact credits (podcast
    // previews) dedupe by their credited label so they still count.
    const key = credit.contributor_handle?.trim() || name;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    names.push(name);
  }

  if (names.length === 0) {
    return null;
  }

  const visibleCount = isPositiveFinite(maxNames)
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
