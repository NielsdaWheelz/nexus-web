// SearchQuery <-> its canonical url params (I1): kinds in SEARCH_KINDS order,
// omitted for every kind and `kinds=` for none; list values deduped in order.

import {
  SEARCH_KINDS,
  normalizeFormat,
  normalizeKind,
  type SearchKind,
} from "./kinds";
import type { SearchQuery } from "./query";

const list = (value: string | null): string[] =>
  [...new Set((value ?? "").split(",").map((item) => item.trim()))].filter(
    Boolean,
  );

export function searchQueryToParams(query: SearchQuery): URLSearchParams {
  const params = new URLSearchParams();
  const text = query.text.trim();
  const kinds = query.requestedKinds;
  if (text) params.set("q", text);
  if (kinds !== null)
    params.set(
      "kinds",
      SEARCH_KINDS.filter((kind) => kinds.has(kind)).join(","),
    );
  if (query.formats.length > 0) params.set("formats", query.formats.join(","));
  if (query.authors.length > 0) params.set("authors", query.authors.join(","));
  if (query.roles.length > 0) params.set("roles", query.roles.join(","));
  if (query.scope !== "all") params.set("scope", query.scope);
  return params;
}

export function searchQueryFromParams(params: URLSearchParams): SearchQuery {
  const raw = params.get("kinds");
  const kinds: Set<SearchKind> | null =
    raw === null
      ? null
      : new Set(list(raw).flatMap((t) => normalizeKind(t) ?? []));
  return {
    text: params.get("q") ?? "",
    requestedKinds: kinds?.size === SEARCH_KINDS.length ? null : kinds,
    formats: list(params.get("formats")).flatMap(
      (t) => normalizeFormat(t) ?? [],
    ),
    authors: list(params.get("authors")),
    roles: list(params.get("roles")),
    scope: params.get("scope") || "all",
  };
}

/** The search pane's href for a query ("See all results", the pane's own url). */
export function searchHref(query: SearchQuery): string {
  const params = searchQueryToParams(query).toString();
  return params ? `/search?${params}` : "/search";
}
