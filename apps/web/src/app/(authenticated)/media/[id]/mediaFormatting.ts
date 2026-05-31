import { formatContributorCreditSummary } from "@/lib/contributors/formatting";
import type { ContributorCredit } from "@/lib/contributors/types";

export interface Media {
  title: string;
  contributors: ContributorCredit[];
}

export function buildCompactMediaPaneTitle(
  media: Pick<Media, "title" | "contributors"> | null | undefined
): string | null {
  const title = media?.title?.trim();
  if (!title) {
    return null;
  }

  const authorSummary = formatContributorCreditSummary(media?.contributors, 1);
  if (!authorSummary) {
    return title;
  }

  const compactTitle = `${title} · ${authorSummary}`;
  return compactTitle.length <= 56 ? compactTitle : title;
}
