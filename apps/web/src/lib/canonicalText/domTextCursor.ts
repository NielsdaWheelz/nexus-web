import { codepointLength } from "./codepoints";

import { canonicalTokens, CANONICAL_BLOCKS, isCanonicalWhitespace as isWsCp } from "@nexus/authored/canonical";


type DomTextNode = {
  node: Text;
  start: number;
  end: number;
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
const BLOCK_ELEMENTS = CANONICAL_BLOCKS;

const SKIP_ELEMENTS = new Set(["script", "style", "noscript", "template"]);

type SourceSpan = DomTextSpan & {
  order: number;
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

/** This element and its descendants contribute no canonical text or aliases. */
export function isCanonicalTextSkipped(element: Element): boolean {
  return isHidden(element) || SKIP_ELEMENTS.has(element.tagName.toLowerCase()) || isXPostSlot(element);
}

function isXPostSlot(element: Element): boolean {
  return element.tagName.toLowerCase() === "figure" &&
    element.getAttribute("data-nexus-document-embed-kind") === "x_post" &&
    element.hasAttribute("data-nexus-document-embed-id");
}

function normalizedTextTokens(
  node: Text,
  nextSourceOrder: () => number,
): Token[] {
  const text = node.data;
  const tokens: Token[] = [];
  let utf16Offset = 0;

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
          },
        ],
      });
      utf16Offset = endUtf16;
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
        },
      ],
    });
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

    // the slot keeps its block boundary but owns no parent text.
    if (isXPostSlot(element)) return;

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

export function buildDomTextCursor(
  root: Element,
  excludeElement: (element: Element) => boolean,
): DomTextCursor {
  const finalTokens = canonicalTokens(collectParts(root, excludeElement).flatMap(part => part.tokens), uniqueSourceSpans);
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
          firstSourceOrder: span.order,
        });
        continue;
      }
      existing.start = Math.min(existing.start, i);
      existing.end = Math.max(existing.end, i + 1);
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
