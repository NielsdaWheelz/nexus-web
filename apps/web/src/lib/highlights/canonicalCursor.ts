/**
 * Canonical Cursor Builder for highlight offset mapping.
 *
 * This module builds a deterministic mapping from DOM text nodes to
 * codepoint offsets in the canonical text. It MUST match the backend
 * canonicalization rules exactly (python/nexus/services/canonicalize.py).
 *
 * The canonical cursor is used by:
 * - PR-08: Read-only highlight rendering
 * - PR-09: Selection-based highlight creation
 *
 * @see docs/v1/s2/s2_prs/s2_pr08.md §5
 */

// =============================================================================
// Types
// =============================================================================

/**
 * A text node with its position in canonical text space.
 */
export type CanonicalNode = {
  node: Text;
  start: number; // codepoint offset in emitted string (inclusive)
  end: number; // codepoint offset in emitted string (exclusive)
};

/**
 * Result of building the canonical cursor.
 */
export type CanonicalCursorResult = {
  nodes: CanonicalNode[];
  emitted: string; // the reconstructed canonical text
  length: number; // codepoint length of emitted
};

// =============================================================================
// Constants (must match backend exactly)
// =============================================================================

/**
 * Block-level elements that introduce line breaks.
 * MUST match python/nexus/services/canonicalize.py BLOCK_ELEMENTS
 */
export const BLOCK_ELEMENTS = new Set([
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
]);

/**
 * Elements to skip entirely (including their content).
 * MUST match python/nexus/services/canonicalize.py SKIP_ELEMENTS
 */
const SKIP_ELEMENTS = new Set(["script", "style", "noscript", "template"]);

// =============================================================================
// Helpers
// =============================================================================

/**
 * Check if an element should be hidden (has hidden attr or aria-hidden="true").
 */
function isHidden(element: Element): boolean {
  if (element.hasAttribute("hidden")) {
    return true;
  }
  const ariaHidden = element.getAttribute("aria-hidden");
  if (ariaHidden?.toLowerCase() === "true") {
    return true;
  }
  return false;
}

/**
 * Normalize whitespace in text: map all Unicode whitespace (including nbsp)
 * to space, collapse consecutive spaces to single space.
 *
 * Note: This DOES NOT trim - trimming happens at the final string level.
 */
function normalizeWhitespace(text: string): string {
  if (!text) return "";
  // Replace all Unicode whitespace (including \u00a0 nbsp) with space
  // Then collapse consecutive spaces
  return text.replace(/[\s\u00a0]+/g, " ");
}

/**
 * Get codepoint length of a string.
 * This handles astral characters (emoji, etc.) correctly.
 */
export function codepointLength(str: string): number {
  return [...str].length;
}

/**
 * Normalize a string to NFC form.
 */
function normalizeNFC(str: string): string {
  return str.normalize("NFC");
}

// =============================================================================
// Part Collector (matches backend algorithm)
// =============================================================================

/**
 * Part with optional source text node.
 * We track source nodes for TEXT parts to enable offset mapping.
 */
type Part = {
  text: string;
  sourceNode?: Text;
};

/**
 * Walk a DOM tree and collect parts following backend algorithm exactly.
 *
 * The backend algorithm (from canonicalize.py):
 * 1. Add newline before block elements if parts exist and last part isn't newline
 * 2. Process element text content
 * 3. Recursively process children
 * 4. Add newline after block elements if parts exist and last part isn't newline
 * 5. Handle <br> as newline
 * 6. Skip hidden and script/style elements entirely
 */
function collectParts(root: Element): Part[] {
  const parts: Part[] = [];

  function getLastPartChar(): string {
    if (parts.length === 0) return "";
    const lastPart = parts[parts.length - 1];
    return lastPart.text.slice(-1);
  }

  function walkElement(element: Element): void {
    const tagName = element.tagName.toLowerCase();

    // Skip hidden elements entirely
    if (isHidden(element)) {
      return;
    }

    // Skip script/style/noscript/template entirely
    if (SKIP_ELEMENTS.has(tagName)) {
      return;
    }

    const isBlock = BLOCK_ELEMENTS.has(tagName);

    // Handle <br> specially - adds newline
    if (tagName === "br") {
      parts.push({ text: "\n" });
      return;
    }

    // Add newline before block elements if we have content that's not a newline
    if (isBlock && parts.length > 0) {
      const lastChar = getLastPartChar();
      if (lastChar !== "\n" && lastChar !== "") {
        parts.push({ text: "\n" });
      }
    }

    // Process child nodes
    for (const child of Array.from(element.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        const textNode = child as Text;
        const text = textNode.textContent || "";
        const normalized = normalizeWhitespace(text);
        if (normalized) {
          parts.push({ text: normalized, sourceNode: textNode });
        }
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        walkElement(child as Element);
      }
    }

    // Add newline after block elements if we have content that's not a newline
    if (isBlock && parts.length > 0) {
      const lastChar = getLastPartChar();
      if (lastChar !== "\n" && lastChar !== "") {
        parts.push({ text: "\n" });
      }
    }
  }

  walkElement(root);

  return parts;
}

// =============================================================================
// Main Function
// =============================================================================

/**
 * Build a canonical cursor from an HTML element.
 *
 * This function walks the DOM tree, extracts text nodes, and computes
 * their codepoint offsets in canonical text space. The algorithm matches
 * the backend canonicalization exactly.
 *
 * @param root - The root HTML element to process
 * @returns The canonical cursor result with nodes, emitted text, and length
 *
 * @example
 * ```ts
 * const container = document.createElement('div');
 * container.innerHTML = '<p>Hello</p><p>World</p>';
 * const result = buildCanonicalCursor(container);
 * // result.emitted === "Hello\n\nWorld"
 * // result.nodes maps each text node to its offset range
 * ```
 */
export function buildCanonicalCursor(root: Element): CanonicalCursorResult {
  // Step 1: Collect parts (matches backend walk)
  const parts = collectParts(root);

  // Step 2: Join parts
  let text = parts.map((p) => p.text).join("");

  // Step 3: NFC normalize the whole string
  text = normalizeNFC(text);

  // Step 4: Collapse multiple consecutive blank lines to single blank line
  // Backend: MULTI_NEWLINE_RE.sub("\n\n", text) where MULTI_NEWLINE_RE = r"\n\s*\n+"
  text = text.replace(/\n\s*\n+/g, "\n\n");

  // Step 5: Trim each line
  const lines = text.split("\n");
  const trimmedLines = lines.map((line) => line.trim());
  text = trimmedLines.join("\n");

  // Step 6: Remove leading/trailing whitespace
  text = text.trim();

  // Now we need to build the node mapping.
  // This is tricky because the post-processing (trimming, collapsing) can
  // change character positions. We need to track each text node's content
  // through these transformations.
  //
  // Approach: Since the sanitized HTML from the backend is already "clean",
  // and we're using the same algorithm, the transformations should be minimal.
  // We'll rebuild the mapping by finding each text node's normalized content
  // in the final emitted string.

  const nodes = buildNodeMapping(root, text);

  return {
    nodes,
    emitted: text,
    length: codepointLength(text),
  };
}

/**
 * Build node mapping by finding each text node's content in the final text.
 *
 * We walk the DOM in the same order as the backend and find each node's
 * trimmed content in the final string. This accounts for the fact that
 * trimming can remove leading/trailing whitespace.
 */
function buildNodeMapping(root: Element, emitted: string): CanonicalNode[] {
  const nodes: CanonicalNode[] = [];
  const emittedCodepoints = [...emitted];
  let searchStart = 0;

  function walkElement(element: Element): void {
    const tagName = element.tagName.toLowerCase();

    if (isHidden(element)) return;
    if (SKIP_ELEMENTS.has(tagName)) return;
    if (tagName === "br") return;

    for (const child of Array.from(element.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        const textNode = child as Text;
        const rawText = textNode.textContent || "";
        const normalized = normalizeNFC(normalizeWhitespace(rawText));

        // The normalized text might have leading/trailing spaces that got
        // trimmed in the final emitted string. Find the trimmed content.
        const trimmed = normalized.trim();
        if (!trimmed) continue;

        const trimmedCodepoints = [...trimmed];
        const len = trimmedCodepoints.length;

        // Search for this text in the emitted string
        let foundIndex = -1;
        for (let i = searchStart; i <= emittedCodepoints.length - len; i++) {
          let match = true;
          for (let j = 0; j < len; j++) {
            if (emittedCodepoints[i + j] !== trimmedCodepoints[j]) {
              match = false;
              break;
            }
          }
          if (match) {
            foundIndex = i;
            break;
          }
        }

        if (foundIndex >= 0) {
          nodes.push({
            node: textNode,
            start: foundIndex,
            end: foundIndex + len,
          });
          searchStart = foundIndex + len;
        }
        // If not found, the node's content was completely removed (edge case)
        // We skip it - the validation gate will catch any mismatch
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        walkElement(child as Element);
      }
    }
  }

  walkElement(root);

  return nodes;
}

/**
 * Validate that the emitted canonical text matches the expected canonical_text.
 *
 * This is the validation gate from §5.5. If there's a mismatch, highlights
 * should not be rendered.
 *
 * @param result - The canonical cursor result
 * @param expectedCanonicalText - The canonical_text from the fragment
 * @param fragmentId - The fragment ID for logging
 * @returns true if valid, false if mismatch
 */
export function validateCanonicalText(
  result: CanonicalCursorResult,
  expectedCanonicalText: string,
  fragmentId: string
): boolean {
  if (result.emitted !== expectedCanonicalText) {
    console.warn("canonical_text_mismatch", {
      fragmentId,
      emittedLength: result.length,
      expectedLength: codepointLength(expectedCanonicalText),
      // Don't log the actual text to avoid console spam
    });
    return false;
  }
  return true;
}
