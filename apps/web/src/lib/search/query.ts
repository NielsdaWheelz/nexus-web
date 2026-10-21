// Browser discovery criteria, shared by full search and the launcher.

import type { ApiJson } from "@/lib/api/wire";
import { SEARCH_KINDS, disabledKinds, type MediaFormat, type SearchKind } from "./kinds";
import type { ParsedSearchInput } from "./parseSearchInput";

export interface SearchQuery {
  text: string;
  view: ApiJson<"/search", "get">["view"];
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
    view: "resources",
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

/** The same effective-kind restriction as server discovery; an empty set is unsupported. */
export function effectiveSearchKinds(query: SearchQuery): readonly SearchKind[] {
  const { kinds: disabled } = disabledKinds({ hasFormatFilter: query.formats.length > 0, hasCreditFilter: query.authors.length + query.roles.length > 0 });
  return SEARCH_KINDS.filter(kind => !disabled.has(kind) && (query.requestedKinds === null || query.requestedKinds.has(kind)));
}

/** Mirrors discovery's serving semantic families after effective-kind filtering. */
export function searchHasSemanticFamily(query: SearchQuery): boolean {
  const kinds = effectiveSearchKinds(query);
  return Array.from(query.text.trim()).length >= 2 && (kinds.includes("documents") || kinds.includes("notes"));
}
