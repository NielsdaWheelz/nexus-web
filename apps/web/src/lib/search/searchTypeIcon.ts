import {
  FileText,
  Globe,
  Highlighter,
  MessageSquare,
  Mic,
  NotebookTabs,
  UserRound,
  Video,
  type LucideIcon,
} from "lucide-react";
import type { SearchType } from "./types";

/**
 * Canonical icon for each search result type. The chat evidence disclosure
 * reuses this map: a retrieval's result_type is a subset of SearchType.
 */
export const SEARCH_TYPE_ICON: Record<SearchType, LucideIcon> = {
  contributor: UserRound,
  media: Globe,
  podcast: Mic,
  episode: Mic,
  video: Video,
  content_chunk: FileText,
  fragment: FileText,
  page: FileText,
  note_block: FileText,
  highlight: Highlighter,
  message: MessageSquare,
  evidence_span: FileText,
  reader_apparatus_item: NotebookTabs,
  conversation: MessageSquare,
  web_result: Globe,
};
