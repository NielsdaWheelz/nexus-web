/**
 * Canonical Cursor Builder for highlight offset mapping.
 *
 * This module builds a deterministic mapping from DOM text nodes to
 * codepoint offsets in the canonical text. It MUST match the backend
 * canonicalization rules exactly (python/nexus/services/canonicalize.py).
 *
 * The canonical cursor is used by:
 * - Read-only highlight rendering
 * - Selection-based highlight creation
 *
 * @see apps/web/README.md (Highlight Libraries / canonicalCursor.ts)
 * @see python/nexus/services/canonicalize.py
 */

import { isWsCp } from "./canonicalText";

import { codepointLength } from "./codepoints";

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

export type CanonicalDomSpan = {
  node: Text;
  startUtf16: number;
  endUtf16: number;
};

export type CanonicalProvenanceSpan = {
  start: number;
  end: number;
  spans: CanonicalDomSpan[];
};

/**
 * Result of building the canonical cursor.
 */
export type CanonicalCursorResult = {
  nodes: CanonicalNode[];
  provenance: CanonicalProvenanceSpan[];
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
const BLOCK_ELEMENTS = new Set([
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
// =============================================================================
// Part Collector (matches backend algorithm)
// =============================================================================

/**
 * Internal DOM source span. `order` preserves source-document order after NFC
 * reorders combining marks; `nodeCanonicalStart` retains the existing
 * whitespace-only node mapping used by selection/highlight owners.
 */
type SourceSpan = CanonicalDomSpan & {
  order: number;
  nodeCanonicalStart: number;
};

type Token = {
  ch: string;
  spans: SourceSpan[];
};

type Part = {
  tokens: Token[];
};

function normalizedTextTokens(
  node: Text,
  nextSourceOrder: () => number,
): Token[] {
  const text = node.data;
  const tokens: Token[] = [];
  let utf16Offset = 0;
  let nodeCanonicalOffset = 0;

  while (utf16Offset < text.length) {
    const codepoint = String.fromCodePoint(text.codePointAt(utf16Offset)!);
    if (!isWsCp(codepoint)) {
      const endUtf16 = utf16Offset + codepoint.length;
      tokens.push({
        ch: codepoint,
        spans: [
          {
            node,
            startUtf16: utf16Offset,
            endUtf16,
            order: nextSourceOrder(),
            nodeCanonicalStart: nodeCanonicalOffset,
          },
        ],
      });
      utf16Offset = endUtf16;
      nodeCanonicalOffset += 1;
      continue;
    }

    const startUtf16 = utf16Offset;
    while (utf16Offset < text.length) {
      const whitespace = String.fromCodePoint(text.codePointAt(utf16Offset)!);
      if (!isWsCp(whitespace)) {
        break;
      }
      utf16Offset += whitespace.length;
    }
    tokens.push({
      ch: " ",
      spans: [
        {
          node,
          startUtf16,
          endUtf16: utf16Offset,
          order: nextSourceOrder(),
          nodeCanonicalStart: nodeCanonicalOffset,
        },
      ],
    });
    nodeCanonicalOffset += 1;
  }

  return tokens;
}

/**
 * Walk a DOM tree and collect parts following backend algorithm exactly.
 */
function collectParts(root: Element): Part[] {
  const parts: Part[] = [];
  let sourceOrder = 0;
  const nextSourceOrder = () => {
    const current = sourceOrder;
    sourceOrder += 1;
    return current;
  };

  function getLastPartChar(): string {
    if (parts.length === 0) return "";
    const lastPart = parts[parts.length - 1];
    return lastPart.tokens[lastPart.tokens.length - 1]?.ch ?? "";
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
      parts.push({ tokens: [{ ch: "\n", spans: [] }] });
      return;
    }

    // Add newline before block elements if we have content that's not a newline
    if (isBlock && parts.length > 0) {
      const lastChar = getLastPartChar();
      if (lastChar !== "\n" && lastChar !== "") {
        parts.push({ tokens: [{ ch: "\n", spans: [] }] });
      }
    }

    // Process child nodes
    for (const child of Array.from(element.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        const textNode = child as Text;
        const tokens = normalizedTextTokens(textNode, nextSourceOrder);
        if (tokens.length > 0) {
          parts.push({ tokens });
        }
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        walkElement(child as Element);
      }
    }

    // Add newline after block elements if we have content that's not a newline
    if (isBlock && parts.length > 0) {
      const lastChar = getLastPartChar();
      if (lastChar !== "\n" && lastChar !== "") {
        parts.push({ tokens: [{ ch: "\n", spans: [] }] });
      }
    }
  }

  walkElement(root);

  return parts;
}

function sourceSpanKey(span: SourceSpan): string {
  return `${span.order}:${span.startUtf16}:${span.endUtf16}`;
}

function uniqueSourceSpans(spans: SourceSpan[]): SourceSpan[] {
  const unique = new Map<string, SourceSpan>();
  for (const span of spans) {
    unique.set(sourceSpanKey(span), span);
  }
  return Array.from(unique.values()).sort(
    (left, right) =>
      left.order - right.order ||
      left.startUtf16 - right.startUtf16 ||
      left.endUtf16 - right.endUtf16,
  );
}

/**
 * Apply NFC once to the complete collected stream, matching the backend. NFD
 * provides a deterministic bridge from normalized output codepoints back to
 * every contributing raw DOM span, including composition and canonical mark
 * reordering across inline text nodes.
 */
function normalizeNfcWithProvenance(tokens: Token[]): Token[] {
  const text = tokens.map((token) => token.ch).join("");
  if (!text) {
    return [];
  }

  const decomposedByCodepoint = new Map<
    string,
    { tokens: Token[]; nextIndex: number }
  >();
  for (const token of tokens) {
    for (const ch of Array.from(token.ch.normalize("NFD"))) {
      const queue = decomposedByCodepoint.get(ch);
      const decomposed = { ch, spans: token.spans };
      if (queue) {
        queue.tokens.push(decomposed);
      } else {
        decomposedByCodepoint.set(ch, {
          tokens: [decomposed],
          nextIndex: 0,
        });
      }
    }
  }

  const reorderedNfd = Array.from(text.normalize("NFD")).map((ch) => {
    const queue = decomposedByCodepoint.get(ch);
    const token = queue?.tokens[queue.nextIndex];
    if (!token) {
      throw new Error("Canonical NFC provenance decomposition drifted.");
    }
    queue.nextIndex += 1;
    return token;
  });

  const normalized: Token[] = [];
  let nfdOffset = 0;
  for (const ch of Array.from(text.normalize("NFC"))) {
    const decomposition = Array.from(ch.normalize("NFD"));
    const spans: SourceSpan[] = [];
    for (const expected of decomposition) {
      const token = reorderedNfd[nfdOffset];
      if (!token || token.ch !== expected) {
        throw new Error("Canonical NFC provenance composition drifted.");
      }
      spans.push(...token.spans);
      nfdOffset += 1;
    }
    normalized.push({ ch, spans: uniqueSourceSpans(spans) });
  }

  if (nfdOffset !== reorderedNfd.length) {
    throw new Error("Canonical NFC provenance left unconsumed source text.");
  }
  return normalized;
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
 * // result.emitted === "Hello\nWorld"
 * // result.nodes maps each text node to its offset range
 * ```
 */
export function buildCanonicalCursor(root: Element): CanonicalCursorResult {
  const parts = collectParts(root);
  const joinedTokens = normalizeNfcWithProvenance(
    parts.flatMap((part) => part.tokens),
  );

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
      collapsedTokens.push({ ch: "\n", spans: [] });
      collapsedTokens.push({ ch: "\n", spans: [] });
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
      lineTrimmedTokens.push({ ch: "\n", spans: [] });
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
  const nodeMap = new Map<
    Text,
    CanonicalNode & { firstSourceOrder: number }
  >();
  for (let i = 0; i < finalTokens.length; i++) {
    const token = finalTokens[i];
    for (const span of token.spans) {
      const existing = nodeMap.get(span.node);
      if (!existing) {
        const nodeEntry = {
          node: span.node,
          start: i,
          end: i + 1,
          trimLeadCp: span.nodeCanonicalStart,
          firstSourceOrder: span.order,
        };
        nodeMap.set(span.node, nodeEntry);
        continue;
      }
      existing.start = Math.min(existing.start, i);
      existing.end = Math.max(existing.end, i + 1);
      existing.trimLeadCp = Math.min(
        existing.trimLeadCp,
        span.nodeCanonicalStart,
      );
      existing.firstSourceOrder = Math.min(existing.firstSourceOrder, span.order);
    }
  }
  nodes.push(
    ...Array.from(nodeMap.values())
      .sort((left, right) => left.firstSourceOrder - right.firstSourceOrder)
      .map(({ firstSourceOrder: _firstSourceOrder, ...node }) => node),
  );

  const provenance = finalTokens.map<CanonicalProvenanceSpan>(
    (token, index) => ({
      start: index,
      end: index + 1,
      spans: token.spans.map(({ node, startUtf16, endUtf16 }) => ({
        node,
        startUtf16,
        endUtf16,
      })),
    }),
  );

  return {
    nodes,
    provenance,
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
