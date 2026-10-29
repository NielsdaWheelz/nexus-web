// Complete server phases share progress wording; their rows and scores never mix.
import type { PreviewPhase } from "./searchApi";
export type SearchProgress = {
  readonly kind: "Pending" | "Notice" | null;
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
  if (input.held) return { kind: "Notice", text: "search update ready", action: "refresh" };
  if (phase === "hybrid") return { kind: count ? null : "Notice", text: count ? "" : "no results found.", action: null };
  if (phase === "lexical") {
    if (hybrid === "pending") return {
      kind: "Pending", text: count ? "waiting for related matches…" : "no text matches found. waiting for related matches…", action: null,
    };
    if (hybrid === "failed") return {
      kind: "Notice", text: count ? "related matches are unavailable. text matches are still shown." : "no text matches found. related matches are unavailable.", action: "related",
    };
    return { kind: count ? null : "Notice", text: count ? "" : "no results found.", action: null };
  }
  if (lexical === "failed") {
    if (hybrid === "pending") return { kind: "Notice", text: "text search is unavailable. waiting for related matches…", action: "search" };
    return { kind: "Notice", text: phase === "direct" ? "couldn’t finish searching your content." : "search couldn’t be completed.", action: "search" };
  }
  if (lexical === "pending" || (phase === null && !input.directFailed)) return {
    kind: hybrid === "failed" ? "Notice" : "Pending", text: hybrid === "failed" ? "waiting for search results… related matches are unavailable." : "waiting for search results…", action: null,
  };
  if (input.directFailed) return { kind: "Notice", text: "search couldn’t be completed.", action: "search" };
  return { kind: count ? null : "Notice", text: count ? "" : "no results found.", action: null };
}

export const SEARCH_ACTION_LABELS = {
  search: "retry search", related: "retry related matches", refresh: "refresh results",
} as const;
