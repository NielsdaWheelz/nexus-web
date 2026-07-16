"use client";

import { useEffect, useRef, useState } from "react";
import { fetchContributorSearch } from "@/lib/contributors/api";
import type { ContributorSearchItem } from "@/lib/contributors/types";
import { isAbortError } from "@/lib/errors";

const CONTRIBUTOR_SEARCH_DEBOUNCE_MS = 180;
const DEFAULT_CONTRIBUTOR_SEARCH_LIMIT = 10;

// Shared contributor-search controller (D-34). One explicit state machine drives
// both the multi-select ContributorFilter and the single-select AuthorSearchField.
// It requires a non-blank query (the server rejects blank `q`), suppresses stale
// responses with a monotonic request id plus an AbortController, and — critically —
// surfaces request failures as `error`, never as an empty result list.
export type ContributorSearchState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; query: string; items: ContributorSearchItem[]; nextCursor: string | null }
  | { status: "empty"; query: string }
  | { status: "error" };

export interface UseContributorSearchOptions {
  /** Listbox page size; the combobox requests a small page (default 10). */
  limit?: number;
  /**
   * Bump to force a re-fetch of the *same* query (e.g. an error "Try again").
   * It is part of the effect key but not the query, so a retry re-runs the
   * request honestly instead of perturbing the query string.
   */
  reloadToken?: number;
}

export function useContributorSearch(
  query: string,
  options: UseContributorSearchOptions = {},
): ContributorSearchState {
  const { limit = DEFAULT_CONTRIBUTOR_SEARCH_LIMIT, reloadToken = 0 } = options;
  const [state, setState] = useState<ContributorSearchState>({ status: "idle" });
  const requestIdRef = useRef(0);

  useEffect(() => {
    const trimmed = query.trim();
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    const isCurrent = () => requestIdRef.current === requestId;

    if (trimmed.length < 1) {
      setState({ status: "idle" });
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => {
      if (!isCurrent()) return;
      setState({ status: "loading" });
      void fetchContributorSearch(trimmed, { limit, signal: controller.signal })
        .then((page) => {
          if (!isCurrent()) return;
          if (page.contributors.length === 0) {
            setState({ status: "empty", query: trimmed });
            return;
          }
          setState({
            status: "ready",
            query: trimmed,
            items: page.contributors,
            nextCursor: page.nextCursor,
          });
        })
        .catch((error: unknown) => {
          if (isAbortError(error) || !isCurrent()) return;
          setState({ status: "error" });
        });
    }, CONTRIBUTOR_SEARCH_DEBOUNCE_MS);

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [query, limit, reloadToken]);

  return state;
}
