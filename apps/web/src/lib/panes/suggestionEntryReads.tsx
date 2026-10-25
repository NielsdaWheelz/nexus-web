"use client";

import { createContext, useContext } from "react";
import type { ReadDescriptor } from "@/lib/api/serverState";
import { SUGGESTIONS_REQUEST_TIMEOUT_MS } from "@/lib/api/suggestionPolicy";
import { getSuggestions, type Suggestions, type QuickReads } from "@/lib/suggestions";

export const SuggestionEntryRead = createContext<ReadDescriptor<Suggestions> | null>(null);
export const QuickReadsEntryRead = createContext<ReadDescriptor<QuickReads> | null>(null);
export const useSuggestionEntryRead = () => useContext(SuggestionEntryRead);
export const useQuickReadsEntryRead = () => useContext(QuickReadsEntryRead);

/** Published-selection GET policy; preparation never starts generation or streams. */
export function suggestionRead(libraryId: string | null): ReadDescriptor<Suggestions> {
  const key = libraryId === null ? "/lectern/suggestions" : `/libraries/${libraryId}/suggestions`;
  const path = libraryId === null ? "/api/lectern/suggestions" : `/api/libraries/${encodeURIComponent(libraryId)}/suggestions` as const;
  return { key, stale: "", timeoutMs: SUGGESTIONS_REQUEST_TIMEOUT_MS, load: signal => getSuggestions(path, signal) };
}
