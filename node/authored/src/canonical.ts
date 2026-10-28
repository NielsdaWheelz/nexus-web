/** Canonical token policy shared by the DOM and frozen-tree adapters. */
export interface CanonicalToken<Span> { ch: string; spans: Span[] }
export const CANONICAL_BLOCKS = new Set("p li ul ol h1 h2 h3 h4 h5 h6 blockquote pre div section article header footer nav aside figure figcaption table tr td th".split(" "));
export function isCanonicalWhitespace(cp: string): boolean { return cp !== "\uFEFF" && /[\s \u001c-\u001f]/u.test(cp); }
export function canonicalSerialization(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item !== null && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
}
function normalizeNfcWithProvenance<Span>(tokens: CanonicalToken<Span>[], unique: (spans: Span[]) => Span[]): CanonicalToken<Span>[] {
  const text = tokens.map((token) => token.ch).join("");
  if (!text) {
    return [];
  }
  const normalizedText = text.normalize("NFC");
  // Unchanged codepoints keep their spans unless a surrogate pair crosses nodes.
  if (normalizedText === text && Array.from(text).length === tokens.length) return tokens;

  const decomposedByCodepoint = new Map<
    string,
    { spans: Span[][]; nextIndex: number }
  >();
  for (const token of tokens) {
    for (const ch of token.ch.normalize("NFD")) {
      const queue = decomposedByCodepoint.get(ch);
      if (queue) {
        queue.spans.push(token.spans);
      } else {
        decomposedByCodepoint.set(ch, {
          spans: [token.spans],
          nextIndex: 0,
        });
      }
    }
  }

  const normalized: CanonicalToken<Span>[] = [];
  for (const ch of normalizedText) {
    const spans: Span[] = [];
    for (const decomposed of ch.normalize("NFD")) {
      const queue = decomposedByCodepoint.get(decomposed);
      const source = queue?.spans[queue.nextIndex];
      if (!queue || !source) {
        throw new Error("Canonical NFC provenance decomposition drifted.");
      }
      spans.push(...source);
      queue.nextIndex += 1;
    }
    normalized.push({ ch, spans: unique(spans) });
  }

  for (const queue of decomposedByCodepoint.values()) {
    if (queue.nextIndex !== queue.spans.length) {
      throw new Error("Canonical NFC provenance left unconsumed source text.");
    }
  }
  return normalized;
}

export function canonicalTokens<Span>(tokens: CanonicalToken<Span>[], unique: (spans: Span[]) => Span[]): CanonicalToken<Span>[] {
  const joinedTokens = normalizeNfcWithProvenance(tokens, unique);
  const collapsedTokens: CanonicalToken<Span>[] = [];
  for (let i = 0; i < joinedTokens.length;) {
    const token = joinedTokens[i];
    if (token.ch !== "\n") {
      collapsedTokens.push(token);
      i += 1;
      continue;
    }

    let j = i + 1;
    let newlineCount = 1;
    while (j < joinedTokens.length && isCanonicalWhitespace(joinedTokens[j].ch)) {
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

  const lineTrimmedTokens: CanonicalToken<Span>[] = [];
  let lineStart = 0;
  for (let i = 0; i <= collapsedTokens.length; i++) {
    const atLineBreak =
      i === collapsedTokens.length || collapsedTokens[i].ch === "\n";
    if (!atLineBreak) {
      continue;
    }

    let first = lineStart;
    while (first < i && isCanonicalWhitespace(collapsedTokens[first].ch)) {
      first += 1;
    }
    let last = i - 1;
    while (last >= first && isCanonicalWhitespace(collapsedTokens[last].ch)) {
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
    isCanonicalWhitespace(lineTrimmedTokens[start].ch)
  ) {
    start += 1;
  }
  let end = lineTrimmedTokens.length - 1;
  while (end >= start && isCanonicalWhitespace(lineTrimmedTokens[end].ch)) {
    end -= 1;
  }
  const finalTokens =
    start <= end ? lineTrimmedTokens.slice(start, end + 1) : [];
  return finalTokens;
}
