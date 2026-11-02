/**
 * Resource identity on the client: the `<scheme>:<uuid>` grammar (no code outside this
 * module splits a ref) and each scheme's icon and type label. The scheme vocabulary is
 * the server's, through the generated wire.
 */
import * as Icon from "@/lib/ui/icons";
import type { Schema } from "@/lib/api/wire";
import { isCanonicalUuid } from "@/lib/validation";

export type ResourceScheme = Schema<"ResourceScheme">;

export interface ResourceRef {
  scheme: ResourceScheme;
  id: string;
}

// The runtime scheme set: every scheme, its icon and its type label.
const SCHEMES: Record<ResourceScheme, [Icon.Glyph, string]> = {
  media: [Icon.Page, "Media"],
  library: [Icon.Library, "Library"],
  evidence_span: [Icon.Passage, "Passage"],
  content_chunk: [Icon.Passage, "Passage"],
  highlight: [Icon.Highlight, "Highlight"],
  page: [Icon.Page, "Page"],
  note_block: [Icon.Note, "Note"],
  fragment: [Icon.Passage, "Passage"],
  conversation: [Icon.Chat, "Chat"],
  message: [Icon.Chat, "Chat message"],
  oracle_reading: [Icon.Oracle, "Oracle reading"],
  oracle_passage_anchor: [Icon.Passage, "Oracle passage"],
  external_snapshot: [Icon.Web, "Saved web page"],
  contributor: [Icon.Author, "Author"],
  podcast: [Icon.Podcast, "Podcast"],
  reader_apparatus_item: [Icon.SourceReference, "Source reference"],
  passage_anchor: [Icon.Passage, "Passage"],
};

function isScheme(scheme: string): scheme is ResourceScheme {
  return Object.hasOwn(SCHEMES, scheme);
}

/** A ref, or `null` on any grammar violation (never throws). */
export function parseResourceRef(raw: string): ResourceRef | null {
  const sep = raw.indexOf(":");
  const scheme = raw.slice(0, sep);
  const id = raw.slice(sep + 1);
  return sep > 0 && isScheme(scheme) && isCanonicalUuid(id)
    ? { scheme, id }
    : null;
}

export function formatResourceRef(ref: ResourceRef): string {
  return `${ref.scheme}:${ref.id}`;
}

export function resourceIconForScheme(scheme: ResourceScheme): Icon.Glyph {
  return SCHEMES[scheme][0];
}

export function resourceTypeLabel(scheme: ResourceScheme): string {
  return SCHEMES[scheme][1];
}
