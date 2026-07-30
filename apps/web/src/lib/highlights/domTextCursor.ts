import { isWsCp } from "./canonicalText";
import { codepointLength } from "./codepoints";

type DomTextNode = {
  node: Text;
  start: number;
  end: number;
  trimLeadCp: number;
};

export type DomTextSpan = {
  node: Text;
  startUtf16: number;
  endUtf16: number;
};

type DomTextProvenanceSpan = {
  start: number;
  end: number;
  spans: DomTextSpan[];
};

export type DomTextCursor = {
  nodes: DomTextNode[];
  provenance: DomTextProvenanceSpan[];
  emitted: string;
  length: number;
};

// These sets and the built-in visibility rule match canonicalize.py.
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

const SKIP_ELEMENTS = new Set(["script", "style", "noscript", "template"]);

type SourceSpan = DomTextSpan & {
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

function isHidden(element: Element): boolean {
  if (element.hasAttribute("hidden")) {
    return true;
  }
  return element.getAttribute("aria-hidden")?.toLowerCase() === "true";
}

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

function collectParts(
  root: Element,
  excludeElement: (element: Element) => boolean,
): Part[] {
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
    if (excludeElement(element)) {
      return;
    }

    const tagName = element.tagName.toLowerCase();
    if (isHidden(element) || SKIP_ELEMENTS.has(tagName)) {
      return;
    }

    if (tagName === "br") {
      parts.push({ tokens: [{ ch: "\n", spans: [] }] });
      return;
    }

    const isBlock = BLOCK_ELEMENTS.has(tagName);
    if (isBlock && parts.length > 0) {
      const lastChar = getLastPartChar();
      if (lastChar !== "\n" && lastChar !== "") {
        parts.push({ tokens: [{ ch: "\n", spans: [] }] });
      }
    }

    for (const child of Array.from(element.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        const tokens = normalizedTextTokens(child as Text, nextSourceOrder);
        if (tokens.length > 0) {
          parts.push({ tokens });
        }
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        walkElement(child as Element);
      }
    }

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

function uniqueSourceSpans(spans: SourceSpan[]): SourceSpan[] {
  const unique = new Map<string, SourceSpan>();
  for (const span of spans) {
    unique.set(
      `${span.order}:${span.startUtf16}:${span.endUtf16}`,
      span,
    );
  }
  return Array.from(unique.values()).sort(
    (left, right) =>
      left.order - right.order ||
      left.startUtf16 - right.startUtf16 ||
      left.endUtf16 - right.endUtf16,
  );
}

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

export function buildDomTextCursor(
  root: Element,
  excludeElement: (element: Element) => boolean,
): DomTextCursor {
  const joinedTokens = normalizeNfcWithProvenance(
    collectParts(root, excludeElement).flatMap((part) => part.tokens),
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
    const atLineBreak =
      i === collapsedTokens.length || collapsedTokens[i].ch === "\n";
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
  while (
    start < lineTrimmedTokens.length &&
    isWsCp(lineTrimmedTokens[start].ch)
  ) {
    start += 1;
  }
  let end = lineTrimmedTokens.length - 1;
  while (end >= start && isWsCp(lineTrimmedTokens[end].ch)) {
    end -= 1;
  }
  const finalTokens =
    start <= end ? lineTrimmedTokens.slice(start, end + 1) : [];
  const emitted = finalTokens.map((token) => token.ch).join("");

  const nodeMap = new Map<
    Text,
    DomTextNode & { firstSourceOrder: number }
  >();
  for (let i = 0; i < finalTokens.length; i++) {
    for (const span of finalTokens[i].spans) {
      const existing = nodeMap.get(span.node);
      if (!existing) {
        nodeMap.set(span.node, {
          node: span.node,
          start: i,
          end: i + 1,
          trimLeadCp: span.nodeCanonicalStart,
          firstSourceOrder: span.order,
        });
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

  const nodes = Array.from(nodeMap.values())
    .sort((left, right) => left.firstSourceOrder - right.firstSourceOrder)
    .map(({ firstSourceOrder: _firstSourceOrder, ...node }) => node);
  const provenance = finalTokens.map<DomTextProvenanceSpan>((token, index) => ({
    start: index,
    end: index + 1,
    spans: token.spans.map(({ node, startUtf16, endUtf16 }) => ({
      node,
      startUtf16,
      endUtf16,
    })),
  }));

  return {
    nodes,
    provenance,
    emitted,
    length: codepointLength(emitted),
  };
}
