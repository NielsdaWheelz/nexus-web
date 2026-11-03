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
  media: [Icon.Page, "source"],
  library: [Icon.Library, "library"],
  evidence_span: [Icon.Passage, "passage"],
  content_chunk: [Icon.Passage, "passage"],
  highlight: [Icon.Highlight, "highlight"],
  page: [Icon.Page, "page"],
  note_block: [Icon.Note, "note"],
  fragment: [Icon.Passage, "passage"],
  conversation: [Icon.Chat, "chat"],
  message: [Icon.Chat, "chat message"],
  oracle_reading: [Icon.Oracle, "oracle reading"],
  oracle_passage_anchor: [Icon.Passage, "oracle passage"],
  external_snapshot: [Icon.Web, "saved web page"],
  contributor: [Icon.Author, "author"],
  podcast: [Icon.Podcast, "podcast"],
  reader_apparatus_item: [Icon.SourceReference, "source reference"],
  passage_anchor: [Icon.Passage, "passage"],
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

/** These domains can have local authored content. This says nothing about viewer ownership. */
export const hasAuthoredContent = (ref: string): boolean => /^(note_block|page|highlight|passage_anchor):/u.test(ref);

export function formatResourceRef(ref: ResourceRef): string {
  return `${ref.scheme}:${ref.id}`;
}

export function resourceIconForScheme(scheme: ResourceScheme): Icon.Glyph {
  return SCHEMES[scheme][0];
}

export function resourceTypeLabel(scheme: ResourceScheme): string {
  return SCHEMES[scheme][1];
}
