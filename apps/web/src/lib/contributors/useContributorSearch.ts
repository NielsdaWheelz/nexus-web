"use client";

import { useEffect, useRef, useState } from "react";
import { fetchContributors } from "@/lib/contributors/api";
import type { ContributorSummary } from "@/lib/contributors/types";

const CONTRIBUTOR_SEARCH_DEBOUNCE_MS = 200;
const MIN_QUERY_LENGTH = 2;

// Debounced contributor typeahead shared by ContributorFilter (multi-select) and
// ContributorPicker (single-select). Returns suggestions for the current query; a monotonic
// request id drops stale responses.
export function useContributorSearch(query: string): ContributorSummary[] {
  const [suggestions, setSuggestions] = useState<ContributorSummary[]>([]);
  const requestIdRef = useRef(0);

  useEffect(() => {
    let active = true;
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    const trimmed = query.trim();
    if (trimmed.length < MIN_QUERY_LENGTH) {
      setSuggestions([]);
      return;
    }
    const timer = setTimeout(() => {
      void fetchContributors(trimmed)
        .then((contributors) => {
          if (active && requestIdRef.current === requestId) {
            setSuggestions(contributors);
          }
        })
        .catch(() => {
          if (active && requestIdRef.current === requestId) {
            setSuggestions([]);
          }
        });
    }, CONTRIBUTOR_SEARCH_DEBOUNCE_MS);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [query]);

  return suggestions;
}
