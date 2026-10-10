/**
 * Display mapping for resource refs: scheme -> icon. Parsing/formatting and
 * the scheme vocabulary are owned by
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
  NotebookTabs,
  Sparkles,
  StickyNote,
  TextQuote,
  User,
  type LucideIcon,
} from "lucide-react";
import {
  isResourceScheme,
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
  oracle_passage_anchor: TextQuote,
  artifact: Sparkles,
  artifact_revision: Sparkles,
  external_snapshot: Globe,
  contributor: User,
  podcast: Disc3,
  reader_apparatus_item: NotebookTabs,
  passage_anchor: TextQuote,
} satisfies Record<ResourceScheme, LucideIcon>;

export function resourceIconForScheme(scheme: string): LucideIcon {
  return isResourceScheme(scheme) ? RESOURCE_SCHEME_ICONS[scheme] : Link2;
}

export function resourceTypeLabel(scheme: ResourceScheme): string {
  const labels: Record<ResourceScheme, string> = {
    media: "Media", library: "Library", evidence_span: "Passage",
    content_chunk: "Passage", highlight: "Highlight", page: "Page",
    note_block: "Note", fragment: "Passage", conversation: "Chat",
    message: "Chat message", oracle_reading: "Oracle reading",
    oracle_passage_anchor: "Oracle passage", artifact: "Generated item",
    artifact_revision: "Generated revision", external_snapshot: "Saved web page",
    contributor: "Author", podcast: "Podcast", reader_apparatus_item: "Source reference",
    passage_anchor: "Passage",
  };
  return labels[scheme];
}
