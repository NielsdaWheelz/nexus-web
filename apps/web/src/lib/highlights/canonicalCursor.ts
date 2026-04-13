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
 * @see apps/web/README.md (Highlight Libraries / canonicalCursor.ts)
 * @see python/nexus/services/canonicalize.py
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
  trimLeadCp: number; // leading codepoints stripped by trim (for raw→trimmed offset conversion)
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
  // Python's \s includes U+001C..U+001F and U+0085; JavaScript's \s does not.
  // to match backend canonicalize.py exactly.
  return text.replace(/[\s\u00a0\u0085\u001c-\u001f]+/g, " ");
}

/**
 * Get codepoint length of a string.
 * This handles astral characters (emoji, etc.) correctly.
 */
export function codepointLength(str: string): number {
  return [...str].length;
}

/**
 * Test whether a codepoint is whitespace (including non-breaking space).
 * Must match the regex used in normalizeWhitespace: /[\s\u00a0\u0085]+/g
 */
function isWsCp(cp: string): boolean {
  return /[\s\u00a0\u0085\u001c-\u001f]/.test(cp);
}

/**
 * Convert a raw codepoint offset within a DOM text node to a canonical
 * (trimmed + whitespace-normalized) codepoint offset within that node's
 * mapped range.
 *
 * This walks the raw text character-by-character, simulating the same
 * whitespace collapsing that normalizeWhitespace performs, so that
 * internal runs of whitespace (e.g. "Hello   world" → "Hello world")
 * are correctly accounted for — not just leading whitespace.
 *
 * @param rawText  - The text node's raw textContent
 * @param rawCpOffset - Codepoint offset into the raw text
 * @param trimLeadCp  - Leading whitespace codepoints in normalized text (from CanonicalNode)
 * @returns Codepoint offset in canonical (trimmed) space for this node
 */
export function rawCpToCanonicalCp(
  rawText: string,
  rawCpOffset: number,
  trimLeadCp: number
): number {
  const rawCps = [...rawText];
  let normalizedCp = 0;
  let inWhitespace = false;

  for (let i = 0; i < rawCpOffset && i < rawCps.length; i++) {
    if (isWsCp(rawCps[i])) {
      if (!inWhitespace) {
        normalizedCp++;
        inWhitespace = true;
      }
      // subsequent whitespace in the same run: no advance
    } else {
      normalizedCp++;
      inWhitespace = false;
    }
  }

  return Math.max(0, normalizedCp - trimLeadCp);
}

/**
 * Convert a canonical (trimmed + whitespace-normalized) codepoint offset
 * back to a raw codepoint offset within the DOM text node.
 *
 * This is the inverse of rawCpToCanonicalCp — used when rendering
 * highlights to find the correct split point in the raw text.
 *
 * @param rawText  - The text node's raw textContent
 * @param canonicalCpOffset - Offset in canonical (trimmed) space for this node
 * @param trimLeadCp  - Leading whitespace codepoints in normalized text (from CanonicalNode)
 * @returns Codepoint offset into the raw text
 */
export function canonicalCpToRawCp(
  rawText: string,
  canonicalCpOffset: number,
  trimLeadCp: number
): number {
  const rawCps = [...rawText];
  const targetNormalized = canonicalCpOffset + trimLeadCp;
  if (targetNormalized <= 0) return 0;

  let normalizedCp = 0;
  let i = 0;
  while (i < rawCps.length) {
    if (normalizedCp === targetNormalized) {
      return i;
    }

    if (isWsCp(rawCps[i])) {
      const runStart = i;
      while (i < rawCps.length && isWsCp(rawCps[i])) {
        i += 1;
      }
      normalizedCp += 1;
      if (normalizedCp === targetNormalized) {
        return i;
      }
      if (normalizedCp > targetNormalized) {
        return runStart;
      }
      continue;
    }

    i += 1;
    normalizedCp += 1;
    if (normalizedCp === targetNormalized) {
      return i;
    }
  }
  return rawCps.length;
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
  const parts = collectParts(root);
  type Token = {
    ch: string;
    node: Text | null;
    nodeCpIdx: number;
  };

  const joinedTokens: Token[] = [];
  for (const part of parts) {
    const normalizedPart = normalizeNFC(part.text);
    if (!normalizedPart) {
      continue;
    }
    if (!part.sourceNode) {
      for (const ch of [...normalizedPart]) {
        joinedTokens.push({ ch, node: null, nodeCpIdx: -1 });
      }
      continue;
    }
    let nodeCpIdx = 0;
    for (const ch of [...normalizedPart]) {
      joinedTokens.push({ ch, node: part.sourceNode, nodeCpIdx });
      nodeCpIdx += 1;
    }
  }

  const collapsedTokens: Token[] = [];
  for (let i = 0; i < joinedTokens.length;) {
    const token = joinedTokens[i];
    if (token.ch !== "\n") {
      collapsedTokens.push(token);
      i += 1;
      continue;
    }

    let j = i + 1;
    let newlineCount = 1;
    while (j < joinedTokens.length && isWsCp(joinedTokens[j].ch)) {
      if (joinedTokens[j].ch === "\n") {
        newlineCount += 1;
      }
      j += 1;
    }
    if (newlineCount >= 2) {
      collapsedTokens.push({ ch: "\n", node: null, nodeCpIdx: -1 });
      collapsedTokens.push({ ch: "\n", node: null, nodeCpIdx: -1 });
      i = j;
      continue;
    }

    collapsedTokens.push(token);
    i += 1;
  }

  const lineTrimmedTokens: Token[] = [];
  let lineStart = 0;
  for (let i = 0; i <= collapsedTokens.length; i++) {
    const atLineBreak = i === collapsedTokens.length || collapsedTokens[i].ch === "\n";
    if (!atLineBreak) {
      continue;
    }

    let first = lineStart;
    while (first < i && isWsCp(collapsedTokens[first].ch)) {
      first += 1;
    }
    let last = i - 1;
    while (last >= first && isWsCp(collapsedTokens[last].ch)) {
      last -= 1;
    }
    for (let j = first; j <= last; j++) {
      lineTrimmedTokens.push(collapsedTokens[j]);
    }
    if (i < collapsedTokens.length) {
      lineTrimmedTokens.push({ ch: "\n", node: null, nodeCpIdx: -1 });
    }
    lineStart = i + 1;
  }

  let start = 0;
  while (start < lineTrimmedTokens.length && isWsCp(lineTrimmedTokens[start].ch)) {
    start += 1;
  }
  let end = lineTrimmedTokens.length - 1;
  while (end >= start && isWsCp(lineTrimmedTokens[end].ch)) {
    end -= 1;
  }
  const finalTokens = start <= end ? lineTrimmedTokens.slice(start, end + 1) : [];

  const emitted = finalTokens.map((token) => token.ch).join("");

  const nodes: CanonicalNode[] = [];
  const nodeMap = new Map<Text, CanonicalNode>();
  for (let i = 0; i < finalTokens.length; i++) {
    const token = finalTokens[i];
    if (!token.node) {
      continue;
    }
    const existing = nodeMap.get(token.node);
    if (!existing) {
      const nodeEntry: CanonicalNode = {
        node: token.node,
        start: i,
        end: i + 1,
        trimLeadCp: token.nodeCpIdx,
      };
      nodeMap.set(token.node, nodeEntry);
      nodes.push(nodeEntry);
      continue;
    }
    existing.end = i + 1;
  }

  return {
    nodes,
    emitted,
    length: codepointLength(emitted),
  };
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
    const emittedCps = [...result.emitted];
    const expectedCps = [...expectedCanonicalText];
    let firstDiffIdx = -1;
    for (let i = 0; i < Math.max(emittedCps.length, expectedCps.length); i++) {
      if (emittedCps[i] !== expectedCps[i]) { firstDiffIdx = i; break; }
    }
    console.warn("canonical_text_mismatch", {
      fragmentId,
      emittedLength: result.length,
      expectedLength: codepointLength(expectedCanonicalText),
      firstDiffIdx,
      emittedAround: emittedCps.slice(Math.max(0, firstDiffIdx - 20), firstDiffIdx + 20).join(""),
      expectedAround: expectedCps.slice(Math.max(0, firstDiffIdx - 20), firstDiffIdx + 20).join(""),
      emittedCharCodes: emittedCps.slice(firstDiffIdx, firstDiffIdx + 5).map(c => c.codePointAt(0)?.toString(16)),
      expectedCharCodes: expectedCps.slice(firstDiffIdx, firstDiffIdx + 5).map(c => c.codePointAt(0)?.toString(16)),
    });
    return false;
  }
  return true;
}
