// Frontend mirror of the backend search kind taxonomy (search cutover §4.3-§4.5).
// The six user-facing kinds + the format vocab + implied-kind compatibility.

export const SEARCH_KINDS = [
  "documents",
  "notes",
  "highlights",
  "conversations",
  "people",
  "web",
] as const;

export type SearchKind = (typeof SEARCH_KINDS)[number];

export const SEARCH_KIND_LABELS: Record<SearchKind, string> = {
  documents: "Documents",
  notes: "Notes",
  highlights: "Highlights",
  conversations: "Conversations",
  people: "People",
  web: "Web",
};

export const MEDIA_FORMATS = [
  "article",
  "pdf",
  "epub",
  "video",
  "episode",
  "podcast",
] as const;

export type MediaFormat = (typeof MEDIA_FORMATS)[number];

export const MEDIA_FORMAT_LABELS: Record<MediaFormat, string> = {
  article: "Articles",
  pdf: "PDFs",
  epub: "EPUBs",
  video: "Videos",
  episode: "Episodes",
  podcast: "Podcasts",
};

// Operator/alias → canonical kind. No "author" alias (author: is an operator).
export const KIND_ALIASES: Record<string, SearchKind> = {
  documents: "documents",
  document: "documents",
  doc: "documents",
  docs: "documents",
  notes: "notes",
  note: "notes",
  highlights: "highlights",
  highlight: "highlights",
  conversations: "conversations",
  conversation: "conversations",
  chat: "conversations",
  chats: "conversations",
  people: "people",
  person: "people",
  web: "web",
};

// Implied-kind: which kinds can honor a media-format vs an author/role filter (§4.5).
const FORMAT_KINDS: ReadonlySet<SearchKind> = new Set(["documents"]);
const CREDIT_KINDS: ReadonlySet<SearchKind> = new Set(["documents", "people"]);

export function normalizeKind(token: string): SearchKind | null {
  return KIND_ALIASES[token.trim().toLowerCase()] ?? null;
}

export function normalizeFormat(token: string): MediaFormat | null {
  const value = token.trim().toLowerCase();
  return (MEDIA_FORMATS as readonly string[]).includes(value)
    ? (value as MediaFormat)
    : null;
}

// Kinds disabled by the currently-active filters (mirrors server-side implied-kind).
// A media-format filter disables non-Document kinds; an author/role filter disables
// everything but Documents and People. Returns the set of disabled kinds + a reason.
export function disabledKinds(options: {
  hasFormatFilter: boolean;
  hasCreditFilter: boolean;
}): { kinds: ReadonlySet<SearchKind>; reason: string | null } {
  let allowed: ReadonlySet<SearchKind> | null = null;
  let reason: string | null = null;
  if (options.hasFormatFilter) {
    allowed = FORMAT_KINDS;
    reason = "Formats apply to documents";
  }
  if (options.hasCreditFilter) {
    allowed = allowed
      ? new Set([...allowed].filter((kind) => CREDIT_KINDS.has(kind)))
      : CREDIT_KINDS;
    reason = options.hasFormatFilter
      ? "Formats apply to documents"
      : "Authors and roles apply to documents and people";
  }
  if (!allowed) {
    return { kinds: new Set(), reason: null };
  }
  const disabled = new Set(SEARCH_KINDS.filter((kind) => !allowed.has(kind)));
  return { kinds: disabled, reason };
}
