// What to find (python services/search/query.py SearchQuery), shared by the
// search pane and Nexus.

import { SEARCH_KINDS, type MediaFormat, type SearchKind } from "./kinds";
import type { ParsedSearchInput } from "./parseSearchInput";

export interface SearchQuery {
  text: string;
  /** null: every kind (`kinds` omitted); empty: none (`kinds=`). */
  requestedKinds: ReadonlySet<SearchKind> | null;
  formats: MediaFormat[];
  authors: string[];
  roles: string[];
  /** "all", or a media, library or conversation ref. */
  scope: string;
}

export function emptySearchQuery(): SearchQuery {
  return {
    text: "",
    requestedKinds: null,
    formats: [],
    authors: [],
    roles: [],
    scope: "all",
  };
}

/** `base` with the parsed text, and its chips added to its filters. */
export function applyParsedInput(
  base: SearchQuery,
  parsed: ParsedSearchInput,
): SearchQuery {
  const next = { ...base, text: parsed.text };
  for (const chip of parsed.chips) {
    if (chip.dim === "kind") {
      const kinds = new Set(next.requestedKinds ?? []).add(chip.value);
      next.requestedKinds = kinds.size === SEARCH_KINDS.length ? null : kinds;
    } else if (chip.dim === "format") {
      if (!next.formats.includes(chip.value))
        next.formats = [...next.formats, chip.value];
    } else if (chip.dim === "author") {
      if (!next.authors.includes(chip.value))
        next.authors = [...next.authors, chip.value];
    } else if (chip.dim === "role") {
      if (!next.roles.includes(chip.value))
        next.roles = [...next.roles, chip.value];
    } else {
      next.scope = chip.value;
    }
  }
  return next;
}
