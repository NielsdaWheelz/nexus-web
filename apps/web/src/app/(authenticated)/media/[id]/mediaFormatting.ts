import { groupContributorCredits } from "@/lib/contributors/formatting";
import { tryParseContributorHandle } from "@/lib/contributors/handle";
import { contributorAuthorHref } from "@/lib/contributors/routes";
import type { ContributorCredit, MediaAuthorCredit } from "@/lib/contributors/types";
import type { PaneResourceHeaderPublication } from "@/lib/panes/paneHeaderModel";
import { isApiError } from "@/lib/api/client";

export interface Media {
  title: string;
  contributors: ContributorCredit[];
}

type CanonicalMediaRefetchFailure = "unavailable" | "retain-ready";

export function classifyCanonicalMediaRefetchFailure(
  error: unknown,
): CanonicalMediaRefetchFailure {
  if (!isApiError(error)) return "retain-ready";
  if (error.code === "E_MEDIA_NOT_READY") return "retain-ready";
  return error.status === 404 || error.code === "E_MEDIA_NOT_FOUND"
    ? "unavailable"
    : "retain-ready";
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

export function buildMediaResourceHeader(
  media: Pick<Media, "title" | "contributors">,
): PaneResourceHeaderPublication {
  return {
    status: "ready",
    title: media.title,
    creditGroups: groupContributorCredits(media.contributors).map((group) =>
      group.role === "author"
        ? { kind: "authors", credits: group.credits }
        : {
            kind: "role",
            label: group.label,
            credits: group.credits,
          },
    ),
  };
}
