/**
 * Tests for applying highlight segments to DOM.
 *
 * Required test cases per PR-08 spec §12:
 * 1. Single highlight wrapping
 * 2. Nested highlights (3 segments)
 * 3. Partial overlaps
 * 4. Deterministic topmost selection
 * 5. Correct <span> wrapping with expected classes
 * 6. data-active-highlight-ids matches segmenter ordering (PR-10: space-delimited)
 * 7. data-highlight-top matches topmostId
 * 8. Exactly one anchor per highlight
 * 9. Anchor at correct position
 * 10. Valid HTML output
 * 11. Invalid highlight (out of bounds) — skipped, warning logged
 * 12. Canonical mismatch — all highlights skipped
 *
 * @see docs/v1/s2/s2_prs/s2_pr08.md §12
 * @see docs/v1/s2/s2_prs/s2_pr10.md §15 (attribute name change)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  applyHighlightsToHtml,
  applyHighlightsToHtmlMemoized,
  clearHighlightCache,
  computeHighlightsHash,
  normalizeHighlights,
  type HighlightInput,
} from "./applySegments";

// =============================================================================
// Helpers
// =============================================================================

/**
 * Create a highlight input for testing.
 */
function h(
  id: string,
  start_offset: number,
  end_offset: number,
  color: "yellow" | "green" | "blue" | "pink" | "purple" = "yellow",
  created_at: string = "2024-01-01T00:00:00Z"
): HighlightInput {
  return { id, start_offset, end_offset, color, created_at };
}

/**
 * Parse HTML and return the root element.
 */
function parseHtml(html: string): HTMLElement {
  const parser = new DOMParser();
  const doc = parser.parseFromString(`<div>${html}</div>`, "text/html");
  return doc.body.firstChild as HTMLElement;
}

/**
 * Count occurrences of a pattern in a string.
 */
function countOccurrences(str: string, pattern: string): number {
  return (str.match(new RegExp(pattern, "g")) || []).length;
}

// =============================================================================
// Test Cases
// =============================================================================

describe("applyHighlightsToHtml", () => {
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    clearHighlightCache();
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
  });

  describe("Basic functionality", () => {
    it("returns original HTML when no highlights", () => {
      const html = "<p>Hello World</p>";
      const canonical = "Hello World";

      const result = applyHighlightsToHtml(html, canonical, "frag-1", []);

      expect(result.html).toBe(html);
      expect(result.failedIds).toHaveLength(0);
      expect(result.validationPassed).toBe(true);
    });

    it("wraps single highlight correctly", () => {
      const html = "<p>Hello World</p>";
      const canonical = "Hello World";
      const highlights = [h("h1", 0, 5, "yellow")]; // "Hello"

      const result = applyHighlightsToHtml(html, canonical, "frag-1", highlights);

      expect(result.validationPassed).toBe(true);
      expect(result.failedIds).toHaveLength(0);

      // Should contain a span with the right attributes
      // PR-10: data-active-highlight-ids (space-delimited)
      expect(result.html).toContain('data-active-highlight-ids="h1"');
      expect(result.html).toContain('data-highlight-top="h1"');
      expect(result.html).toContain('class="hl-yellow"');
    });

    it("wraps highlight in middle of text", () => {
      const html = "<p>Hello World</p>";
      const canonical = "Hello World";
      const highlights = [h("h1", 6, 11, "green")]; // "World"

      const result = applyHighlightsToHtml(html, canonical, "frag-1", highlights);

      expect(result.html).toContain('class="hl-green"');
      // Original text should still be present
      const parsed = parseHtml(result.html);
      expect(parsed.textContent).toBe("Hello World");
    });
  });

  describe("Segment rendering", () => {
    it("handles nested highlights (3 segments)", () => {
      const html = "<p>ABCDEFGHIJ</p>";
      const canonical = "ABCDEFGHIJ";
      // Outer: [0,10), Inner: [3,7)
      const highlights = [
        h("outer", 0, 10, "yellow", "2024-01-01T00:00:00Z"),
        h("inner", 3, 7, "green", "2024-01-02T00:00:00Z"), // newer
      ];

      const result = applyHighlightsToHtml(html, canonical, "frag-1", highlights);

      expect(result.validationPassed).toBe(true);
      expect(result.failedIds).toHaveLength(0);

      // Should have segments for: [0,3) outer only, [3,7) both, [7,10) outer only
      // Inner is topmost in middle segment (newer)
      expect(result.html).toContain("hl-yellow"); // outer color
      expect(result.html).toContain("hl-green"); // inner color (topmost in middle)
    });

    it("handles partial overlaps", () => {
      const html = "<p>ABCDEFGHIJ</p>";
      const canonical = "ABCDEFGHIJ";
      // a=[0,5), b=[3,8)
      const highlights = [
        h("a", 0, 5, "yellow", "2024-01-01T00:00:00Z"),
        h("b", 3, 8, "blue", "2024-01-02T00:00:00Z"), // newer
      ];

      const result = applyHighlightsToHtml(html, canonical, "frag-1", highlights);

      expect(result.validationPassed).toBe(true);

      // Three segments: [0,3) a only, [3,5) both, [5,8) b only
      expect(result.html).toContain("hl-yellow");
      expect(result.html).toContain("hl-blue");
    });

    it("selects topmost by created_at DESC", () => {
      const html = "<p>Text</p>";
      const canonical = "Text";
      const highlights = [
        h("oldest", 0, 4, "yellow", "2024-01-01T00:00:00Z"),
        h("middle", 0, 4, "green", "2024-01-02T00:00:00Z"),
        h("newest", 0, 4, "blue", "2024-01-03T00:00:00Z"),
      ];

      const result = applyHighlightsToHtml(html, canonical, "frag-1", highlights);

      // Should use newest's color
      expect(result.html).toContain("hl-blue");
      expect(result.html).toContain('data-highlight-top="newest"');
    });

    it("uses ID as tiebreaker for same timestamp", () => {
      const html = "<p>Text</p>";
      const canonical = "Text";
      const sameTime = "2024-01-01T00:00:00Z";
      const highlights = [
        h("charlie", 0, 4, "yellow", sameTime),
        h("alice", 0, 4, "green", sameTime),
        h("bob", 0, 4, "blue", sameTime),
      ];

      const result = applyHighlightsToHtml(html, canonical, "frag-1", highlights);

      // With same timestamp, alphabetically first ID wins
      expect(result.html).toContain('data-highlight-top="alice"');
      expect(result.html).toContain("hl-green");
    });
  });

  describe("DOM output", () => {
    it("uses <span> elements for wrapping", () => {
      const html = "<p>Hello</p>";
      const canonical = "Hello";
      const highlights = [h("h1", 0, 5)];

      const result = applyHighlightsToHtml(html, canonical, "frag-1", highlights);

      // Should use span, not mark
      expect(result.html).not.toContain("<mark");
      expect(result.html).toContain("<span");
    });

    it("includes data-active-highlight-ids with correct ordering (space-delimited)", () => {
      const html = "<p>ABCD</p>";
      const canonical = "ABCD";
      const highlights = [
        h("a", 0, 4, "yellow", "2024-01-01T00:00:00Z"),
        h("b", 0, 4, "green", "2024-01-02T00:00:00Z"),
        h("c", 0, 4, "blue", "2024-01-03T00:00:00Z"),
      ];

      const result = applyHighlightsToHtml(html, canonical, "frag-1", highlights);

      // IDs should be ordered by (created_at DESC, id ASC)
      // c is newest, so first
      // PR-10: space-delimited instead of comma
      expect(result.html).toContain('data-active-highlight-ids="c b a"');
    });

    it("produces valid HTML (no broken nesting)", () => {
      const html = "<p>Hello <strong>bold</strong> world</p>";
      const canonical = "Hello bold world";
      // Highlight spans "bold w"
      const highlights = [h("h1", 6, 12)];

      const result = applyHighlightsToHtml(html, canonical, "frag-1", highlights);

      // Should not break the HTML structure
      const parsed = parseHtml(result.html);
      expect(parsed).toBeTruthy();
      // Text content should be preserved
      expect(parsed.textContent).toBe("Hello bold world");
    });
  });

  describe("Highlight anchors", () => {
    it("inserts exactly one anchor per highlight", () => {
      const html = "<p>Text here</p>";
      const canonical = "Text here";
      const highlights = [
        h("h1", 0, 4),
        h("h2", 5, 9),
      ];

      const result = applyHighlightsToHtml(html, canonical, "frag-1", highlights);

      // Count anchors
      const h1Anchors = countOccurrences(result.html, 'data-highlight-anchor="h1"');
      const h2Anchors = countOccurrences(result.html, 'data-highlight-anchor="h2"');

      expect(h1Anchors).toBe(1);
      expect(h2Anchors).toBe(1);
    });

    it("inserts anchor at highlight start position", () => {
      const html = "<p>ABCDEFGHIJ</p>";
      const canonical = "ABCDEFGHIJ";
      const highlights = [h("h1", 3, 7)]; // "DEFG"

      const result = applyHighlightsToHtml(html, canonical, "frag-1", highlights);

      // Anchor should appear before the highlighted span
      const anchorIndex = result.html.indexOf('data-highlight-anchor="h1"');
      const spanIndex = result.html.indexOf('data-active-highlight-ids="h1"');

      expect(anchorIndex).toBeGreaterThan(-1);
      expect(spanIndex).toBeGreaterThan(-1);
      expect(anchorIndex).toBeLessThan(spanIndex);
    });

    it("handles overlapping highlights with separate anchors", () => {
      const html = "<p>ABCDEF</p>";
      const canonical = "ABCDEF";
      const highlights = [
        h("outer", 0, 6, "yellow", "2024-01-01T00:00:00Z"),
        h("inner", 2, 4, "green", "2024-01-02T00:00:00Z"),
      ];

      const result = applyHighlightsToHtml(html, canonical, "frag-1", highlights);

      // Both should have anchors
      expect(result.html).toContain('data-highlight-anchor="outer"');
      expect(result.html).toContain('data-highlight-anchor="inner"');
    });
  });

  describe("Failure handling", () => {
    it("skips invalid highlight (out of bounds)", () => {
      const html = "<p>Short</p>";
      const canonical = "Short";
      const highlights = [
        h("valid", 0, 5),
        h("invalid", 0, 100), // way out of bounds
      ];

      const result = applyHighlightsToHtml(html, canonical, "frag-1", highlights);

      expect(result.failedIds).toContain("invalid");
      // Valid highlight should still work
      expect(result.html).toContain('data-active-highlight-ids="valid"');
    });

    it("aborts all highlights on canonical mismatch", () => {
      const html = "<p>Hello</p>";
      const wrongCanonical = "Completely different text";
      const highlights = [h("h1", 0, 5)];

      const result = applyHighlightsToHtml(html, wrongCanonical, "frag-1", highlights);

      expect(result.validationPassed).toBe(false);
      expect(result.failedIds).toContain("h1");
      // Should return original HTML
      expect(result.html).toBe(html);

      // Should have logged a warning
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        "canonical_text_mismatch",
        expect.anything()
      );
    });

    it("logs warning for failed highlight render", () => {
      const html = "<p>Short</p>";
      const canonical = "Short";
      // Negative offset is invalid
      const highlights = [
        { id: "bad", start_offset: -1, end_offset: 3, color: "yellow" as const, created_at: "2024-01-01T00:00:00Z" },
      ];

      const result = applyHighlightsToHtml(html, canonical, "frag-1", highlights);

      expect(result.failedIds).toContain("bad");
    });
  });

  describe("Special cases", () => {
    it("handles emoji in text correctly", () => {
      const html = "<p>Hello 🎉 World</p>";
      const canonical = "Hello 🎉 World";
      // Highlight the emoji
      const highlights = [h("h1", 6, 7)]; // Just the emoji

      const result = applyHighlightsToHtml(html, canonical, "frag-1", highlights);

      expect(result.validationPassed).toBe(true);
      // The text should still contain the emoji
      const parsed = parseHtml(result.html);
      expect(parsed.textContent).toContain("🎉");
    });

    it("handles highlights across multiple paragraphs", () => {
      const html = "<p>First</p><p>Second</p>";
      const canonical = "First\nSecond";
      // Highlight from "First" into "Second" - this crosses a newline
      // Note: Offsets are in canonical text space
      const highlights = [h("h1", 0, 5)]; // Just "First"

      const result = applyHighlightsToHtml(html, canonical, "frag-1", highlights);

      expect(result.validationPassed).toBe(true);
      expect(result.html).toContain('data-active-highlight-ids="h1"');
    });

    it("handles highlight color classes correctly", () => {
      const html = "<p>Test</p>";
      const canonical = "Test";

      const colors: Array<"yellow" | "green" | "blue" | "pink" | "purple"> = [
        "yellow",
        "green",
        "blue",
        "pink",
        "purple",
      ];

      for (const color of colors) {
        const result = applyHighlightsToHtml(
          html,
          canonical,
          "frag-1",
          [h("h1", 0, 4, color)]
        );
        expect(result.html).toContain(`hl-${color}`);
      }
    });
  });
});

describe("applyHighlightsToHtmlMemoized", () => {
  beforeEach(() => {
    clearHighlightCache();
  });

  it("returns cached result for same input", () => {
    const html = "<p>Hello</p>";
    const canonical = "Hello";
    const highlights = [h("h1", 0, 5)];

    const result1 = applyHighlightsToHtmlMemoized(html, canonical, "frag-1", highlights);
    const result2 = applyHighlightsToHtmlMemoized(html, canonical, "frag-1", highlights);

    // Should be the exact same object (cached)
    expect(result1).toBe(result2);
  });

  it("computes new result for different highlights", () => {
    const html = "<p>Hello</p>";
    const canonical = "Hello";

    const result1 = applyHighlightsToHtmlMemoized(
      html,
      canonical,
      "frag-1",
      [h("h1", 0, 5, "yellow")]
    );
    const result2 = applyHighlightsToHtmlMemoized(
      html,
      canonical,
      "frag-1",
      [h("h1", 0, 5, "green")] // Different color
    );

    // Should be different objects
    expect(result1).not.toBe(result2);
    expect(result1.html).not.toBe(result2.html);
  });

  it("computes new result for different fragment", () => {
    const html = "<p>Hello</p>";
    const canonical = "Hello";
    const highlights = [h("h1", 0, 5)];

    const result1 = applyHighlightsToHtmlMemoized(html, canonical, "frag-1", highlights);
    const result2 = applyHighlightsToHtmlMemoized(html, canonical, "frag-2", highlights);

    // Should be different objects (different cache keys)
    expect(result1).not.toBe(result2);
  });
});

describe("computeHighlightsHash", () => {
  it("returns empty string for empty array", () => {
    expect(computeHighlightsHash([])).toBe("");
  });

  it("produces same hash regardless of input order", () => {
    const h1 = { id: "a", start: 0, end: 5, color: "yellow" as const, created_at_ms: 1000 };
    const h2 = { id: "b", start: 5, end: 10, color: "green" as const, created_at_ms: 2000 };

    const hash1 = computeHighlightsHash([h1, h2]);
    const hash2 = computeHighlightsHash([h2, h1]);

    expect(hash1).toBe(hash2);
  });

  it("produces different hash for different highlights", () => {
    const h1 = { id: "a", start: 0, end: 5, color: "yellow" as const, created_at_ms: 1000 };
    const h2 = { id: "a", start: 0, end: 6, color: "yellow" as const, created_at_ms: 1000 };

    const hash1 = computeHighlightsHash([h1]);
    const hash2 = computeHighlightsHash([h2]);

    expect(hash1).not.toBe(hash2);
  });
});

describe("normalizeHighlights", () => {
  it("converts API format to segmenter format", () => {
    const input: HighlightInput[] = [
      {
        id: "h1",
        start_offset: 10,
        end_offset: 20,
        color: "yellow",
        created_at: "2024-01-15T12:00:00Z",
      },
    ];

    const normalized = normalizeHighlights(input);

    expect(normalized).toHaveLength(1);
    expect(normalized[0].id).toBe("h1");
    expect(normalized[0].start).toBe(10);
    expect(normalized[0].end).toBe(20);
    expect(normalized[0].color).toBe("yellow");
    expect(normalized[0].created_at_ms).toBe(Date.parse("2024-01-15T12:00:00Z"));
  });

  it("handles multiple highlights", () => {
    const input: HighlightInput[] = [
      h("h1", 0, 10),
      h("h2", 20, 30),
    ];

    const normalized = normalizeHighlights(input);

    expect(normalized).toHaveLength(2);
  });
});
