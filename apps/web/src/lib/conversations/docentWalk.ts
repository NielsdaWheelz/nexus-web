import type { CitationOut } from "@/lib/conversations/citationOut";

export interface DocentStep {
  ordinal: number;
  /** citation.snapshot?.title ?? "Untitled source" */
  title: string;
  /** citation.deep_link; null = unrouteable/deleted */
  href: string | null;
  /** Sentence containing [ordinal] in message text; null if not found or in code. */
  citingSentence: string | null;
}

export type DocentWalkStatus = "idle" | "active" | "complete";

export interface DocentWalkState {
  steps: readonly DocentStep[];
  /** 0-based current step; only meaningful when status = 'active'. */
  index: number;
  status: DocentWalkStatus;
  /**
   * Increments on every 'start'. Lets the pane-driving effect re-fire when a
   * new walk begins at the same (status, index) — e.g. Walk on a second message
   * while already sitting on step 1 of the first.
   */
  epoch: number;
}

export type DocentAction =
  | { type: "start"; citations: CitationOut[]; messageText: string }
  | { type: "next" }
  | { type: "prev" }
  | { type: "leave" };

export const DOCENT_IDLE: DocentWalkState = {
  steps: [],
  index: 0,
  status: "idle",
  epoch: 0,
};

/**
 * Extracts the sentence containing [ordinal] from message prose text.
 *
 * Returns null when: the marker is absent, inside a code fence (odd backtick
 * count before it on the same line), or the extracted slice is empty.
 */
export function extractCitingSentence(text: string, ordinal: number): string | null {
  const markerRegex = new RegExp(`\\[${ordinal}\\](?!\\()`, "g");
  const match = markerRegex.exec(text);
  if (!match) return null;

  const markerPos = match.index;

  // Code fence guard: count backticks before the marker on the same line.
  // An odd count means the marker is inside an inline code span.
  const lineStart = text.lastIndexOf("\n", markerPos - 1) + 1;
  const lineUpToMarker = text.slice(lineStart, markerPos);
  const backtickCount = (lineUpToMarker.match(/`/g) ?? []).length;
  if (backtickCount % 2 !== 0) return null;

  // Scan backward to nearest sentence boundary: ". ", ".\n", "\n\n", or string start.
  let sentenceStart = 0;
  for (const boundary of [". ", ".\n", "\n\n"]) {
    const pos = text.lastIndexOf(boundary, markerPos - 1);
    if (pos !== -1) {
      const candidate = pos + boundary.length;
      if (candidate > sentenceStart) sentenceStart = candidate;
    }
  }

  // Scan forward to next sentence boundary or string end.
  // For ". " and ".\n", include the period (pos + 1). For "\n\n", exclude it (pos).
  let sentenceEnd = text.length;
  for (const boundary of [". ", ".\n", "\n\n"]) {
    const pos = text.indexOf(boundary, markerPos);
    if (pos !== -1) {
      const candidate = boundary === "\n\n" ? pos : pos + 1;
      if (candidate < sentenceEnd) sentenceEnd = candidate;
    }
  }

  return text.slice(sentenceStart, sentenceEnd).trim() || null;
}

/** Builds ordered DocentStep[] from the message's citation array and text. */
export function buildDocentSteps(
  citations: CitationOut[],
  messageText: string,
): DocentStep[] {
  return [...citations]
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((c) => ({
      ordinal: c.ordinal,
      title: c.snapshot?.title ?? "Untitled source",
      href: c.deep_link,
      citingSentence: extractCitingSentence(messageText, c.ordinal),
    }));
}

export function docentReducer(
  state: DocentWalkState,
  action: DocentAction,
): DocentWalkState {
  switch (action.type) {
    case "start": {
      const steps = buildDocentSteps(action.citations, action.messageText);
      return { steps, index: 0, status: "active", epoch: state.epoch + 1 };
    }
    case "next": {
      if (state.status !== "active") return state;
      if (state.index + 1 >= state.steps.length) {
        return { ...state, status: "complete" };
      }
      return { ...state, index: state.index + 1 };
    }
    case "prev": {
      if (state.status !== "active") return state;
      if (state.index === 0) return state;
      return { ...state, index: state.index - 1 };
    }
    case "leave": {
      return DOCENT_IDLE;
    }
  }
}
