/**
 * Resource identity on the client: the `<scheme>:<uuid>` grammar (no code outside this
 * module splits a ref) and each scheme's icon and type label. The scheme vocabulary is
 * the server's, through the generated wire.
 */
import {
  AlignLeft,
  Disc3,
  File,
  FileText,
  Globe,
  Highlighter,
  Library,
  Link2,
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

export type ResourceScheme = Schema<"ResourceItemOut">["scheme"];

export interface ResourceRef {
  scheme: ResourceScheme;
  id: string;
}

// The runtime scheme set: every scheme, its icon and its type label.
const SCHEMES: Record<ResourceScheme, [LucideIcon, string]> = {
  media: [FileText, "Media"],
  library: [Library, "Library"],
  evidence_span: [TextQuote, "Passage"],
  content_chunk: [AlignLeft, "Passage"],
  highlight: [Highlighter, "Highlight"],
  page: [File, "Page"],
  note_block: [StickyNote, "Note"],
  fragment: [TextQuote, "Passage"],
  conversation: [MessagesSquare, "Chat"],
  message: [MessageSquare, "Chat message"],
  oracle_reading: [Sparkles, "Oracle reading"],
  oracle_passage_anchor: [TextQuote, "Oracle passage"],
  artifact: [Sparkles, "Generated item"],
  artifact_revision: [Sparkles, "Generated revision"],
  external_snapshot: [Globe, "Saved web page"],
  contributor: [User, "Author"],
  podcast: [Disc3, "Podcast"],
  reader_apparatus_item: [NotebookTabs, "Source reference"],
  passage_anchor: [TextQuote, "Passage"],
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

export function resourceIconForScheme(scheme: string): LucideIcon {
  return isScheme(scheme) ? SCHEMES[scheme][0] : Link2;
}

export function resourceTypeLabel(scheme: ResourceScheme): string {
  return SCHEMES[scheme][1];
}
