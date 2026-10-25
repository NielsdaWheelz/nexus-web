"use client";

// Local authored discovery. The account database answers for notes, pages and
// highlights online and offline; remote search never supplies or replaces those
// rows. Excerpts are literal slices of canonical text; matching never rewrites it.
import { useCallback, useEffect, useState } from "react";
import type { QueryResult, ResourceProjection } from "@nexus/authored/types";
import { useAuthoredStore } from "@/lib/authored/provider";
import { localResourceHref, localResourceLabel } from "@/components/resources/ResourceOutlineRow";
import type { SearchQuery } from "./query";

export const AUTHORED_REF = /^(note_block|page|highlight):/u;
const PAGE = 50;
const CONTEXT = 60;

/** Authored writing has no format, author, role or library scope; those filters exclude it. */
export function localSearchApplies(query: SearchQuery): boolean {
  const kinds = query.requestedKinds;
  return query.text.trim() !== "" && query.formats.length + query.authors.length + query.roles.length === 0 && query.scope === "all" &&
    (kinds === null || kinds.has("notes") || kinds.has("highlights"));
}

export interface LocalMatch {
  readonly resource: ResourceProjection;
  readonly label: string;
  readonly href: string | null;
  /** A literal slice of the matched text and the matched token spans within it. */
  readonly excerpt: { readonly text: string; readonly marks: readonly (readonly [number, number])[]; readonly before: boolean; readonly after: boolean } | null;
}

export function localMatch(resource: ResourceProjection, text: string): LocalMatch {
  const body = resource.kind === "highlight" ? resource.selection?.quote_exact ?? "" : resource.kind === "page" ? resource.title ?? "" : resource.body_text ?? "";
  const tokens = text.trim().toLowerCase().split(/\s+/u).filter(Boolean);
  const lower = body.toLowerCase();
  const first = Math.min(...tokens.map(token => { const at = lower.indexOf(token); return at < 0 ? Infinity : at; }));
  if (!body || first === Infinity) return { resource, label: localResourceLabel(resource), href: localResourceHref(resource), excerpt: null };
  const start = Math.max(0, first - CONTEXT), end = Math.min(body.length, first + CONTEXT * 2);
  const slice = body.slice(start, end);
  const sliceLower = slice.toLowerCase();
  const marks: [number, number][] = [];
  for (const token of tokens) for (let at = sliceLower.indexOf(token); at >= 0; at = sliceLower.indexOf(token, at + token.length)) marks.push([at, at + token.length]);
  marks.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  // overlapping token spans keep the earliest; each character renders once.
  const kept: [number, number][] = [];
  for (const mark of marks) if (!kept.length || mark[0] >= kept.at(-1)![1]) kept.push(mark);
  return { resource, label: localResourceLabel(resource), href: localResourceHref(resource),
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
        const wanted = rows.filter(({ resource }) => kinds === null || (resource.kind === "highlight" ? kinds.has("highlights") : kinds.has("notes")));
        if (live) setState({ key, matches: wanted.map(row => localMatch(row.resource, text)), complete: cursor === null, error: null });
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
