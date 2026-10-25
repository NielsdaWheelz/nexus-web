// Complete server phases share progress wording; their rows and scores never mix.
import type { PreviewPhase } from "./searchApi";
export type SearchProgress = {
  readonly text: string;
  readonly action: "search" | "related" | "refresh" | null;
};

export function searchProgress(input: {
  readonly phase: PreviewPhase | null;
  readonly count: number;
  readonly lexical: "pending" | "failed" | "ready" | "idle";
  readonly hybrid: "pending" | "failed" | "ready" | "idle";
  readonly directFailed?: boolean;
  readonly held: boolean;
}): SearchProgress {
  const { phase, count, lexical, hybrid } = input;
  if (input.held) return { text: "search update ready", action: "refresh" };
  if (phase === "hybrid") return { text: count ? "" : "no results found.", action: null };
  if (phase === "lexical") {
    if (hybrid === "pending") return {
      text: count ? "finding related matches…" : "no text matches found. finding related matches…", action: null,
    };
    if (hybrid === "failed") return {
      text: count ? "related matches are unavailable. text matches are still shown." : "no text matches found. related matches are unavailable.", action: "related",
    };
    return { text: count ? "" : "no results found.", action: null };
  }
  if (lexical === "failed") {
    if (hybrid === "pending") return { text: "text search is unavailable. finding related matches…", action: "search" };
    return { text: phase === "direct" ? "couldn’t finish searching your content." : "search couldn’t be completed.", action: "search" };
  }
  if (lexical === "pending" || (phase === null && !input.directFailed)) return {
    text: hybrid === "failed" ? "searching your content… related matches are unavailable." : "searching your content…", action: null,
  };
  if (input.directFailed) return { text: "search couldn’t be completed.", action: "search" };
  return { text: count ? "" : "no results found.", action: null };
}

export const SEARCH_ACTION_LABELS = {
  search: "retry search", related: "retry related matches", refresh: "refresh results",
} as const;
