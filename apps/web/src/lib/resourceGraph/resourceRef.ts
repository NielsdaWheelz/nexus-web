/**
 * Resource identity on the client: the `<scheme>:<uuid>` grammar (no code outside this
 * module splits a ref) and each scheme's icon and type label. The scheme vocabulary is
 * the server's, through the generated wire.
 */
import {
  Disc3,
  File,
  FileText,
  Globe,
  Highlighter,
  Library,
  MessageSquare,
  MessagesSquare,
  NotebookTabs,
  Sparkles,
  StickyNote,
  TextQuote,
  User,
  type LucideIcon,
} from "lucide-react";
import type { Schema } from "@/lib/api/wire";
import { isCanonicalUuid } from "@/lib/validation";

export type ResourceScheme = Schema<"ResourceScheme">;

export interface ResourceRef {
  scheme: ResourceScheme;
  id: string;
}

// The runtime scheme set: every scheme, its icon and its type label.
const SCHEMES: Record<ResourceScheme, [LucideIcon, string]> = {
  media: [FileText, "source"],
  library: [Library, "library"],
  evidence_span: [TextQuote, "passage"],
  content_chunk: [TextQuote, "passage"],
  highlight: [Highlighter, "highlight"],
  page: [File, "page"],
  note_block: [StickyNote, "note"],
  fragment: [TextQuote, "passage"],
  conversation: [MessagesSquare, "chat"],
  message: [MessageSquare, "chat message"],
  oracle_reading: [Sparkles, "oracle reading"],
  oracle_passage_anchor: [TextQuote, "oracle passage"],
  external_snapshot: [Globe, "saved web page"],
  contributor: [User, "author"],
  podcast: [Disc3, "podcast"],
  reader_apparatus_item: [NotebookTabs, "source reference"],
  passage_anchor: [TextQuote, "passage"],
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

export function resourceIconForScheme(scheme: ResourceScheme): LucideIcon {
  return SCHEMES[scheme][0];
}

export function resourceTypeLabel(scheme: ResourceScheme): string {
  return SCHEMES[scheme][1];
}
