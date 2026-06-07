// SearchQuery ↔ URLSearchParams (search cutover §7.1). Preserves the omitted-vs-empty
// `kinds` distinction: requestedKinds === null omits the param (⇒ all); an empty set
// emits `kinds=` (⇒ no results).

import {
  SEARCH_KINDS,
  normalizeFormat,
  normalizeKind,
  type MediaFormat,
  type SearchKind,
} from "./kinds";
import type { SearchQuery } from "./query";

function csv(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function searchQueryToParams(query: SearchQuery): URLSearchParams {
  const params = new URLSearchParams();
  const text = query.text.trim();
  if (text) params.set("q", text);
  if (query.requestedKinds !== null) {
    const requested = query.requestedKinds;
    params.set("kinds", SEARCH_KINDS.filter((kind) => requested.has(kind)).join(","));
  }
  if (query.formats.length > 0) params.set("formats", query.formats.join(","));
  if (query.authors.length > 0) params.set("authors", query.authors.join(","));
  if (query.roles.length > 0) params.set("roles", query.roles.join(","));
  if (query.scope && query.scope !== "all") params.set("scope", query.scope);
  return params;
}

export function searchQueryFromParams(params: URLSearchParams): SearchQuery {
  const kindsParam = params.get("kinds");
  const requestedKinds: ReadonlySet<SearchKind> | null =
    kindsParam === null
      ? null
      : new Set(csv(kindsParam).map(normalizeKind).filter((k): k is SearchKind => k !== null));
  const formats = csv(params.get("formats"))
    .map(normalizeFormat)
    .filter((f): f is MediaFormat => f !== null);
  return {
    text: params.get("q") ?? "",
    requestedKinds,
    formats,
    authors: csv(params.get("authors")),
    roles: csv(params.get("roles")),
    scope: params.get("scope") ?? "all",
  };
}

// Build a /search href for "See all results" round-trips and pane navigation.
export function searchHref(query: SearchQuery): string {
  const params = searchQueryToParams(query);
  const queryString = params.toString();
  return queryString ? `/search?${queryString}` : "/search";
}
