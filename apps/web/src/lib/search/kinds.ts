// Browser discovery vocabulary; evidence tools own their narrower kind set.
import type { Schema } from "@/lib/api/wire";

export const SEARCH_KINDS = [
  "documents",
  "notes",
  "highlights",
  "conversations",
  "people",
  "web",
  "libraries",
  "readings",
  "dossiers",
  "saved_passages",
] as const satisfies readonly Schema<"DiscoveryKind">[];
export type SearchKind = Schema<"DiscoveryKind">;

export const SEARCH_KIND_LABELS: Record<SearchKind, string> = {
  documents: "Documents",
  notes: "Notes",
  highlights: "Highlights",
  conversations: "Conversations",
  people: "People",
  web: "Web",
  libraries: "Libraries",
  readings: "Readings",
  dossiers: "Dossiers",
  saved_passages: "Saved passages",
};

export const PASSAGE_KINDS: ReadonlySet<SearchKind> = new Set([
  "documents", "notes", "highlights", "conversations", "saved_passages",
]);

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

// `kind:` values. author is an operator, never a kind.
const KIND_ALIASES: Record<string, SearchKind> = {
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
  library: "libraries",
  libraries: "libraries",
  reading: "readings",
  readings: "readings",
  dossier: "dossiers",
  dossiers: "dossiers",
  saved_passages: "saved_passages",
  saved_passage: "saved_passages",
};

export function normalizeKind(token: string): SearchKind | null {
  return KIND_ALIASES[token.trim().toLowerCase()] ?? null;
}

export function normalizeFormat(token: string): MediaFormat | null {
  const value = token.trim().toLowerCase();
  return MEDIA_FORMATS.find((format) => format === value) ?? null;
}

/** The kinds the server drops under these filters (SearchQuery.effective_kinds), and why. */
export function disabledKinds(filters: {
  hasFormatFilter: boolean;
  hasCreditFilter: boolean;
}): { kinds: ReadonlySet<SearchKind>; reason: string | null } {
  const [allowed, reason]: [readonly SearchKind[], string | null] =
    filters.hasFormatFilter
      ? [["documents"], "Formats apply to documents"]
      : filters.hasCreditFilter
        ? [
            ["documents", "people"],
            "Authors and roles apply to documents and people",
          ]
        : [SEARCH_KINDS, null];
  return {
    kinds: new Set(SEARCH_KINDS.filter((kind) => !allowed.includes(kind))),
    reason,
  };
}
