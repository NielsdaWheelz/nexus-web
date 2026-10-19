import type { Schema } from "@/lib/api/wire";
import { creditName } from "@/lib/contributors/credits";
import { parseResourceRef, resourceTypeLabel } from "@/lib/resourceGraph/resourceRef";
import type { ResourceItem } from "./items";

type MatchMethod = Schema<"SearchOccurrenceOut">["match_method"];

/** Factual provenance shared by visible rows and their accessible labels. */
export function resourceMetadataParts(item: ResourceItem, matchMethod: MatchMethod | null) {
  const body = item.preview.body;
  const source = item.preview.source;
  const parsed = parseResourceRef(item.ref);
  const type = parsed ? resourceTypeLabel(parsed.scheme).toLowerCase() : "resource";
  const mediaKind = source?.media_kind ?? (body.kind === "named" ? body.media_kind : null);
  const names = (source?.contributors ?? (body.kind === "named" ? body.contributors : null) ?? [])
    .flatMap((credit) => creditName(credit)?.label ?? []);
  const parts: { text: string; href: string | null }[] = [
    { text: `${type}${body.kind === "prose" && body.role ? ` · ${body.role}` : ""}${mediaKind && mediaKind !== type ? ` · ${mediaKind.replaceAll("_", " ")}` : ""}`, href: null },
  ];
  if (source && (source.title || source.activation?.href) && !(body.kind === "named" && source.ref === item.ref && source.title === body.title))
    parts.push({ text: source.title ?? "source", href: source.activation?.href ?? null });
  if (names.length) parts.push({ text: `${names.slice(0, 2).join(", ")}${names.length > 2 ? ` and ${names.length - 2} others` : ""}`, href: null });
  if (source?.location_label) parts.push({ text: source.location_label, href: null });
  if (matchMethod === "semantic") parts.push({ text: "related match", href: null });
  return parts;
}

export function resourceMetadataText(item: ResourceItem, matchMethod: MatchMethod | null = null): string {
  return resourceMetadataParts(item, matchMethod).map((part) => part.text).join(" · ");
}
