import { describe, expect, it } from "vitest";
import {
  buildDocentSteps,
  docentReducer,
  DOCENT_IDLE,
  extractCitingSentence,
} from "./docentWalk";
import type { CitationOut } from "@/lib/conversations/citationOut";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeCitation(
  ordinal: number,
  overrides: Partial<CitationOut> = {},
): CitationOut {
  return {
    ordinal,
    role: "supports",
    target_ref: { type: "evidence_span", id: `span-${ordinal}` },
    activation: {
      resourceRef: `evidence_span:span-${ordinal}`,
      kind: "route",
      href: `/media/m1#evidence-span-${ordinal}`,
      unresolvedReason: null,
    },
    media_id: "m1",
    locator: null,
    deep_link: `/media/m1#evidence-span-${ordinal}`,
    snapshot: { title: `Source ${ordinal}`, excerpt: null, section_label: null, result_type: null, summary_md: null },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// extractCitingSentence
// ---------------------------------------------------------------------------

describe("extractCitingSentence", () => {
  it("returns the sentence containing the marker", () => {
    const text = "First sentence. The evidence for stagnation is strongest [1] in recent data. Next sentence.";
    expect(extractCitingSentence(text, 1)).toBe(
      "The evidence for stagnation is strongest [1] in recent data.",
    );
  });

  it("returns null when ordinal is absent from text", () => {
    const text = "This text has no marker.";
    expect(extractCitingSentence(text, 1)).toBeNull();
  });

  it("handles marker at the very start of text", () => {
    const text = "[1] This is the beginning.";
    expect(extractCitingSentence(text, 1)).toBe("[1] This is the beginning.");
  });

  it("handles marker at the very end of text", () => {
    const text = "Final claim is here [1]";
    expect(extractCitingSentence(text, 1)).toBe("Final claim is here [1]");
  });

  it("returns the same sentence when two markers share it", () => {
    const text = "Both sources support this claim [1] and also this one [2].";
    const sentence = "Both sources support this claim [1] and also this one [2].";
    expect(extractCitingSentence(text, 1)).toBe(sentence);
    expect(extractCitingSentence(text, 2)).toBe(sentence);
  });

  it("returns null for a marker inside a code fence (inline code)", () => {
    // Odd backtick count before marker on the same line = inside inline code
    const text = "Here is code `foo[1]bar` and text.";
    expect(extractCitingSentence(text, 1)).toBeNull();
  });

  it("handles paragraph-break sentence boundaries (\\n\\n)", () => {
    const text = "First paragraph.\n\nSecond paragraph has the marker [1] here.\n\nThird paragraph.";
    expect(extractCitingSentence(text, 1)).toBe(
      "Second paragraph has the marker [1] here.",
    );
  });
});

// ---------------------------------------------------------------------------
// buildDocentSteps
// ---------------------------------------------------------------------------

describe("buildDocentSteps", () => {
  it("sorts citations by ordinal ascending", () => {
    const citations = [makeCitation(3), makeCitation(1), makeCitation(2)];
    const steps = buildDocentSteps(citations, "A [1] B [2] C [3].");
    expect(steps.map((s) => s.ordinal)).toEqual([1, 2, 3]);
  });

  it("passes through null href (deleted / unavailable source)", () => {
    const citations = [makeCitation(1, { deep_link: null })];
    const steps = buildDocentSteps(citations, "Claim [1].");
    // null href means the source is unavailable; DocentOverlay renders it struck-through
    expect(steps[0]?.href).toBeNull();
  });

  it("returns empty array for empty citations", () => {
    expect(buildDocentSteps([], "Some text.")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// docentReducer
// ---------------------------------------------------------------------------

describe("docentReducer", () => {
  const citations = [makeCitation(1), makeCitation(2), makeCitation(3)];
  const text = "A [1] B [2] C [3]";

  it("start builds steps and enters active at index 0", () => {
    const state = docentReducer(DOCENT_IDLE, {
      type: "start",
      citations,
      messageText: text,
    });
    expect(state.status).toBe("active");
    expect(state.index).toBe(0);
    expect(state.steps).toHaveLength(3);
  });

  it("next advances index", () => {
    const active = docentReducer(DOCENT_IDLE, {
      type: "start",
      citations,
      messageText: text,
    });
    const next = docentReducer(active, { type: "next" });
    expect(next.index).toBe(1);
    expect(next.status).toBe("active");
  });

  it("next transitions to complete at end of steps", () => {
    let state = docentReducer(DOCENT_IDLE, {
      type: "start",
      citations,
      messageText: text,
    });
    state = docentReducer(state, { type: "next" });
    state = docentReducer(state, { type: "next" });
    // now at index 2 (last step)
    state = docentReducer(state, { type: "next" });
    expect(state.status).toBe("complete");
  });

  it("prev decrements index", () => {
    let state = docentReducer(DOCENT_IDLE, {
      type: "start",
      citations,
      messageText: text,
    });
    state = docentReducer(state, { type: "next" });
    expect(state.index).toBe(1);
    state = docentReducer(state, { type: "prev" });
    expect(state.index).toBe(0);
    expect(state.status).toBe("active");
  });

  it("prev is a no-op at index 0", () => {
    const active = docentReducer(DOCENT_IDLE, {
      type: "start",
      citations,
      messageText: text,
    });
    const same = docentReducer(active, { type: "prev" });
    expect(same.index).toBe(0);
    expect(same).toBe(active);
  });

  it("leave returns DOCENT_IDLE from any state", () => {
    const active = docentReducer(DOCENT_IDLE, {
      type: "start",
      citations,
      messageText: text,
    });
    expect(docentReducer(active, { type: "leave" })).toEqual(DOCENT_IDLE);
    expect(docentReducer(DOCENT_IDLE, { type: "leave" })).toEqual(DOCENT_IDLE);
  });
});
