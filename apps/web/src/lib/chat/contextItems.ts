"use client";
/** Local content overlays admitted context without changing membership or authority. */
import { excerptView } from "@nexus/authored/excerpt";
import { useAuthoredQuery } from "@/lib/notes/hooks";
import { authoredPreview } from "@/lib/notes/presentation";
import { localResourceHref } from "@/lib/resources/localResource";
import type { ResourceItem } from "@/lib/resources/items";

export function useContextItem(supplied: ResourceItem): {
  item: ResourceItem | null;
  authored: ReturnType<typeof useAuthoredQuery> | null;
  annotation: import("@nexus/authored/body").NoteBody | null;
} {
  const kind = supplied.ref.split(":", 1)[0];
  const ownedKind = kind === "note_block" ? "note" : kind === "page" ? "page" : kind === "highlight" ? "highlight" : null;
  const owned = supplied.authored_by_viewer && ownedKind !== null;
  const readingRef = supplied.preview.body.kind === "passage" ? supplied.preview.body.reading_ref : null;
  const authoredRead = useAuthoredQuery(owned ? ownedKind === "highlight" && readingRef !== null ? { kind: "excerpt", ref: supplied.ref, reading_ref: readingRef } : { kind: "resource", ref: supplied.ref } : null);
  const resource = authoredRead.data?.rows.find(row => row.resource.ref === supplied.ref && row.resource.kind === ownedKind && row.resource.visible && row.resource.authored_by_viewer)?.resource;
  if (!owned) return { item: supplied, authored: null, annotation: null };
  if (!resource) return { item: null, authored: authoredRead, annotation: null };
  const annotation = resource.kind === "highlight" && resource.body_pm_json !== null ? {body_pm_json: resource.body_pm_json, body_text: resource.body_text!} : null;
  const full = resource.excerpt;
  const compact = full?.kind === "content" ? excerptView({ ...full.body, source_extent: null,
    truncated_before: full.omitted_before, truncated_after: full.omitted_after }, "compact", { kind: "capture" }) : full;
  const excerpt = compact?.kind === "content" && full?.kind === "content" ? { ...compact,
    selected_truncated_before: compact.selected_truncated_before || full.selected_truncated_before,
    selected_truncated_after: compact.selected_truncated_after || full.selected_truncated_after } : compact;
  const preview = authoredPreview({ ...resource, excerpt }, readingRef);
  const source = supplied.preview.source;
  const href = localResourceHref(resource, { activationRef: readingRef });
  const activation: ResourceItem["activation"] = { resource_ref: resource.ref, field: null, kind: href === null ? "none" : "route", href, unavailable_reason: null };
  return { item: { ...supplied, label: preview.label, preview: { body: preview.body, source }, activation, missing: false }, authored: authoredRead, annotation };
}
