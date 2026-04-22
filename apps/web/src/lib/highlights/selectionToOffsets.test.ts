/**
 * Tests for selectionToOffsets module.
 *
 * These tests verify:
 * - UTF-16 to codepoint conversion (including emoji)
 * - Whitespace trimming
 * - Length validation
 * - Code block rejection
 *
 * Note: Some tests that require full Range API behavior are skipped in
 * the Vitest Browser Mode environment. Integration tests cover these scenarios.
 *
 * @see apps/web/README.md (Highlight Libraries / selectionToOffsets.ts)
 */

import { describe, it, expect } from "vitest";
import {
  selectionToOffsets,
  selectionIntersectsCodeBlock,
  utf16ToCodepoint,
  codepointToUtf16,
  codepointLength,
  MIN_HIGHLIGHT_LENGTH,
  MAX_HIGHLIGHT_LENGTH,
} from "./selectionToOffsets";
import { buildCanonicalCursor, type CanonicalCursorResult } from "./canonicalCursor";

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Create a DOM container with the given HTML and build its canonical cursor.
 */
function setupDOM(html: string): {
  container: HTMLDivElement;
  cursor: CanonicalCursorResult;
} {
  const container = document.createElement("div");
  container.innerHTML = html;
  document.body.appendChild(container);
  const cursor = buildCanonicalCursor(container);
  return { container, cursor };
}

/**
 * Clean up DOM after test.
 */
function cleanupDOM(container: HTMLDivElement): void {
  if (container.parentNode) {
    document.body.removeChild(container);
  }
}

// =============================================================================
// Unit Tests: UTF-16/Codepoint Conversion
// =============================================================================

describe("utf16ToCodepoint", () => {
  it("handles ASCII text correctly", () => {
    expect(utf16ToCodepoint("hello", 0)).toBe(0);
    expect(utf16ToCodepoint("hello", 3)).toBe(3);
    expect(utf16ToCodepoint("hello", 5)).toBe(5);
  });

  it("handles emoji (astral characters) correctly", () => {
    // "🎉" is a single codepoint but 2 UTF-16 code units
    const text = "Hello 🎉 World";
    // Positions: H(0) e(1) l(2) l(3) o(4) (space,5) 🎉(6-7) (space,8) W(9)...
    expect(utf16ToCodepoint(text, 0)).toBe(0); // Before H
    expect(utf16ToCodepoint(text, 6)).toBe(6); // Before emoji
    expect(utf16ToCodepoint(text, 8)).toBe(7); // After emoji (UTF-16 index 8 = codepoint 7)
    expect(utf16ToCodepoint(text, 9)).toBe(8); // W
  });

  it("handles multiple emoji", () => {
    const text = "🎉🎊🎈";
    expect(utf16ToCodepoint(text, 0)).toBe(0);
    expect(utf16ToCodepoint(text, 2)).toBe(1);
    expect(utf16ToCodepoint(text, 4)).toBe(2);
    expect(utf16ToCodepoint(text, 6)).toBe(3);
  });

  it("handles ZWJ sequences", () => {
    // "👨‍👩‍👧" is multiple codepoints
    const text = "👨‍👩‍👧";
    // This is: 👨 (2 UTF-16) + ZWJ (1) + 👩 (2) + ZWJ (1) + 👧 (2) = 8 UTF-16 units
    // But ~5 codepoints (depending on exact sequence)
    expect(utf16ToCodepoint(text, 0)).toBe(0);
    // The exact codepoint count depends on the sequence
    expect(utf16ToCodepoint(text, text.length)).toBe([...text].length);
  });
});

describe("codepointToUtf16", () => {
  it("handles ASCII text correctly", () => {
    expect(codepointToUtf16("hello", 0)).toBe(0);
    expect(codepointToUtf16("hello", 3)).toBe(3);
    expect(codepointToUtf16("hello", 5)).toBe(5);
  });

  it("handles emoji correctly", () => {
    const text = "Hello 🎉 World";
    expect(codepointToUtf16(text, 0)).toBe(0);
    expect(codepointToUtf16(text, 6)).toBe(6); // Before emoji
    expect(codepointToUtf16(text, 7)).toBe(8); // After emoji
    expect(codepointToUtf16(text, 8)).toBe(9); // W
  });
});

describe("codepointLength", () => {
  it("handles ASCII text", () => {
    expect(codepointLength("hello")).toBe(5);
  });

  it("handles emoji", () => {
    expect(codepointLength("🎉")).toBe(1);
    expect(codepointLength("Hello 🎉")).toBe(7);
  });
});

// =============================================================================
// Tests: MIN/MAX constants
// =============================================================================

describe("highlight length constants", () => {
  it("MIN_HIGHLIGHT_LENGTH is 2", () => {
    expect(MIN_HIGHLIGHT_LENGTH).toBe(2);
  });

  it("MAX_HIGHLIGHT_LENGTH is 2000", () => {
    expect(MAX_HIGHLIGHT_LENGTH).toBe(2000);
  });
});

// =============================================================================
// Tests: selectionIntersectsCodeBlock
// =============================================================================

describe("selectionIntersectsCodeBlock", () => {
  it("returns true when selection spans code block", () => {
    const { container, cursor } = setupDOM(
      "<p>Text <code>code</code> more</p>"
    );

    // Find the range that includes the code block
    const codeStart = cursor.emitted.indexOf("code");
    const codeEnd = codeStart + 4;

    const result = selectionIntersectsCodeBlock(cursor, codeStart, codeEnd);
    expect(result).toBe(true);

    cleanupDOM(container);
  });

  it("returns false when selection is outside code block", () => {
    const { container, cursor } = setupDOM(
      "<p>Normal text <code>code</code> more text</p>"
    );

    // Select just "Normal"
    const result = selectionIntersectsCodeBlock(cursor, 0, 6);
    expect(result).toBe(false);

    cleanupDOM(container);
  });

  it("returns true for selection inside pre block", () => {
    const { container, cursor } = setupDOM(
      "<p>Text</p><pre>preformatted</pre>"
    );

    const preStart = cursor.emitted.indexOf("preformatted");
    const preEnd = preStart + 4;

    const result = selectionIntersectsCodeBlock(cursor, preStart, preEnd);
    expect(result).toBe(true);

    cleanupDOM(container);
  });

  it("returns false for empty cursor nodes", () => {
    const cursor: CanonicalCursorResult = {
      nodes: [],
      emitted: "",
      length: 0,
    };

    const result = selectionIntersectsCodeBlock(cursor, 0, 10);
    expect(result).toBe(false);
  });
});

// =============================================================================
// Tests: Whitespace Trimming Logic (unit tests without Range)
// =============================================================================

describe("whitespace trimming logic", () => {
  // These test the pure functions that would be used in trimming

  it("findFirstNonWhitespace returns correct index", () => {
    // Test the logic that would be in findFirstNonWhitespace
    const findFirst = (text: string): number => {
      const codepoints = [...text];
      for (let i = 0; i < codepoints.length; i++) {
        if (!/\s/.test(codepoints[i])) {
          return i;
        }
      }
      return codepoints.length;
    };

    expect(findFirst("hello")).toBe(0);
    expect(findFirst("  hello")).toBe(2);
    expect(findFirst("   ")).toBe(3);
    expect(findFirst("")).toBe(0);
  });

  it("findLastNonWhitespace returns correct index", () => {
    const findLast = (text: string): number => {
      const codepoints = [...text];
      for (let i = codepoints.length - 1; i >= 0; i--) {
        if (!/\s/.test(codepoints[i])) {
          return i + 1;
        }
      }
      return 0;
    };

    expect(findLast("hello")).toBe(5);
    expect(findLast("hello  ")).toBe(5);
    expect(findLast("   ")).toBe(0);
    expect(findLast("")).toBe(0);
  });
});

// =============================================================================
// Tests: Canonical Cursor Building (verification)
// =============================================================================

describe("canonical cursor building for selection tests", () => {
  it("builds cursor from simple HTML", () => {
    const { container, cursor } = setupDOM("<p>Hello World</p>");

    expect(cursor.emitted).toBe("Hello World");
    expect(cursor.length).toBe(11);
    expect(cursor.nodes.length).toBeGreaterThan(0);

    cleanupDOM(container);
  });

  it("builds cursor with emoji correctly", () => {
    const { container, cursor } = setupDOM("<p>Hello 🎉 World</p>");

    // The text should contain the emoji
    expect(cursor.emitted).toContain("🎉");
    // Verify emoji is counted as 1 codepoint
    expect(codepointLength("🎉")).toBe(1);
    // Verify the length matches the emitted string's codepoint count
    expect(cursor.length).toBe(codepointLength(cursor.emitted));

    cleanupDOM(container);
  });

  it("builds cursor spanning multiple blocks", () => {
    const { container, cursor } = setupDOM(
      "<p>First paragraph</p><p>Second paragraph</p>"
    );

    expect(cursor.emitted).toContain("First paragraph");
    expect(cursor.emitted).toContain("Second paragraph");
    // Should have newlines between blocks
    expect(cursor.emitted).toContain("\n");

    cleanupDOM(container);
  });
});

// =============================================================================
// Tests: Selection Validation Logic
// =============================================================================

describe("selection validation logic", () => {
  it("validates minimum length correctly", () => {
    const isLengthValid = (length: number): boolean => {
      return length >= MIN_HIGHLIGHT_LENGTH && length <= MAX_HIGHLIGHT_LENGTH;
    };

    expect(isLengthValid(1)).toBe(false);
    expect(isLengthValid(2)).toBe(true);
    expect(isLengthValid(100)).toBe(true);
    expect(isLengthValid(2000)).toBe(true);
    expect(isLengthValid(2001)).toBe(false);
  });

  it("validates non-empty selection after trim", () => {
    const isValidAfterTrim = (text: string): boolean => {
      return text.trim().length > 0;
    };

    expect(isValidAfterTrim("hello")).toBe(true);
    expect(isValidAfterTrim("  hello  ")).toBe(true);
    expect(isValidAfterTrim("   ")).toBe(false);
    expect(isValidAfterTrim("")).toBe(false);
  });
});

// =============================================================================
// Integration Tests: selectionToOffsets() with real Range boundaries
// =============================================================================

describe("selectionToOffsets integration", () => {
  it("maps paragraph-start selection when startContainer is an element boundary", () => {
    const { container, cursor } = setupDOM("<p>Alpha beta</p>");
    const paragraph = container.querySelector("p");
    const textNode = paragraph?.firstChild;
    if (!paragraph || !(textNode instanceof Text)) {
      throw new Error("Expected paragraph text node");
    }

    const range = document.createRange();
    range.setStart(paragraph, 0); // Element boundary at paragraph start
    range.setEnd(textNode, 5); // "Alpha"

    const result = selectionToOffsets(range, cursor, cursor.emitted, false);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.startOffset).toBe(0);
      expect(result.endOffset).toBe(5);
      expect(result.selectedText).toBe("Alpha");
    }

    cleanupDOM(container);
  });

  it("maps selection when startContainer is a whitespace-only text node", () => {
    const { container, cursor } = setupDOM("  \n\t<p>Alpha beta</p>");
    const whitespaceNode = container.firstChild;
    const paragraph = container.querySelector("p");
    const textNode = paragraph?.firstChild;
    if (!(whitespaceNode instanceof Text) || !paragraph || !(textNode instanceof Text)) {
      throw new Error("Expected whitespace node and paragraph text node");
    }

    const range = document.createRange();
    range.setStart(whitespaceNode, 0);
    range.setEnd(textNode, 5); // "Alpha"

    const result = selectionToOffsets(range, cursor, cursor.emitted, false);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.startOffset).toBe(0);
      expect(result.endOffset).toBe(5);
      expect(result.selectedText).toBe("Alpha");
    }

    cleanupDOM(container);
  });

  it("maps selection when endContainer is an element boundary", () => {
    const { container, cursor } = setupDOM("<p>Alpha beta</p>");
    const paragraph = container.querySelector("p");
    const textNode = paragraph?.firstChild;
    if (!paragraph || !(textNode instanceof Text)) {
      throw new Error("Expected paragraph text node");
    }

    const range = document.createRange();
    range.setStart(textNode, 6); // "beta"
    range.setEnd(paragraph, 1); // Element boundary after the only text child

    const result = selectionToOffsets(range, cursor, cursor.emitted, false);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.startOffset).toBe(6);
      expect(result.endOffset).toBe(10);
      expect(result.selectedText).toBe("beta");
    }

    cleanupDOM(container);
  });

  it("returns OUTSIDE_CONTENT for selection that starts outside rendered content", () => {
    const { container, cursor } = setupDOM("<p>Alpha beta</p>");
    const outside = document.createElement("div");
    outside.textContent = "Outside content";
    document.body.appendChild(outside);
    const outsideText = outside.firstChild;
    if (!(outsideText instanceof Text)) {
      throw new Error("Expected outside text node");
    }

    const range = document.createRange();
    range.setStart(outsideText, 0);
    range.setEnd(outsideText, 7);

    const result = selectionToOffsets(range, cursor, cursor.emitted, false);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe("OUTSIDE_CONTENT");
      expect(result.message).toBe("Selection start is outside rendered content.");
    }

    if (outside.parentNode) {
      outside.parentNode.removeChild(outside);
    }
    cleanupDOM(container);
  });
});
