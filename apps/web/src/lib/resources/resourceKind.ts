/**
 * Display mapping for resource refs: scheme → icon and scheme → object-ref
 * type. Parsing/formatting and the scheme vocabulary are owned by
 * `@/lib/resourceGraph/resourceRef` (AC17) — this module never splits a ref.
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
  Sparkles,
  StickyNote,
  Tag,
  TextQuote,
  User,
  type LucideIcon,
} from "lucide-react";
import type { ObjectType } from "@/lib/objectRefs";
import {
  isResourceScheme,
  parseResourceRef,
  type ResourceScheme,
} from "@/lib/resourceGraph/resourceRef";

const RESOURCE_SCHEME_ICONS = {
  media: FileText,
  library: Library,
  evidence_span: TextQuote,
  content_chunk: AlignLeft,
  highlight: Highlighter,
  page: File,
  note_block: StickyNote,
  fragment: TextQuote,
  conversation: MessagesSquare,
  message: MessageSquare,
  oracle_reading: Sparkles,
  oracle_corpus_passage: TextQuote,
  library_intelligence_artifact: Sparkles,
  library_intelligence_revision: Sparkles,
  external_snapshot: Globe,
  contributor: User,
  podcast: Disc3,
  tag: Tag,
} satisfies Record<ResourceScheme, LucideIcon>;

// Schemes that map to an openable object-ref type (`objectRefs.ts`). Schemes
// without an entry (library, oracle_*, external_snapshot) are not object-ref-resolvable.
const RESOURCE_SCHEME_OBJECT_TYPES: Partial<Record<ResourceScheme, ObjectType>> = {
  media: "media",
  evidence_span: "evidence_span",
  content_chunk: "content_chunk",
  highlight: "highlight",
  page: "page",
  note_block: "note_block",
  fragment: "fragment",
  conversation: "conversation",
  message: "message",
  library_intelligence_artifact: "library_intelligence_artifact",
  library_intelligence_revision: "library_intelligence_revision",
  contributor: "contributor",
  podcast: "podcast",
  tag: "tag",
};

export function resourceObjectTypeForScheme(scheme: ResourceScheme): ObjectType | null {
  return RESOURCE_SCHEME_OBJECT_TYPES[scheme] ?? null;
}

export function resourceIconForUri(resourceRef: string): LucideIcon {
  const parsed = parseResourceRef(resourceRef);
  return parsed ? RESOURCE_SCHEME_ICONS[parsed.scheme] : Link2;
}

export function resourceIconForScheme(scheme: string): LucideIcon {
  return isResourceScheme(scheme) ? RESOURCE_SCHEME_ICONS[scheme] : Link2;
}
