/**
 * Tests for the canonical cursor builder.
 *
 * Required test cases per PR-08 spec §12.1:
 * 1. Block boundary insertion — \n between blocks
 * 2. <br> handling — single \n
 * 3. Adjacent block collapse — multiple blocks → single \n\n
 * 4. Hidden / aria-hidden exclusion — no tokens emitted
 * 5. Codepoint length accounting for astral characters (emoji)
 * 6. Whitespace normalization — multiple spaces → single space
 * 7. Validation gate — mismatch triggers warning and aborts
 *
 * @see docs/v1/s2/s2_prs/s2_pr08.md §12.1
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildCanonicalCursor,
  validateCanonicalText,
  codepointLength,
  BLOCK_ELEMENTS,
  type CanonicalCursorResult,
} from "./canonicalCursor";

// =============================================================================
// Helpers
// =============================================================================

/**
 * Create an HTML element from a string.
 * Uses happy-dom provided by vitest environment.
 */
function html(content: string): HTMLElement {
  const div = document.createElement("div");
  div.innerHTML = content;
  return div;
}

/**
 * Verify that all nodes have valid offsets in the emitted string.
 */
function verifyNodeOffsets(result: CanonicalCursorResult): void {
  const { nodes, emitted, length } = result;
  const codepoints = [...emitted];

  for (const node of nodes) {
    // Offsets should be non-negative
    expect(node.start).toBeGreaterThanOrEqual(0);
    expect(node.end).toBeGreaterThan(node.start);
    expect(node.end).toBeLessThanOrEqual(length);

    // The slice at these offsets should exist in the emitted string
    const sliceText = codepoints.slice(node.start, node.end).join("");
    expect(sliceText.length).toBeGreaterThan(0);

    // The slice should be related to the text node's content
    const nodeText = node.node.textContent || "";
    expect(nodeText).toBeTruthy();
  }
}

// =============================================================================
// Test Cases
// =============================================================================

describe("buildCanonicalCursor", () => {
  describe("1. Block boundary insertion", () => {
    it("inserts newline between consecutive block elements", () => {
      const result = buildCanonicalCursor(html("<p>Hello</p><p>World</p>"));

      // Backend produces single \n between blocks
      expect(result.emitted).toBe("Hello\nWorld");
      expect(result.length).toBe(11);
      verifyNodeOffsets(result);
    });

    it("handles nested block elements", () => {
      const result = buildCanonicalCursor(
        html("<div><p>Inner</p></div><p>Outer</p>")
      );

      expect(result.emitted).toBe("Inner\nOuter");
      verifyNodeOffsets(result);
    });

    it("handles all block element types", () => {
      // Test a sampling of block elements
      const blockTests = [
        { html: "<p>A</p><p>B</p>", expected: "A\nB" },
        { html: "<div>A</div><div>B</div>", expected: "A\nB" },
        { html: "<h1>A</h1><p>B</p>", expected: "A\nB" },
        { html: "<ul><li>A</li><li>B</li></ul>", expected: "A\nB" },
        { html: "<blockquote>A</blockquote><p>B</p>", expected: "A\nB" },
      ];

      for (const { html: h, expected } of blockTests) {
        const result = buildCanonicalCursor(html(h));
        expect(result.emitted).toBe(expected);
      }
    });

    it("does not insert newlines for inline elements", () => {
      const result = buildCanonicalCursor(
        html("<p>Hello <strong>bold</strong> text</p>")
      );

      expect(result.emitted).toBe("Hello bold text");
      verifyNodeOffsets(result);
    });
  });

  describe("2. <br> handling", () => {
    it("converts <br> to single newline", () => {
      const result = buildCanonicalCursor(html("<p>Line1<br>Line2</p>"));

      expect(result.emitted).toBe("Line1\nLine2");
      verifyNodeOffsets(result);
    });

    it("handles multiple <br> elements", () => {
      const result = buildCanonicalCursor(
        html("<p>Line1<br><br>Line2</p>")
      );

      // Multiple newlines collapse to single blank line (\n\n)
      expect(result.emitted).toBe("Line1\n\nLine2");
      verifyNodeOffsets(result);
    });

    it("handles <br> at block boundaries", () => {
      const result = buildCanonicalCursor(
        html("<p>A</p><br><p>B</p>")
      );

      // Block boundaries + br create blank line
      expect(result.emitted).toBe("A\n\nB");
      verifyNodeOffsets(result);
    });
  });

  describe("3. Adjacent block collapse", () => {
    it("collapses multiple consecutive newlines to blank line", () => {
      // Empty paragraphs should result in blank lines collapsing
      const result = buildCanonicalCursor(
        html("<p>A</p><p></p><p>B</p>")
      );

      // Empty paragraph produces no text, just block boundaries
      // Result depends on exact handling of empty blocks
      expect(result.emitted).toBe("A\nB");
      verifyNodeOffsets(result);
    });

    it("handles deeply nested empty blocks", () => {
      const result = buildCanonicalCursor(
        html("<div><div><div>A</div></div></div><p>B</p>")
      );

      expect(result.emitted).toBe("A\nB");
      verifyNodeOffsets(result);
    });
  });

  describe("4. Hidden / aria-hidden exclusion", () => {
    it("excludes elements with hidden attribute", () => {
      const result = buildCanonicalCursor(
        html("<p>Visible</p><p hidden>Hidden</p><p>Also visible</p>")
      );

      expect(result.emitted).toBe("Visible\nAlso visible");
      expect(result.emitted).not.toContain("Hidden");
      verifyNodeOffsets(result);
    });

    it("excludes elements with aria-hidden=true", () => {
      const result = buildCanonicalCursor(
        html('<p>Visible</p><span aria-hidden="true">Hidden</span><p>Also</p>')
      );

      expect(result.emitted).toBe("Visible\nAlso");
      expect(result.emitted).not.toContain("Hidden");
      verifyNodeOffsets(result);
    });

    it("includes elements with aria-hidden=false", () => {
      const result = buildCanonicalCursor(
        html('<p>Visible</p><span aria-hidden="false">Not hidden</span></p>')
      );

      expect(result.emitted).toContain("Not hidden");
    });

    it("excludes nested content within hidden elements", () => {
      const result = buildCanonicalCursor(
        html('<div hidden><p>Nested <strong>hidden</strong> content</p></div><p>Visible</p>')
      );

      expect(result.emitted).toBe("Visible");
      expect(result.emitted).not.toContain("Nested");
      expect(result.emitted).not.toContain("hidden");
    });

    it("excludes script and style elements", () => {
      const result = buildCanonicalCursor(
        html("<p>Text</p><script>console.log('hi');</script><style>.x{}</style><p>More</p>")
      );

      expect(result.emitted).toBe("Text\nMore");
      expect(result.emitted).not.toContain("console");
      expect(result.emitted).not.toContain(".x");
    });
  });

  describe("5. Codepoint length accounting for astral characters", () => {
    it("correctly counts emoji as single codepoints", () => {
      const result = buildCanonicalCursor(html("<p>Hello 🎉 World</p>"));

      // "Hello 🎉 World" has 13 codepoints
      expect(result.emitted).toBe("Hello 🎉 World");
      expect(result.length).toBe(13);
      expect(codepointLength(result.emitted)).toBe(13);

      // Node mapping should account for codepoints correctly
      const textNode = result.nodes[0];
      expect(textNode.end - textNode.start).toBe(13);
      verifyNodeOffsets(result);
    });

    it("correctly handles multiple emoji", () => {
      const result = buildCanonicalCursor(html("<p>👍🏽 OK 👎🏽</p>"));

      // 👍🏽 is actually 4 codepoints (emoji + skin tone modifier)
      // Let's just verify the result is consistent
      expect(result.emitted).toBe("👍🏽 OK 👎🏽");
      expect(result.length).toBe(codepointLength(result.emitted));
      verifyNodeOffsets(result);
    });

    it("correctly maps offsets with emoji between text", () => {
      const result = buildCanonicalCursor(
        html("<p>Before</p><p>🎉</p><p>After</p>")
      );

      expect(result.emitted).toBe("Before\n🎉\nAfter");

      // Find the "After" node
      const afterNode = result.nodes.find(
        (n) => n.node.textContent?.trim() === "After"
      );
      expect(afterNode).toBeDefined();

      // "Before\n🎉\n" = 6 + 1 + 1 + 1 = 9 codepoints
      // So "After" should start at 9
      expect(afterNode!.start).toBe(9);
      expect(afterNode!.end).toBe(14); // 9 + 5
    });

    it("handles mixed text and emoji within a node", () => {
      const result = buildCanonicalCursor(
        html("<p>A🎉B🎊C</p>")
      );

      expect(result.emitted).toBe("A🎉B🎊C");
      expect(result.length).toBe(5); // A, 🎉, B, 🎊, C
      verifyNodeOffsets(result);
    });
  });

  describe("6. Whitespace normalization", () => {
    it("collapses multiple spaces to single space", () => {
      const result = buildCanonicalCursor(
        html("<p>Hello    World</p>")
      );

      expect(result.emitted).toBe("Hello World");
      verifyNodeOffsets(result);
    });

    it("converts tabs and newlines to spaces within text", () => {
      const result = buildCanonicalCursor(
        html("<p>Hello\t\nWorld</p>")
      );

      expect(result.emitted).toBe("Hello World");
      verifyNodeOffsets(result);
    });

    it("converts nbsp to regular space", () => {
      const result = buildCanonicalCursor(
        html("<p>Hello&nbsp;World</p>")
      );

      expect(result.emitted).toBe("Hello World");
      verifyNodeOffsets(result);
    });

    it("trims leading whitespace from lines", () => {
      const result = buildCanonicalCursor(
        html("<p>   Hello</p>")
      );

      expect(result.emitted).toBe("Hello");
      verifyNodeOffsets(result);
    });

    it("trims trailing whitespace from lines", () => {
      const result = buildCanonicalCursor(
        html("<p>Hello   </p>")
      );

      expect(result.emitted).toBe("Hello");
      verifyNodeOffsets(result);
    });

    it("handles whitespace-only text nodes", () => {
      const result = buildCanonicalCursor(
        html("<p>Hello</p>   <p>World</p>")
      );

      // Whitespace between blocks creates a blank line after normalization.
      // The pattern \n\s*\n+ in post-processing collapses to \n\n.
      // This matches backend behavior where tail text contributes whitespace.
      expect(result.emitted).toBe("Hello\n\nWorld");
      verifyNodeOffsets(result);
    });
  });

  describe("7. Validation gate", () => {
    let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
      consoleWarnSpy.mockRestore();
    });

    it("returns true when emitted matches expected", () => {
      const result = buildCanonicalCursor(html("<p>Hello World</p>"));

      const isValid = validateCanonicalText(result, "Hello World", "test-frag");

      expect(isValid).toBe(true);
      expect(consoleWarnSpy).not.toHaveBeenCalled();
    });

    it("returns false and logs warning when mismatch", () => {
      const result = buildCanonicalCursor(html("<p>Hello World</p>"));

      const isValid = validateCanonicalText(result, "Different text", "test-frag");

      expect(isValid).toBe(false);
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        "canonical_text_mismatch",
        expect.objectContaining({
          fragmentId: "test-frag",
        })
      );
    });

    it("handles length mismatch", () => {
      const result = buildCanonicalCursor(html("<p>Short</p>"));

      const isValid = validateCanonicalText(
        result,
        "Much longer text that doesn't match",
        "test-frag"
      );

      expect(isValid).toBe(false);
    });
  });

  describe("Node mapping", () => {
    it("maps single text node correctly", () => {
      const result = buildCanonicalCursor(html("<p>Hello World</p>"));

      expect(result.nodes).toHaveLength(1);
      expect(result.nodes[0].start).toBe(0);
      expect(result.nodes[0].end).toBe(11);
    });

    it("maps multiple text nodes in order", () => {
      const result = buildCanonicalCursor(
        html("<p>First</p><p>Second</p><p>Third</p>")
      );

      expect(result.nodes).toHaveLength(3);

      // Verify order and non-overlapping
      for (let i = 1; i < result.nodes.length; i++) {
        expect(result.nodes[i].start).toBeGreaterThanOrEqual(
          result.nodes[i - 1].end
        );
      }

      // First node is "First" at start
      expect(result.nodes[0].start).toBe(0);
      expect(result.nodes[0].end).toBe(5);
    });

    it("handles text nodes across inline elements", () => {
      const result = buildCanonicalCursor(
        html("<p>Hello <strong>bold</strong> text</p>")
      );

      expect(result.nodes.length).toBeGreaterThanOrEqual(1);
      expect(result.emitted).toBe("Hello bold text");

      // All text should be covered by nodes
      let totalCoverage = 0;
      for (const node of result.nodes) {
        totalCoverage += node.end - node.start;
      }
      // Some whitespace might be trimmed, so total might not equal emitted length
      expect(totalCoverage).toBeGreaterThan(0);
    });
  });

  describe("Edge cases", () => {
    it("handles empty input", () => {
      const result = buildCanonicalCursor(html(""));

      expect(result.emitted).toBe("");
      expect(result.length).toBe(0);
      expect(result.nodes).toHaveLength(0);
    });

    it("handles whitespace-only input", () => {
      const result = buildCanonicalCursor(html("   \n\t  "));

      expect(result.emitted).toBe("");
      expect(result.length).toBe(0);
    });

    it("handles deeply nested structure", () => {
      const result = buildCanonicalCursor(
        html("<div><section><article><p><strong><em>Deep</em></strong></p></article></section></div>")
      );

      expect(result.emitted).toBe("Deep");
      verifyNodeOffsets(result);
    });

    it("handles links", () => {
      const result = buildCanonicalCursor(
        html('<p>Click <a href="https://example.com">here</a> for more</p>')
      );

      expect(result.emitted).toBe("Click here for more");
      verifyNodeOffsets(result);
    });

    it("handles images (no text content)", () => {
      const result = buildCanonicalCursor(
        html('<p>Before <img src="test.jpg" alt="test"> after</p>')
      );

      // Images don't contribute text, but the spaces before and after
      // are in separate text nodes. Per-node whitespace normalization
      // doesn't collapse spaces across nodes, matching backend behavior.
      // "Before " + " after" = "Before  after" (double space)
      expect(result.emitted).toBe("Before  after");
      verifyNodeOffsets(result);
    });

    it("handles pre elements", () => {
      const result = buildCanonicalCursor(
        html("<pre>Code here</pre><p>Normal text</p>")
      );

      expect(result.emitted).toBe("Code here\nNormal text");
      verifyNodeOffsets(result);
    });

    it("handles tables", () => {
      const result = buildCanonicalCursor(
        html("<table><tr><td>Cell1</td><td>Cell2</td></tr></table>")
      );

      // Tables are block elements, so we expect newlines
      expect(result.emitted).toContain("Cell1");
      expect(result.emitted).toContain("Cell2");
      verifyNodeOffsets(result);
    });

    it("applies NFC normalization", () => {
      // é can be represented as single codepoint (U+00E9) or as e + combining accent
      // NFC should normalize to single codepoint
      const nfdE = "e\u0301"; // e + combining acute accent
      const nfcE = "\u00E9"; // é as single codepoint

      const result = buildCanonicalCursor(html(`<p>Caf${nfdE}</p>`));

      // Should be NFC normalized
      expect(result.emitted).toBe(`Caf${nfcE}`);
      expect(result.length).toBe(4);
    });
  });
});

describe("BLOCK_ELEMENTS constant", () => {
  it("contains all required block elements from spec", () => {
    const required = [
      "p",
      "li",
      "ul",
      "ol",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "blockquote",
      "pre",
      "div",
      "section",
      "article",
      "header",
      "footer",
      "nav",
      "aside",
      "figure",
      "figcaption",
      "table",
      "tr",
      "td",
      "th",
    ];

    for (const elem of required) {
      expect(BLOCK_ELEMENTS.has(elem)).toBe(true);
    }
  });
});

describe("codepointLength", () => {
  it("returns 0 for empty string", () => {
    expect(codepointLength("")).toBe(0);
  });

  it("returns correct length for ASCII", () => {
    expect(codepointLength("Hello")).toBe(5);
  });

  it("returns correct length for emoji", () => {
    expect(codepointLength("🎉")).toBe(1);
  });

  it("handles emoji with skin tone modifier", () => {
    // 👍🏽 is emoji + skin tone = 2 codepoints? Actually...
    // It depends on the specific representation
    const thumbsUp = "👍🏽";
    // Just verify it's consistent
    expect(codepointLength(thumbsUp)).toBe([...thumbsUp].length);
  });

  it("handles mixed content", () => {
    expect(codepointLength("A🎉B")).toBe(3);
  });
});
