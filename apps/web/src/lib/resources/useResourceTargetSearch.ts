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
  /** Source self-exclusion and existing-link identity. */
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
 * and notes `@`/Mod-K/`[[` autocomplete. `useDebouncedFetch` owns cancellation
 * and retained results; this hook projects them by the current request key.
 * Positioning, keyboard navigation, and insertion stay with callers.
 */
export function useResourceTargetSearch(
  args: UseResourceTargetSearchArgs,
): ResourceTargetSearchState {
  const { purpose, query, schemes, sourceRef, excludeRefs, limit } = args;
  const trimmed = query.trim();
  const key =
    trimmed.length === 0
      ? null
      : JSON.stringify([
          purpose,
          trimmed,
          schemes ?? null,
          sourceRef ?? null,
          excludeRefs ?? [],
          limit ?? null,
        ]);

  // Every request-shaping input belongs in the key. In particular, reopening a
  // populated Link dialog with a durable source must re-run the same query so
  // the backend can annotate already-linked targets for that source.
  const { data, dataIdentity, loading, error, errorIdentity } = useDebouncedFetch(
    key,
    (signal) =>
      searchResourceTargets(
        { q: trimmed, purpose, schemes, sourceRef, excludeRefs, limit },
        signal,
      ),
    { debounceMs: DEBOUNCE_MS[purpose] },
  );

  const dataIsCurrent = key !== null && dataIdentity === key;
  const errorIsCurrent = key !== null && errorIdentity === key;
  return {
    targets: dataIsCurrent ? data?.targets ?? [] : [],
    loading: key !== null && (loading || (!dataIsCurrent && !errorIsCurrent)),
    error: errorIsCurrent ? error : null,
  };
}
