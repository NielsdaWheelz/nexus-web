/**
 * Display mapping for resource refs: scheme -> icon. Parsing/formatting and
 * the scheme vocabulary are owned by
 * `@/lib/resourceGraph/resourceRef` (AC17) — this module never splits a ref.
 */

import {
  AlignLeft,
  BookOpen,
  Disc3,
  File,
  FileText,
  Globe,
  Highlighter,
  Library,
  Link2,
  MessageSquare,
  MessagesSquare,
  Mic,
  NotebookTabs,
  Sparkles,
  StickyNote,
  TextQuote,
  User,
  Video,
  type LucideIcon,
} from "lucide-react";
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
  oracle_passage_anchor: TextQuote,
  artifact: Sparkles,
  artifact_revision: Sparkles,
  external_snapshot: Globe,
  contributor: User,
  podcast: Disc3,
  reader_apparatus_item: NotebookTabs,
  passage_anchor: TextQuote,
} satisfies Record<ResourceScheme, LucideIcon>;

export function resourceIconForUri(resourceRef: string): LucideIcon {
  const parsed = parseResourceRef(resourceRef);
  return parsed ? RESOURCE_SCHEME_ICONS[parsed.scheme] : Link2;
}

export function resourceIconForScheme(scheme: string): LucideIcon {
  return isResourceScheme(scheme) ? RESOURCE_SCHEME_ICONS[scheme] : Link2;
}

/**
 * Lead icon for a media row by its `kind`. All media share the `media` scheme,
 * so this is the one owner of the finer book/pdf/audio/video distinction the
 * collection lead falls back to when there is no cover.
 */
export function mediaKindIcon(kind: string): LucideIcon {
  switch (kind) {
    case "epub":
      return BookOpen;
    case "pdf":
      return FileText;
    case "podcast_episode":
      return Mic;
    case "video":
      return Video;
    default:
      return Globe;
  }
}
