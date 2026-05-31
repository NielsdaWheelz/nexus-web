import {
  AlignLeft,
  File,
  FileText,
  Highlighter,
  Library,
  Link2,
  MessageSquare,
  MessagesSquare,
  StickyNote,
  TextQuote,
  type LucideIcon,
} from "lucide-react";
import type { ObjectType } from "@/lib/objectRefs";

export const RESOURCE_URI_SCHEMES = [
  "media",
  "library",
  "span",
  "chunk",
  "highlight",
  "page",
  "note_block",
  "fragment",
  "conversation",
  "message",
] as const;

export type ResourceUriScheme = (typeof RESOURCE_URI_SCHEMES)[number];
export interface ParsedResourceUri {
  scheme: ResourceUriScheme;
  id: string;
}

const RESOURCE_SCHEME_ICONS = {
  media: FileText,
  library: Library,
  span: TextQuote,
  chunk: AlignLeft,
  highlight: Highlighter,
  page: File,
  note_block: StickyNote,
  fragment: TextQuote,
  conversation: MessagesSquare,
  message: MessageSquare,
} satisfies Record<ResourceUriScheme, LucideIcon>;

const RESOURCE_SCHEME_OBJECT_TYPES: Partial<Record<ResourceUriScheme, ObjectType>> = {
  media: "media",
  span: "evidence_span",
  chunk: "content_chunk",
  highlight: "highlight",
  page: "page",
  note_block: "note_block",
  fragment: "fragment",
  conversation: "conversation",
  message: "message",
};

const CANONICAL_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function parseResourceUri(resourceUri: string): ParsedResourceUri | null {
  const [scheme, id, extra] = resourceUri.split(":");
  if (extra !== undefined || !scheme || !id) return null;
  if (!isResourceUriScheme(scheme) || !CANONICAL_UUID_RE.test(id)) return null;
  return { scheme, id };
}

export function resourceObjectTypeForScheme(scheme: ResourceUriScheme): ObjectType | null {
  return RESOURCE_SCHEME_OBJECT_TYPES[scheme] ?? null;
}

export function resourceIconForUri(resourceUri: string): LucideIcon {
  const parsed = parseResourceUri(resourceUri);
  return parsed ? resourceIconForScheme(parsed.scheme) : Link2;
}

export function resourceIconForScheme(scheme: string): LucideIcon {
  if (isResourceUriScheme(scheme)) {
    return RESOURCE_SCHEME_ICONS[scheme];
  }
  return Link2;
}

function isResourceUriScheme(scheme: string): scheme is ResourceUriScheme {
  return (RESOURCE_URI_SCHEMES as readonly string[]).includes(scheme);
}
