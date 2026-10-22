import type { Schema } from "@/lib/api/wire";
import { collectionConsumptionText, collectionActivityText, collectionPublicationYear } from "@/components/collections/collectionRowFormatting";
import { creditName, selectMediaAuthors } from "@/lib/contributors/credits";
import { mediaKindLabel } from "@/lib/media/kind";
import { parseResourceRef, resourceTypeLabel } from "@/lib/resourceGraph/resourceRef";
import type { ResourceItem } from "./items";

type MatchMethod = Schema<"SearchOccurrenceOut">["match_method"];
export type ResourcePresentation = "inline_note" | "quoted_passage";
export type ResourceMetadataPart = { key: string; text: string; href: string | null };

/** canonical identity and occurrence metadata share one factual projection. */
export function resourceMetadata({ item, matchMethod = null, presentation, occurrenceLabel, reason }: {
  item: ResourceItem;
  matchMethod?: MatchMethod | null;
  presentation?: ResourcePresentation;
  occurrenceLabel?: string;
  reason?: string | null;
}) {
  const body = item.preview.body;
  const source = item.preview.source;
  const parsed = parseResourceRef(item.ref);
  const mediaKind = source?.media_kind ?? (body.kind === "media" ? body.media_summary.media_kind : body.kind === "named" ? body.media_kind : null);
  const mediaLabel = mediaKind === null ? null : mediaKindLabel(mediaKind);
  const identity = parsed?.scheme === "media" && mediaLabel !== null ? mediaLabel : parsed ? resourceTypeLabel(parsed.scheme).toLowerCase() : "resource";
  const omitIdentity = !item.missing && (
    (presentation === "inline_note" && parsed?.scheme === "note_block") ||
    (presentation === "quoted_passage" && body.kind === "passage" && (parsed?.scheme === "evidence_span" || parsed?.scheme === "content_chunk" || parsed?.scheme === "fragment" || parsed?.scheme === "passage_anchor"))
  );
  const names = (body.kind === "media" ? selectMediaAuthors(body.media_summary.contributors) : source?.contributors ?? (body.kind === "named" ? body.contributors : null) ?? [])
    .flatMap((credit) => creditName(credit)?.label ?? []);
  const parts: ResourceMetadataPart[] = [];
  if (occurrenceLabel?.trim()) parts.push({ key: "occurrence", text: occurrenceLabel, href: null });
  if (!omitIdentity) parts.push({ key: "identity", text: identity, href: null });
  if (body.kind === "prose" && body.role?.trim()) parts.push({ key: "role", text: body.role, href: null });
  if (mediaLabel !== null && parsed?.scheme !== "media") parts.push({ key: "media_kind", text: mediaLabel, href: null });
  if (source && (source.title?.trim() || source.activation?.href) && !(source.ref === item.ref && (body.kind === "named" && source.title === body.title || body.kind === "media" && source.title === body.media_summary.title)))
    parts.push({ key: "source", text: source.title?.trim() ? source.title : "source", href: source.activation?.href ?? null });
  if (names.length) parts.push({ key: "contributors", text: `${names.slice(0, 2).join(", ")}${names.length > 2 ? ` and ${names.length - 2} others` : ""}`, href: null });
  if (body.kind === "media") {
    const summary = body.media_summary;
    if (summary.original_published_date !== null) parts.push({key:"publication",text:collectionPublicationYear(summary.original_published_date),href:null});
    parts.push({key:"consumption",text:collectionConsumptionText(summary.consumption),href:null});
    const minutes = summary.duration?.estimate.remaining_minutes;
    if (summary.consumption.state !== "Finished" && summary.duration !== null && minutes != null) parts.push({key:"duration",text:collectionActivityText({kind:"RemainingTime",modality:summary.duration.modality,minutes}).accessible,href:null});
  }
  if (source?.location_label?.trim()) parts.push({ key: "location", text: source.location_label, href: null });
  if (matchMethod === "semantic") parts.push({ key: "related_match", text: "related match", href: null });
  if (reason?.trim()) parts.push({ key: "reason", text: reason, href: null });
  return { identity, parts };
}

export function resourceMetadataText(item: ResourceItem, matchMethod: MatchMethod | null = null): string {
  return resourceMetadata({ item, matchMethod }).parts.map((part) => part.text).join(" · ");
}
