"use client";

import { useDebouncedFetch } from "@/lib/api/useDebouncedFetch";
import type { ResourceScheme } from "@/lib/resourceGraph/resourceRef";
import {
  searchResourceTargets,
  type ResourceTarget,
  type ResourceTargetSearchPurpose,
} from "@/lib/resources/resourceTargets";

// `purpose=reference` is the notes authoring fast path (1-char, lexical-only,
// never embeds server-side) and wants near-immediate feedback; `purpose=link`
// is the hybrid/may-embed profile and gets a real debounce so a fast typist
// doesn't fire an embedding call per keystroke.
const DEBOUNCE_MS: Record<ResourceTargetSearchPurpose, number> = {
  link: 200,
  reference: 0,
};

export interface UseResourceTargetSearchArgs {
  purpose: ResourceTargetSearchPurpose;
  query: string;
  schemes?: readonly ResourceScheme[];
  /** An existing durable Link source, for already-linked dedupe (`purpose=link` only). */
  sourceRef?: string;
  excludeRefs?: readonly string[];
  limit?: number;
}

export interface ResourceTargetSearchState {
  targets: ResourceTarget[];
  loading: boolean;
  error: unknown | null;
}

/**
 * Shared target-search controller for Connections, the reader Link dialog,
 * and notes `@`/Mod-K/`[[` autocomplete. Built on `useDebouncedFetch` — no
 * hand-rolled stale-response race guard (that hook already discards a
 * response whose key has since changed). Positioning, keyboard nav, and
 * insertion stay with callers; this hook owns only the fetch.
 */
export function useResourceTargetSearch(
  args: UseResourceTargetSearchArgs,
): ResourceTargetSearchState {
  const { purpose, query, schemes, sourceRef, excludeRefs, limit } = args;
  const trimmed = query.trim();
  const schemesKey = schemes?.join(",") ?? "";
  const key = trimmed.length === 0 ? null : `${purpose}:${trimmed}:${schemesKey}`;

  // `useDebouncedFetch` re-captures this closure into a ref every render and
  // only (re)schedules a fetch when `key` changes, so a plain inline fetcher
  // here already picks up the latest `sourceRef`/`excludeRefs`/`limit` at
  // call time — no memoization needed.
  const { data, loading, error } = useDebouncedFetch(
    key,
    (signal) =>
      searchResourceTargets(
        { q: trimmed, purpose, schemes, sourceRef, excludeRefs, limit },
        signal,
      ),
    { debounceMs: DEBOUNCE_MS[purpose] },
  );

  return { targets: data?.targets ?? [], loading, error };
}
