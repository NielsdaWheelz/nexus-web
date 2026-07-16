import { formatContributorCreditSummary } from "@/lib/contributors/formatting";
import { tryParseContributorHandle } from "@/lib/contributors/handle";
import { contributorAuthorHref } from "@/lib/contributors/routes";
import type { ContributorCredit, MediaAuthorCredit } from "@/lib/contributors/types";

export interface Media {
  title: string;
  contributors: ContributorCredit[];
}

/**
 * Maps a media DTO's author-role credits into the editor's camel `MediaAuthorCredit`
 * rows. Every handle is parsed at this boundary (D-45) rather than force-cast: a
 * media author credit is always a resolved identity, so a handle-less (or
 * non-canonical) author-role credit is an anomaly we skip — seeding it as an
 * empty-handle brand would produce a row that 422s the whole save (F5).
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

export function buildCompactMediaPaneTitle(
  media: Pick<Media, "title" | "contributors"> | null | undefined
): string | null {
  const title = media?.title?.trim();
  if (!title) {
    return null;
  }

  // The compact pane title carries the author byline only — never a translator,
  // host, or other role that happens to be the first credit (D-23).
  const authorCredits = (media?.contributors ?? []).filter(
    (credit) => credit.role === "author",
  );
  const authorSummary = formatContributorCreditSummary(authorCredits, 1);
  if (!authorSummary) {
    return title;
  }

  const compactTitle = `${title} · ${authorSummary}`;
  return compactTitle.length <= 56 ? compactTitle : title;
}
