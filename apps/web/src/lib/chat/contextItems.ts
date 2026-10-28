"use client";
/** Local content overlays admitted context without changing membership or authority. */
import { useAuthoredQuery } from "@/lib/notes/hooks";
import { authoredPreview } from "@/lib/notes/presentation";
import { localResourceHref } from "@/lib/resources/localResource";
import type { ResourceItem } from "@/lib/resources/items";

export function useContextItem(supplied: ResourceItem): {
  item: ResourceItem | null;
  authored: ReturnType<typeof useAuthoredQuery> | null;
  annotations: ReturnType<typeof useAuthoredQuery> | null;
} {
  const kind = supplied.ref.split(":", 1)[0];
  const ownedKind = kind === "note_block" ? "note" : kind === "page" ? "page" : kind === "highlight" ? "highlight" : null;
  const owned = supplied.authored_by_viewer && ownedKind !== null;
  const authoredRead = useAuthoredQuery(owned ? { kind: "resource", ref: supplied.ref } : null);
  const resource = authoredRead.data?.rows.find(row => row.resource.ref === supplied.ref && row.resource.kind === ownedKind && row.resource.visible && row.resource.authored_by_viewer)?.resource;
  const eligible = kind === "highlight" && (owned ? resource !== undefined : !supplied.missing && supplied.preview.body.kind === "passage");
  const annotationRead = useAuthoredQuery(eligible ? { kind: "highlight_notes", ref: supplied.ref } : null);
  if (!owned) return { item: supplied, authored: null, annotations: eligible ? annotationRead : null };
  if (!resource) return { item: null, authored: authoredRead, annotations: null };
  const preview = authoredPreview(resource);
  const source = resource.kind === "highlight" && supplied.preview.source ? { ...supplied.preview.source, location_label: null } : supplied.preview.source;
  const href = resource.kind === "highlight" ? null : localResourceHref(resource);
  const activation: ResourceItem["activation"] = resource.kind === "highlight" ? supplied.activation : { resource_ref: resource.ref, kind: href === null ? "none" : "route", href, unavailable_reason: null };
  return { item: { ...supplied, label: preview.label, preview: { body: preview.body, source }, activation, missing: false }, authored: authoredRead, annotations: eligible ? annotationRead : null };
}
