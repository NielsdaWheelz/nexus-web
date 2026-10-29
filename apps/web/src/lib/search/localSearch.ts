"use client";

// Local discovery. The account database answers for authored notes, pages, highlights
// and saved passages online and offline; remote search never supplies or replaces those
// rows. It also finds retained source labels (a stub's literal capture, no reading
// authority), which yield to the server's own row for the same ref when it has one.
// Scoped queries use the last complete local membership/text revision plus current
// authored links. Missing scope inputs are explicit, never a remote-writing fallback.
// Excerpts use separate literal matching text; canonical labels/captures stay intact.
// search activation retains the selected reading and the canonical saved occurrence.
import { useMemo } from "react";
import type { AuthoredQuery, ResourceProjection, ResourceRef } from "@nexus/authored/types";
import type { SearchFamily, SearchScope } from "@nexus/authored/scope";
import { capturedHighlightText, searchName, searchNameMatch } from "@nexus/authored/queries";
import { useAuthoredPrefix, useAuthoredQuery } from "@/lib/notes/hooks";
import { localResourceHref, localResourceLabel } from "@/lib/resources/localResource";
import { parseResourceRef } from "@/lib/resourceGraph/resourceRef";
import type { SearchKind } from "./kinds";
import type { SearchQuery } from "./query";

/** Schemes that can have a canonical local writing row; this does not establish ownership. */
export const WRITING_REF = /^(note_block|page|highlight|passage_anchor):/u;
/** The server's discovery families (`services/search/query.py` `DISCOVERY_FAMILIES`) for local refs. */
const FAMILIES: Partial<Record<string, SearchKind>> = {
  note_block: "notes", page: "notes", highlight: "highlights", passage_anchor: "saved_passages",
  media: "documents", podcast: "documents", conversation: "conversations", contributor: "people",
  library: "libraries", oracle_reading: "readings",
};
const kindOf = (resource: ResourceProjection): SearchKind | null => FAMILIES[parseResourceRef(resource.ref)?.scheme ?? ""] ?? null;
const PAGE = 50;
const CONTEXT = 60;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function localSearchScopes(scope: string): SearchScope[] | null {
  if (scope === "all") return [{kind: "all", id: null}];
  const parsed = parseResourceRef(scope);
  return parsed && (parsed.scheme === "media" || parsed.scheme === "library" || parsed.scheme === "conversation")
    ? [{kind: parsed.scheme, id: parsed.id}] : null;
}

/** Lowercasing can expand a codepoint (İ → i + dot); evidence names literal offsets. */
function literalRange(text: string, start: number, end: number): [number, number] {
  let folded = 0, offset = 0, begin = 0;
  for (const character of text) {
    const next = folded + character.toLowerCase().length;
    if (folded <= start && start < next) begin = offset;
    if (folded < end && end <= next) return [begin, offset + character.length];
    folded = next;
    offset += character.length;
  }
  throw new RangeError("Search match lies outside its literal text");
}

/** Format and credit filters exclude authored families on both search owners. */
export function localSearchApplies(query: SearchQuery): boolean {
  const kinds = query.requestedKinds;
  return query.text.trim() !== "" && query.formats.length + query.authors.length + query.roles.length === 0 &&
    (kinds === null || (query.scope === "all" ? Object.values(FAMILIES) : ["notes", "highlights", "saved_passages"] as const)
      .some(kind => kind !== undefined && kinds.has(kind)));
}

export interface LocalMatch {
  readonly resource: ResourceProjection;
  readonly readingRef: ResourceRef | null;
  /** Its discovery family, for the row's type and the kind filter. */
  readonly kind: SearchKind;
  readonly label: string;
  readonly href: string | null;
  readonly nameMatch: ReturnType<typeof searchNameMatch>;
  /** A literal slice of the matched text and the matched token spans within it. */
  readonly excerpt: { readonly text: string; readonly marks: readonly (readonly [number, number])[]; readonly before: boolean; readonly after: boolean } | null;
}

/** One local row's match; null when its ref names no discovery family (e.g. a fragment stub). */
export function localResult(resource: ResourceProjection, text: string): LocalMatch | null {
  const kind = kindOf(resource);
  return kind === null ? null : localMatch(resource, kind, text);
}

export function localMatch(resource: ResourceProjection, kind: SearchKind, text: string,
  { matchText, activationRef }: { matchText: string | null; activationRef: ResourceRef | null } = { matchText: null, activationRef: null }): LocalMatch {
  const body = matchText ?? (resource.kind === "highlight" && resource.selection ? capturedHighlightText(resource) : resource.kind === "note" ? resource.body_text ?? ""
    : searchName(resource) ?? resource.title ?? "");
  const nameMatch = searchNameMatch(resource, text);
  const tokens = text.trim().toLowerCase().split(/\s+/u).filter(Boolean);
  const lower = body.toLowerCase();
  const first = Math.min(...tokens.map(token => { const at = lower.indexOf(token); return at < 0 ? Infinity : at; }));
  const label = localResourceLabel(resource);
  if (!body || first === Infinity) return { resource, readingRef: activationRef, kind, label, href: localResourceHref(resource, { activationRef }), nameMatch, excerpt: null };
  const [literalFirst] = literalRange(body, first, first + 1);
  const named = (resource.kind === "page" || resource.kind === "source") && body === label;
  const rawStart = Math.max(0, literalFirst - CONTEXT), rawEnd = Math.min(body.length, literalFirst + CONTEXT * 2);
  const segments = graphemes.segment(body);
  // The context heuristic yields to complete source graphemes at both edges; a literal name stays whole.
  const start = named ? 0 : rawStart < body.length ? segments.containing(rawStart)!.index : body.length;
  const last = segments.containing(rawEnd - 1)!;
  const end = named ? body.length : last.index + last.segment.length;
  const slice = body.slice(start, end);
  const sliceLower = slice.toLowerCase();
  const marks: [number, number][] = [];
  for (const token of tokens) for (let at = sliceLower.indexOf(token); at >= 0; at = sliceLower.indexOf(token, at + token.length)) marks.push(literalRange(slice, at, at + token.length));
  marks.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  // overlapping token spans keep the earliest; each character renders once.
  const kept: [number, number][] = [];
  for (const mark of marks) if (!kept.length || mark[0] >= kept.at(-1)![1]) kept.push(mark);
  return { resource, readingRef: activationRef, kind, label, href: localResourceHref(resource, { activationRef }), nameMatch,
    excerpt: { text: slice, marks: kept, before: start > 0, after: end < body.length } };
}

/** Launcher admission is one nonpaged read at one local store revision. */
export function useLocalSearchPreview(text: string | null, kinds: SearchQuery["requestedKinds"], scope: string): {
  readonly matches: readonly LocalMatch[] | null;
  readonly storeRevision: string | null;
  readonly complete: boolean;
  readonly pending: boolean;
  readonly occurrence: object | null;
  readonly scopeAvailable: boolean | null;
  readonly error: unknown;
  readonly retry: () => void;
} {
  const scopes = localSearchScopes(scope);
  const families: SearchFamily[] | null = kinds === null ? null : [...kinds].filter(kind => kind !== "web").sort();
  const query: Extract<AuthoredQuery, {kind: "search_preview"}> | null = text === null || scopes === null ? null
    : {kind: "search_preview", text, limit: 8, scopes, families};
  const result = useAuthoredQuery(query);
  const matches = useMemo(() => result.data === null ? null : result.data.rows.flatMap(({resource, match_text, activation_ref}) => {
    const kind = kindOf(resource);
    return kind !== null && (kinds === null || kinds.has(kind)) ? [localMatch(resource, kind, text ?? "", {matchText: match_text, activationRef: activation_ref})] : [];
  }), [result.data, kinds, text]);
  if (text !== null && scopes === null) return {matches: [], storeRevision: null, complete: true, pending: false, occurrence: null, scopeAvailable: false, error: null, retry: result.retry};
  return {matches, storeRevision: result.data?.store_revision ?? null, complete: result.data !== null, pending: result.pending, occurrence: result.occurrence, scopeAvailable: result.error !== null || result.data === null ? null : result.data.scope_available,
    error: result.error, retry: result.retry};
}

/** Every local match of the requested authored kinds, a page at a time, re-read whenever
 * local state commits. Showing more keeps the current matches until the longer read lands. */
export function useLocalSearch(text: string | null, kinds: SearchQuery["requestedKinds"], pages: number, scope: string): {
  readonly matches: readonly LocalMatch[] | null;
  readonly complete: boolean;
  readonly pending: boolean;
  readonly occurrence: object | null;
  readonly scopeAvailable: boolean | null;
  readonly error: unknown;
  readonly retry: () => void;
} {
  const scopes = localSearchScopes(scope);
  const families: SearchFamily[] | null = kinds === null ? null : [...kinds].filter(kind => kind !== "web").sort();
  const query: Extract<AuthoredQuery, {kind: "search"}> | null = text === null || scopes === null ? null
    : { kind: "search", text, cursor: null, limit: PAGE, scopes, families };
  const prefix = useAuthoredPrefix(query, pages);
  const matches = useMemo(() => prefix.data === null ? null : prefix.data.rows.flatMap(({ resource, match_text, activation_ref }) => {
    const kind = kindOf(resource);
    return kind !== null && (kinds === null || kinds.has(kind)) ? [localMatch(resource, kind, text ?? "", { matchText: match_text, activationRef: activation_ref })] : [];
  }), [prefix.data, kinds, text]);
  if (text !== null && scopes === null) return { matches: [], complete: true, pending: false, occurrence: null, scopeAvailable: false, error: null, retry: prefix.retry };
  return { matches, complete: prefix.data?.next_cursor === null, pending: prefix.pending, occurrence: prefix.occurrence, scopeAvailable: prefix.error !== null || prefix.data === null ? null : prefix.data.scope_available,
    error: prefix.error, retry: prefix.retry };
}
