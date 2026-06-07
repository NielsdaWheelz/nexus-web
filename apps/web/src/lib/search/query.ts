// The frontend SearchQuery value object — one model shared by the /search page and
// the command-palette @ lane (search cutover §7.1/G3).

import { SEARCH_KINDS, type MediaFormat, type SearchKind } from "./kinds";
import { parseSearchInput, type ParsedSearchInput } from "./parseSearchInput";

export interface SearchQuery {
  text: string;
  // null ⇒ all kinds (param omitted); empty set ⇒ no results (explicitly cleared).
  requestedKinds: ReadonlySet<SearchKind> | null;
  formats: MediaFormat[];
  authors: string[];
  roles: string[];
  // "all" | "media:<id>" | "library:<id>" | "conversation:<id>"
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

export function hasFormatFilter(query: SearchQuery): boolean {
  return query.formats.length > 0;
}

export function hasCreditFilter(query: SearchQuery): boolean {
  return query.authors.length > 0 || query.roles.length > 0;
}

export function hasActiveFilters(query: SearchQuery): boolean {
  return (
    query.requestedKinds !== null ||
    hasFormatFilter(query) ||
    hasCreditFilter(query) ||
    query.scope !== "all"
  );
}

// A query that would return nothing without producing a request: no text and no
// structured filter. The kind selection alone (with text) still searches.
export function isBlankQuery(query: SearchQuery): boolean {
  return (
    query.text.trim().length === 0 &&
    !hasFormatFilter(query) &&
    !hasCreditFilter(query)
  );
}

// Merge parsed operator chips into a base query (absorbing operators into filters).
export function applyParsedInput(
  base: SearchQuery,
  parsed: ParsedSearchInput,
): SearchQuery {
  const formats = new Set(base.formats);
  const authors = new Set(base.authors);
  const roles = new Set(base.roles);
  let requestedKinds = base.requestedKinds;
  let scope = base.scope;
  for (const chip of parsed.chips) {
    if (chip.dim === "kind") {
      const set =
        requestedKinds === null ? new Set<SearchKind>() : new Set(requestedKinds);
      set.add(chip.value);
      requestedKinds = set.size === SEARCH_KINDS.length ? null : set;
    } else if (chip.dim === "format") {
      formats.add(chip.value);
    } else if (chip.dim === "author") {
      authors.add(chip.value);
    } else if (chip.dim === "role") {
      roles.add(chip.value);
    } else if (chip.dim === "scope") {
      scope = chip.value;
    }
  }
  return {
    text: parsed.text,
    requestedKinds,
    formats: [...formats] as MediaFormat[],
    authors: [...authors],
    roles: [...roles],
    scope,
  };
}

// One-shot: build a fresh SearchQuery from raw box input (page + palette share this).
export function searchQueryFromInput(raw: string): SearchQuery {
  return applyParsedInput(emptySearchQuery(), parseSearchInput(raw));
}
