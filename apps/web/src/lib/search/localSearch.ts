"use client";

// Local discovery. The account database answers for authored notes, pages, highlights
// and saved passages online and offline; remote search never supplies or replaces those
// rows. It also finds retained source labels (a stub's literal capture, no reading
// authority), which yield to the server's own row for the same ref when it has one.
// Excerpts are literal slices of canonical text; matching never rewrites it.
import { useCallback, useEffect, useState } from "react";
import type { QueryResult, ResourceProjection } from "@nexus/authored/types";
import { capturedHighlightText } from "@nexus/authored/queries";
import { useAuthoredStore } from "@/lib/authored/provider";
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

/** Local rows carry no format, author, role or library scope; those filters exclude them. */
export function localSearchApplies(query: SearchQuery): boolean {
  const kinds = query.requestedKinds;
  return query.text.trim() !== "" && query.formats.length + query.authors.length + query.roles.length === 0 && query.scope === "all" &&
    (kinds === null || Object.values(FAMILIES).some(kind => kind !== undefined && kinds.has(kind)));
}

export interface LocalMatch {
  readonly resource: ResourceProjection;
  /** Its discovery family, for the row's type and the kind filter. */
  readonly kind: SearchKind;
  readonly label: string;
  readonly href: string | null;
  /** A literal slice of the matched text and the matched token spans within it. */
  readonly excerpt: { readonly text: string; readonly marks: readonly (readonly [number, number])[]; readonly before: boolean; readonly after: boolean } | null;
}

/** One local row's match; null when its ref names no discovery family (e.g. a fragment stub). */
export function localResult(resource: ResourceProjection, text: string): LocalMatch | null {
  const kind = kindOf(resource);
  return kind === null ? null : localMatch(resource, kind, text);
}

export function localMatch(resource: ResourceProjection, kind: SearchKind, text: string): LocalMatch {
  const body = resource.kind === "highlight" && resource.selection ? capturedHighlightText(resource.selection) : resource.kind === "note" ? resource.body_text ?? ""
    : resource.title ?? resource.local_date ?? "";
  const tokens = text.trim().toLowerCase().split(/\s+/u).filter(Boolean);
  const lower = body.toLowerCase();
  const first = Math.min(...tokens.map(token => { const at = lower.indexOf(token); return at < 0 ? Infinity : at; }));
  if (!body || first === Infinity) return { resource, kind, label: localResourceLabel(resource), href: localResourceHref(resource), excerpt: null };
  const start = Math.max(0, first - CONTEXT), end = Math.min(body.length, first + CONTEXT * 2);
  const slice = body.slice(start, end);
  const sliceLower = slice.toLowerCase();
  const marks: [number, number][] = [];
  for (const token of tokens) for (let at = sliceLower.indexOf(token); at >= 0; at = sliceLower.indexOf(token, at + token.length)) marks.push([at, at + token.length]);
  marks.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  // overlapping token spans keep the earliest; each character renders once.
  const kept: [number, number][] = [];
  for (const mark of marks) if (!kept.length || mark[0] >= kept.at(-1)![1]) kept.push(mark);
  return { resource, kind, label: localResourceLabel(resource), href: localResourceHref(resource),
    excerpt: { text: slice, marks: kept, before: start > 0, after: end < body.length } };
}

/** Every local match of the requested authored kinds, a page at a time, re-read whenever
 * local state commits. Showing more keeps the current matches until the longer read lands. */
export function useLocalSearch(text: string | null, kinds: SearchQuery["requestedKinds"], pages = 1): {
  readonly matches: readonly LocalMatch[] | null;
  readonly complete: boolean;
  readonly error: unknown;
  readonly retry: () => void;
} {
  const store = useAuthoredStore();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ key: string; matches: LocalMatch[] | null; complete: boolean; error: unknown }>({ key: "", matches: null, complete: false, error: null });
  const key = text === null ? "" : JSON.stringify([text, kinds === null ? null : [...kinds].sort(), attempt]);
  useEffect(() => {
    if (text === null) return;
    let live = true, reading = false, again = false;
    const read = async () => {
      if (reading) { again = true; return; }
      reading = true;
      try {
        const rows: QueryResult["rows"] = [];
        let cursor: string | null = null;
        for (let page = 0; page < pages; page++) {
          const result: QueryResult = await store.query({ kind: "search", text, cursor, limit: PAGE });
          rows.push(...result.rows);
          cursor = result.next_cursor;
          if (cursor === null) break;
        }
        const matches = rows.flatMap(({ resource }) => {
          const kind = kindOf(resource);
          return kind !== null && (kinds === null || kinds.has(kind)) ? [localMatch(resource, kind, text)] : [];
        });
        if (live) setState({ key, matches, complete: cursor === null, error: null });
      } catch (error) {
        if (live) setState(current => ({ ...current, key, error }));
      } finally {
        reading = false;
        if (again && live) { again = false; void read(); }
      }
    };
    const stop = store.subscribe({ kind: "search", text, cursor: null, limit: 1 }, () => void read());
    return () => { live = false; stop(); };
    // the serialized query (text, kinds, attempt) is the read identity; pages only extend it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, pages, store]);
  const retry = useCallback(() => setAttempt(value => value + 1), []);
  return state.key === key ? { matches: state.matches, complete: state.complete, error: state.error, retry } : { matches: null, complete: false, error: null, retry };
}
