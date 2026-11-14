// Browser discovery vocabulary; evidence tools own their narrower kind set.
import type { Schema } from "@/lib/api/wire";

export const SEARCH_KINDS = [
  "documents",
  "notes",
  "highlights",
  "messages",
  "people",
  "libraries",
  "readings",
  "saved_passages",
] as const satisfies readonly Schema<"DiscoveryKind">[];
export type SearchKind = Schema<"DiscoveryKind">;

export const SEARCH_KIND_LABELS: Record<SearchKind, string> = {
  documents: "documents",
  notes: "notes",
  highlights: "highlights",
  messages: "messages",
  people: "people",
  libraries: "libraries",
  readings: "readings",
  saved_passages: "saved passages",
};

export const PASSAGE_KINDS: ReadonlySet<SearchKind> = new Set([
  "documents", "notes", "highlights", "messages", "saved_passages",
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
  article: "articles",
  pdf: "pdfs",
  epub: "epubs",
  video: "videos",
  episode: "episodes",
  podcast: "podcasts",
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
  messages: "messages",
  message: "messages",
  people: "people",
  person: "people",
  library: "libraries",
  libraries: "libraries",
  reading: "readings",
  readings: "readings",
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
      ? [["documents"], "formats apply to documents."]
      : filters.hasCreditFilter
        ? [
            ["documents", "people"],
            "authors and roles apply to documents and people.",
          ]
        : [SEARCH_KINDS, null];
  return {
    kinds: new Set(SEARCH_KINDS.filter((kind) => !allowed.includes(kind))),
    reason,
  };
}
