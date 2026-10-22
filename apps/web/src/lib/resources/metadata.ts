import type { Schema } from "@/lib/api/wire";
import { creditName, selectMediaAuthors, type ContributorCredit } from "@/lib/contributors/credits";
import { mediaKindLabel } from "@/lib/media/kind";
import { parseResourceRef, resourceTypeLabel } from "@/lib/resourceGraph/resourceRef";
import type { ResourceItem } from "./items";

type MatchMethod = Schema<"SearchOccurrenceOut">["match_method"];
export type ResourceMetadataPart =
  | { kind: "credits"; key: "contributors"; credits: readonly ContributorCredit[] }
  | { kind: "text"; key: string; text: string; href: string | null; date: string | null };

/** Ordered authors and original publication retain source precision. */
export function bibliographyMetadata(contributors: readonly ContributorCredit[], publicationDate: string | null): ResourceMetadataPart[] {
  const credits = contributors.filter((credit) => creditName(credit) !== null);
  const parts: ResourceMetadataPart[] = [];
  if (credits.length) parts.push({ kind: "credits", key: "contributors", credits });
  if (publicationDate) parts.push({ kind: "text", key: "publication", text: formatPublicationDate(publicationDate), href: null, date: publicationDate });
  return parts;
}

/** canonical identity and occurrence metadata share one factual projection. */
export function resourceMetadata({ item, matchMethod = null, occurrenceLabel, reason }: {
  item: ResourceItem;
  matchMethod?: MatchMethod | null;
  occurrenceLabel?: string;
  reason?: string | null;
}) {
  const body = item.preview.body;
  const source = item.preview.source;
  const parsed = parseResourceRef(item.ref);
  const mediaKind = body.kind === "media" ? body.media_summary.media_kind : source?.media_kind ?? (body.kind === "named" ? body.media_kind : null);
  const mediaLabel = mediaKind === null ? null : mediaKindLabel(mediaKind);
  const identity = parsed?.scheme === "media" && mediaLabel !== null ? mediaLabel : parsed ? resourceTypeLabel(parsed.scheme).toLowerCase() : "resource";
  const credits = body.kind === "media" ? body.media_summary.contributors : source?.contributors ?? (body.kind === "named" ? body.contributors : null) ?? [];
  const bibliography = bibliographyMetadata(
    mediaKind !== null ? selectMediaAuthors(credits) : credits,
    body.kind === "media" ? body.media_summary.original_published_date : null,
  );
  const parts: ResourceMetadataPart[] = [];
  if (occurrenceLabel?.trim()) parts.push({ kind: "text", key: "occurrence", text: occurrenceLabel, href: null, date: null });
  if (item.missing) parts.push({ kind: "text", key: "identity", text: identity, href: null, date: null });
  if (body.kind === "prose" && body.role?.trim()) parts.push({ kind: "text", key: "role", text: body.role, href: null, date: null });
  if (source && source.ref !== item.ref && (source.title?.trim() || source.activation?.href))
    parts.push({ kind: "text", key: "source", text: source.title?.trim() ? source.title : "source", href: source.activation?.href ?? null, date: null });
  if (source?.location_label?.trim()) parts.push({ kind: "text", key: "location", text: source.location_label, href: null, date: null });
  if (matchMethod === "semantic") parts.push({ kind: "text", key: "related_match", text: "related match", href: null, date: null });
  if (reason?.trim()) parts.push({ kind: "text", key: "reason", text: reason, href: null, date: null });
  return { identity, bibliography, parts };
}

export function resourceMetadataText(item: ResourceItem, matchMethod: MatchMethod | null = null): string {
  const metadata = resourceMetadata({ item, matchMethod });
  return [...metadata.bibliography, ...metadata.parts].map((part) => part.kind === "credits" ? part.credits.flatMap((credit) => creditName(credit)?.label ?? []).join(", ") : part.text).join(" · ");
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/;
const YEAR_MONTH = /^(\d{4})-(\d{2})$/;
const YEAR_ONLY = /^\d{4}$/;
const MONTH_YEAR_FORMAT = new Intl.DateTimeFormat("en-US", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});
const FULL_DATE_FORMAT = new Intl.DateTimeFormat("en-US", {
  month: "long",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

export function formatPublicationDate(value: string): string {
  if (YEAR_ONLY.test(value)) return value;

  const monthMatch = YEAR_MONTH.exec(value);
  if (monthMatch) {
    return MONTH_YEAR_FORMAT.format(new Date(`${value}-01T00:00:00Z`));
  }

  const dateMatch = DATE_ONLY.exec(value);
  if (dateMatch) {
    return FULL_DATE_FORMAT.format(
      new Date(`${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}T00:00:00Z`),
    );
  }
  throw new Error(`Invalid decoded PublicationDate: ${JSON.stringify(value)}`);
}
