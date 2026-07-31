export const DOSSIER_FIND_ALL_HIGHLIGHT_NAME = "dossier-find-all";
export const DOSSIER_FIND_ACTIVE_HIGHLIGHT_NAME = "dossier-find-active";

export const DOSSIER_DOCUMENT_FIND_STYLES = `
::highlight(dossier-find-all){background:color-mix(in srgb,var(--machine-accent,#d4b687) 32%,transparent);color:inherit}
::highlight(dossier-find-active){background:color-mix(in srgb,var(--machine-accent,#d4b687) 58%,transparent);color:inherit;text-decoration:underline 2px;text-underline-offset:.18em}
@media (forced-colors:active){::highlight(dossier-find-all){background:Highlight;color:HighlightText}::highlight(dossier-find-active){background:Highlight;color:HighlightText;text-decoration:underline 3px}}
`;

type RuntimeSourceSpan = {
  readonly node: Text;
  readonly startUtf16: number;
  readonly endUtf16: number;
  readonly order: number;
};

type RuntimeToken = {
  readonly ch: string;
  readonly spans: readonly RuntimeSourceSpan[];
};

type RuntimeSectionInfo = {
  readonly id: string;
  readonly title: string;
};

type RuntimeOccurrence = {
  readonly ordinal: number;
  readonly startCp: number;
  readonly endCp: number;
  readonly snippet: readonly {
    readonly text: string;
    readonly emphasized: boolean;
  }[];
  readonly section:
    | { readonly kind: "Absent" }
    | { readonly kind: "Present"; readonly value: RuntimeSectionInfo };
};

type RuntimeProjection = {
  readonly article: HTMLElement;
  readonly tokens: readonly RuntimeToken[];
  readonly text: string;
};

function dossierDocumentRuntime(): void {
  "use strict";

  const channel = document.documentElement.dataset.nexusChannel;
  if (!channel) {
    throw new Error("Dossier document runtime requires a channel.");
  }

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
  const SKIP_ELEMENTS = new Set([
    "script",
    "style",
    "noscript",
    "template",
  ]);
  const QUERY_MAX_CP = 256;
  const PROJECTION_MAX_CP = 160_000;
  const MATCH_THRESHOLD = 2_000;
  const CONTEXT_CP = 64;
  const SECTION_ID_MAX_CP = 256;
  const SECTION_TITLE_MAX_CP = 512;
  const ALL_HIGHLIGHT = "dossier-find-all";
  const ACTIVE_HIGHLIGHT = "dossier-find-active";

  let findEnabled = false;
  let projection: RuntimeProjection | null = null;
  let currentSection:
    | { readonly kind: "Absent" }
    | { readonly kind: "Present"; readonly value: RuntimeSectionInfo } = {
    kind: "Absent",
  };
  let sessionId: number | null = null;
  let queryId: number | null = null;
  let occurrences: readonly RuntimeOccurrence[] = [];
  let origin: {
    readonly anchorCp: number;
    readonly viewportTopDeltaPx: number;
    readonly scrollLeft: number;
  } | null = null;

  function post(message: Record<string, unknown>): void {
    window.parent.postMessage({ channel, ...message }, "*");
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  function exactKeys(
    value: Record<string, unknown>,
    expected: readonly string[],
  ): boolean {
    const keys = Object.keys(value);
    return (
      keys.length === expected.length &&
      keys.every((key) => expected.includes(key))
    );
  }

  function isPositiveSafeInteger(value: unknown): value is number {
    return Number.isSafeInteger(value) && typeof value === "number" && value > 0;
  }

  function isNonnegativeSafeInteger(value: unknown): value is number {
    return Number.isSafeInteger(value) && typeof value === "number" && value >= 0;
  }

  function isWhitespace(codepoint: string): boolean {
    return /[\s\u00a0\u0085\u001c-\u001f]/u.test(codepoint);
  }

  function isHidden(element: Element): boolean {
    return (
      element.hasAttribute("hidden") ||
      element.getAttribute("aria-hidden")?.toLowerCase() === "true"
    );
  }

  function textTokens(
    node: Text,
    nextOrder: () => number,
  ): RuntimeToken[] {
    const tokens: RuntimeToken[] = [];
    let offset = 0;
    while (offset < node.data.length) {
      const codepoint = String.fromCodePoint(node.data.codePointAt(offset)!);
      if (!isWhitespace(codepoint)) {
        const end = offset + codepoint.length;
        tokens.push({
          ch: codepoint,
          spans: [
            {
              node,
              startUtf16: offset,
              endUtf16: end,
              order: nextOrder(),
            },
          ],
        });
        offset = end;
        continue;
      }
      const start = offset;
      while (offset < node.data.length) {
        const whitespace = String.fromCodePoint(
          node.data.codePointAt(offset)!,
        );
        if (!isWhitespace(whitespace)) break;
        offset += whitespace.length;
      }
      tokens.push({
        ch: " ",
        spans: [
          {
            node,
            startUtf16: start,
            endUtf16: offset,
            order: nextOrder(),
          },
        ],
      });
    }
    return tokens;
  }

  function collectTokens(root: Element): RuntimeToken[] {
    const tokens: RuntimeToken[] = [];
    let order = 0;
    const nextOrder = () => {
      const current = order;
      order += 1;
      return current;
    };

    function lastCharacter(): string {
      return tokens[tokens.length - 1]?.ch ?? "";
    }

    function walk(element: Element): void {
      const tagName = element.tagName.toLowerCase();
      if (
        isHidden(element) ||
        SKIP_ELEMENTS.has(tagName) ||
        element.classList.contains("dossier-citation")
      ) {
        return;
      }
      if (tagName === "br") {
        tokens.push({ ch: "\n", spans: [] });
        return;
      }
      const block = BLOCK_ELEMENTS.has(tagName);
      if (block && tokens.length > 0 && lastCharacter() !== "\n") {
        tokens.push({ ch: "\n", spans: [] });
      }
      for (const child of Array.from(element.childNodes)) {
        if (child.nodeType === Node.TEXT_NODE) {
          tokens.push(...textTokens(child as Text, nextOrder));
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          walk(child as Element);
        }
      }
      if (block && tokens.length > 0 && lastCharacter() !== "\n") {
        tokens.push({ ch: "\n", spans: [] });
      }
    }

    walk(root);
    return tokens;
  }

  function uniqueSpans(
    spans: readonly RuntimeSourceSpan[],
  ): RuntimeSourceSpan[] {
    const byOrder = new Map<number, RuntimeSourceSpan>();
    for (const span of spans) byOrder.set(span.order, span);
    return Array.from(byOrder.values()).sort(
      (left, right) =>
        left.order - right.order ||
        left.startUtf16 - right.startUtf16 ||
        left.endUtf16 - right.endUtf16,
    );
  }

  function normalizeNfc(tokens: readonly RuntimeToken[]): RuntimeToken[] {
    const text = tokens.map(({ ch }) => ch).join("");
    const decomposedByCodepoint = new Map<string, RuntimeToken[]>();
    for (const token of tokens) {
      for (const codepoint of Array.from(token.ch.normalize("NFD"))) {
        const queue = decomposedByCodepoint.get(codepoint) ?? [];
        queue.push({ ch: codepoint, spans: token.spans });
        decomposedByCodepoint.set(codepoint, queue);
      }
    }
    const reordered = Array.from(text.normalize("NFD")).map((codepoint) => {
      const token = decomposedByCodepoint.get(codepoint)?.shift();
      if (!token) {
        throw new Error("Dossier canonical NFC provenance drifted.");
      }
      return token;
    });
    const normalized: RuntimeToken[] = [];
    let offset = 0;
    for (const codepoint of Array.from(text.normalize("NFC"))) {
      const decomposition = Array.from(codepoint.normalize("NFD"));
      const spans: RuntimeSourceSpan[] = [];
      for (const expected of decomposition) {
        const token = reordered[offset];
        if (!token || token.ch !== expected) {
          throw new Error("Dossier canonical NFC composition drifted.");
        }
        spans.push(...token.spans);
        offset += 1;
      }
      normalized.push({ ch: codepoint, spans: uniqueSpans(spans) });
    }
    if (offset !== reordered.length) {
      throw new Error("Dossier canonical NFC left source text unconsumed.");
    }
    return normalized;
  }

  function collapseAndTrim(tokens: readonly RuntimeToken[]): RuntimeToken[] {
    const collapsed: RuntimeToken[] = [];
    for (let index = 0; index < tokens.length; ) {
      const token = tokens[index]!;
      if (token.ch !== "\n") {
        collapsed.push(token);
        index += 1;
        continue;
      }
      let cursor = index + 1;
      let newlines = 1;
      while (cursor < tokens.length && isWhitespace(tokens[cursor]!.ch)) {
        if (tokens[cursor]!.ch === "\n") newlines += 1;
        cursor += 1;
      }
      if (newlines >= 2) {
        collapsed.push({ ch: "\n", spans: [] });
        collapsed.push({ ch: "\n", spans: [] });
        index = cursor;
        continue;
      }
      collapsed.push(token);
      index += 1;
    }

    const lineTrimmed: RuntimeToken[] = [];
    let lineStart = 0;
    for (let index = 0; index <= collapsed.length; index += 1) {
      if (
        index < collapsed.length &&
        collapsed[index]!.ch !== "\n"
      ) {
        continue;
      }
      let first = lineStart;
      while (first < index && isWhitespace(collapsed[first]!.ch)) first += 1;
      let last = index - 1;
      while (last >= first && isWhitespace(collapsed[last]!.ch)) last -= 1;
      for (let cursor = first; cursor <= last; cursor += 1) {
        lineTrimmed.push(collapsed[cursor]!);
      }
      if (index < collapsed.length) {
        lineTrimmed.push({ ch: "\n", spans: [] });
      }
      lineStart = index + 1;
    }

    let first = 0;
    while (
      first < lineTrimmed.length &&
      isWhitespace(lineTrimmed[first]!.ch)
    ) {
      first += 1;
    }
    let last = lineTrimmed.length - 1;
    while (last >= first && isWhitespace(lineTrimmed[last]!.ch)) last -= 1;
    return first <= last ? lineTrimmed.slice(first, last + 1) : [];
  }

  function buildProjection(): RuntimeProjection {
    const articles = document.body.querySelectorAll(":scope > article");
    if (articles.length !== 1 || !(articles[0] instanceof HTMLElement)) {
      throw new Error("Dossier Find requires one top-level article.");
    }
    const article = articles[0];
    const tokens = collapseAndTrim(normalizeNfc(collectTokens(article)));
    const text = tokens.map(({ ch }) => ch).join("");
    const length = Array.from(text).length;
    if (length < 1 || length > PROJECTION_MAX_CP) {
      throw new Error("Dossier Find projection is outside its contract.");
    }
    return { article, tokens, text };
  }

  function headingText(heading: Element): string {
    function readableText(element: Element): string {
      if (
        isHidden(element) ||
        SKIP_ELEMENTS.has(element.tagName.toLowerCase()) ||
        element.classList.contains("dossier-citation")
      ) {
        return "";
      }
      return Array.from(element.childNodes)
        .map((child) =>
          child.nodeType === Node.TEXT_NODE
            ? (child as Text).data
            : child.nodeType === Node.ELEMENT_NODE
              ? readableText(child as Element)
              : "",
        )
        .join("");
    }
    return readableText(heading)
      .replace(/[\s\u00a0]+/gu, " ")
      .trim()
      .normalize("NFC");
  }

  function acceptedSection(
    section: Element | null,
  ): RuntimeSectionInfo | null {
    if (!section || section.tagName.toLowerCase() !== "section") return null;
    const id = section.getAttribute("id") ?? "";
    if (
      Array.from(id).length < 1 ||
      Array.from(id).length > SECTION_ID_MAX_CP ||
      /[\r\n]/u.test(id)
    ) {
      return null;
    }
    const article = section.closest("article");
    if (
      !article ||
      Array.from(article.querySelectorAll("section[id]")).filter(
        (candidate) => candidate.getAttribute("id") === id,
      ).length !== 1
    ) {
      return null;
    }
    const heading = Array.from(
      section.querySelectorAll("h1,h2,h3,h4,h5,h6"),
    ).find((candidate) => candidate.closest("section[id]") === section);
    if (!heading) return null;
    const title = headingText(heading);
    if (
      Array.from(title).length < 1 ||
      Array.from(title).length > SECTION_TITLE_MAX_CP
    ) {
      return null;
    }
    return { id, title };
  }

  function sectionForToken(token: RuntimeToken): RuntimeSectionInfo | null {
    const source = token.spans[0]?.node.parentElement ?? null;
    return acceptedSection(source?.closest("section[id]") ?? null);
  }

  function rangesFor(
    currentProjection: RuntimeProjection,
    startCp: number,
    endCp: number,
  ): Range[] {
    const byNode = new Map<
      Text,
      { startUtf16: number; endUtf16: number; order: number }
    >();
    for (const token of currentProjection.tokens.slice(startCp, endCp)) {
      for (const span of token.spans) {
        const existing = byNode.get(span.node);
        if (!existing) {
          byNode.set(span.node, {
            startUtf16: span.startUtf16,
            endUtf16: span.endUtf16,
            order: span.order,
          });
          continue;
        }
        existing.startUtf16 = Math.min(existing.startUtf16, span.startUtf16);
        existing.endUtf16 = Math.max(existing.endUtf16, span.endUtf16);
        existing.order = Math.min(existing.order, span.order);
      }
    }
    return Array.from(byNode.entries())
      .sort(([, left], [, right]) => left.order - right.order)
      .map(([node, span]) => {
        const range = document.createRange();
        range.setStart(node, span.startUtf16);
        range.setEnd(node, span.endUtf16);
        return range;
      });
  }

  function requireHighlights(): HighlightRegistry {
    if (
      typeof CSS === "undefined" ||
      typeof Highlight === "undefined" ||
      !CSS.highlights
    ) {
      throw new Error("Dossier Find requires CSS Custom Highlights.");
    }
    return CSS.highlights;
  }

  function publishHighlight(name: string, ranges: readonly Range[]): void {
    const registry = requireHighlights();
    if (ranges.length === 0) {
      registry.delete(name);
      return;
    }
    const highlight = new Highlight();
    for (const range of ranges) highlight.add(range);
    registry.set(name, highlight);
  }

  function clearHighlights(): void {
    const registry = requireHighlights();
    registry.delete(ALL_HIGHLIGHT);
    registry.delete(ACTIVE_HIGHLIGHT);
  }

  function publishAllMatches(
    currentProjection: RuntimeProjection,
    matches: readonly RuntimeOccurrence[],
  ): void {
    publishHighlight(
      ALL_HIGHLIGHT,
      matches.flatMap((match) =>
        rangesFor(currentProjection, match.startCp, match.endCp),
      ),
    );
    publishHighlight(ACTIVE_HIGHLIGHT, []);
  }

  function firstVisibleAnchor(
    currentProjection: RuntimeProjection,
  ): {
    readonly anchorCp: number;
    readonly viewportTopDeltaPx: number;
    readonly scrollLeft: number;
  } | null {
    for (let index = 0; index < currentProjection.tokens.length; index += 1) {
      const ranges = rangesFor(currentProjection, index, index + 1);
      for (const range of ranges) {
        const rect = range.getBoundingClientRect();
        if (rect.bottom > 0 && rect.top < window.innerHeight) {
          return {
            anchorCp: index,
            viewportTopDeltaPx: rect.top,
            scrollLeft: window.scrollX,
          };
        }
      }
    }
    return null;
  }

  function firstVisibleSection(
    currentProjection: RuntimeProjection,
  ):
    | { readonly kind: "Absent" }
    | { readonly kind: "Present"; readonly value: RuntimeSectionInfo } {
    const anchor = firstVisibleAnchor(currentProjection);
    if (!anchor) return { kind: "Absent" };
    const section = sectionForToken(currentProjection.tokens[anchor.anchorCp]!);
    return section
      ? { kind: "Present", value: section }
      : { kind: "Absent" };
  }

  function scopeRange(
    currentProjection: RuntimeProjection,
    scope: Record<string, unknown>,
  ): { readonly startCp: number; readonly endCp: number } | null {
    if (
      exactKeys(scope, ["kind"]) &&
      scope.kind === "EntireResource"
    ) {
      return { startCp: 0, endCp: currentProjection.tokens.length };
    }
    if (
      !exactKeys(scope, ["kind", "sectionId"]) ||
      scope.kind !== "CurrentSection" ||
      typeof scope.sectionId !== "string" ||
      currentSection.kind !== "Present" ||
      scope.sectionId !== currentSection.value.id
    ) {
      return null;
    }
    const section = currentProjection.article.querySelector(
      `section[id="${CSS.escape(scope.sectionId)}"]`,
    );
    if (!section) return null;
    let startCp = -1;
    let endCp = -1;
    for (
      let index = 0;
      index < currentProjection.tokens.length;
      index += 1
    ) {
      if (
        currentProjection.tokens[index]!.spans.some((span) =>
          section.contains(span.node),
        )
      ) {
        if (startCp === -1) startCp = index;
        endCp = index + 1;
      }
    }
    return startCp === -1 ? null : { startCp, endCp };
  }

  function snippet(
    codepoints: readonly string[],
    startCp: number,
    endCp: number,
    scopeStartCp: number,
    scopeEndCp: number,
  ): readonly { readonly text: string; readonly emphasized: boolean }[] {
    const start = Math.max(scopeStartCp, startCp - CONTEXT_CP);
    const end = Math.min(scopeEndCp, endCp + CONTEXT_CP);
    return [
      {
        text: codepoints.slice(start, startCp).join(""),
        emphasized: false,
      },
      {
        text: codepoints.slice(startCp, endCp).join(""),
        emphasized: true,
      },
      {
        text: codepoints.slice(endCp, end).join(""),
        emphasized: false,
      },
    ].filter(({ text }) => text.length > 0);
  }

  function wordBoundaries(text: string): ReadonlySet<number> {
    const boundaries = new Set<number>([0, text.length]);
    const segmenter = new Intl.Segmenter("und", { granularity: "word" });
    for (const segment of segmenter.segment(text)) {
      boundaries.add(segment.index);
    }
    return boundaries;
  }

  function runQuery(input: {
    readonly currentProjection: RuntimeProjection;
    readonly query: string;
    readonly matchCase: boolean;
    readonly wholeWord: boolean;
    readonly range: { readonly startCp: number; readonly endCp: number };
  }):
    | { readonly kind: "Ready"; readonly occurrences: RuntimeOccurrence[] }
    | { readonly kind: "NoMatches" }
    | { readonly kind: "TooManyMatches"; readonly threshold: 2_000 } {
    const normalizedQuery = input.query.normalize("NFC");
    const escaped = normalizedQuery.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const expression = new RegExp(
      escaped,
      input.matchCase ? "gu" : "giu",
    );
    const codepoints = Array.from(input.currentProjection.text);
    const scopedCodepoints = codepoints.slice(
      input.range.startCp,
      input.range.endCp,
    );
    const scopedText = scopedCodepoints.join("");
    const boundaries = input.wholeWord ? wordBoundaries(scopedText) : null;
    const cpByUtf16 = new Map<number, number>([[0, 0]]);
    let utf16 = 0;
    for (const codepoint of scopedCodepoints) {
      utf16 += codepoint.length;
      cpByUtf16.set(utf16, cpByUtf16.size);
    }
    const matches: RuntimeOccurrence[] = [];
    let match = expression.exec(scopedText);
    while (match) {
      const startUtf16 = match.index;
      const endUtf16 = startUtf16 + match[0].length;
      if (
        boundaries === null ||
        (boundaries.has(startUtf16) && boundaries.has(endUtf16))
      ) {
        const relativeStart = cpByUtf16.get(startUtf16);
        const relativeEnd = cpByUtf16.get(endUtf16);
        if (relativeStart === undefined || relativeEnd === undefined) {
          throw new Error("Dossier Find match split a codepoint.");
        }
        const startCp = input.range.startCp + relativeStart;
        const endCp = input.range.startCp + relativeEnd;
        const section = sectionForToken(
          input.currentProjection.tokens[startCp]!,
        );
        matches.push({
          ordinal: matches.length,
          startCp,
          endCp,
          snippet: snippet(
            codepoints,
            startCp,
            endCp,
            input.range.startCp,
            input.range.endCp,
          ),
          section: section
            ? { kind: "Present", value: section }
            : { kind: "Absent" },
        });
        if (matches.length > MATCH_THRESHOLD) {
          return { kind: "TooManyMatches", threshold: MATCH_THRESHOLD };
        }
      } else {
        const codepoint = scopedText.codePointAt(startUtf16);
        if (codepoint === undefined) {
          throw new Error("Dossier Find boundary offset is invalid.");
        }
        expression.lastIndex = startUtf16 + (codepoint > 0xffff ? 2 : 1);
      }
      match = expression.exec(scopedText);
    }
    return matches.length > 0
      ? { kind: "Ready", occurrences: matches }
      : { kind: "NoMatches" };
  }

  function decodeScope(value: unknown): Record<string, unknown> | null {
    if (!isRecord(value)) return null;
    if (
      exactKeys(value, ["kind"]) &&
      value.kind === "EntireResource"
    ) {
      return value;
    }
    if (
      exactKeys(value, ["kind", "sectionId"]) &&
      value.kind === "CurrentSection" &&
      typeof value.sectionId === "string"
    ) {
      return value;
    }
    return null;
  }

  window.addEventListener("message", (event) => {
    if (
      event.source !== window.parent ||
      !isRecord(event.data) ||
      event.data.channel !== channel
    ) {
      return;
    }
    const message = event.data;
    if (
      exactKeys(message, ["channel", "kind"]) &&
      message.kind === "FindHello"
    ) {
      post({ kind: "FindReady" });
      return;
    }
    if (
      exactKeys(message, ["channel", "kind"]) &&
      (message.kind === "FindEnabled" || message.kind === "FindDisabled")
    ) {
      findEnabled = message.kind === "FindEnabled";
      return;
    }
    if (
      exactKeys(message, ["channel", "kind", "sessionId"]) &&
      message.kind === "FindPrepare" &&
      isPositiveSafeInteger(message.sessionId)
    ) {
      projection = buildProjection();
      sessionId = message.sessionId;
      queryId = null;
      occurrences = [];
      origin = null;
      clearHighlights();
      currentSection = firstVisibleSection(projection);
      post({
        kind: "FindPrepared",
        sessionId,
        projectionLengthCp: projection.tokens.length,
        currentSection,
      });
      return;
    }
    if (
      exactKeys(message, [
        "channel",
        "kind",
        "sessionId",
        "queryId",
        "query",
        "scope",
        "matchCase",
        "wholeWord",
      ]) &&
      message.kind === "FindQuery" &&
      isPositiveSafeInteger(message.sessionId) &&
      isPositiveSafeInteger(message.queryId) &&
      typeof message.query === "string" &&
      Array.from(message.query).length >= 1 &&
      Array.from(message.query).length <= QUERY_MAX_CP &&
      !/[\r\n]/u.test(message.query) &&
      typeof message.matchCase === "boolean" &&
      typeof message.wholeWord === "boolean" &&
      sessionId === message.sessionId &&
      projection
    ) {
      const scope = decodeScope(message.scope);
      const range = scope ? scopeRange(projection, scope) : null;
      if (!range) return;
      const result = runQuery({
        currentProjection: projection,
        query: message.query,
        matchCase: message.matchCase,
        wholeWord: message.wholeWord,
        range,
      });
      queryId = message.queryId;
      occurrences = result.kind === "Ready" ? result.occurrences : [];
      if (result.kind === "Ready") {
        publishAllMatches(projection, occurrences);
      } else {
        clearHighlights();
      }
      post({
        kind: "FindResults",
        sessionId,
        queryId,
        result,
      });
      return;
    }
    if (
      exactKeys(message, [
        "channel",
        "kind",
        "sessionId",
        "queryId",
        "ordinal",
      ]) &&
      message.kind === "FindActivate" &&
      isPositiveSafeInteger(message.sessionId) &&
      isPositiveSafeInteger(message.queryId) &&
      isNonnegativeSafeInteger(message.ordinal) &&
      sessionId === message.sessionId &&
      queryId === message.queryId &&
      projection
    ) {
      const occurrence = occurrences[message.ordinal];
      if (!occurrence || occurrence.ordinal !== message.ordinal) return;
      if (!origin) {
        const captured = firstVisibleAnchor(projection);
        if (!captured) {
          post({
            kind: "FindActivationRejected",
            sessionId,
            queryId,
            ordinal: message.ordinal,
            reason: "OriginUnavailable",
          });
          return;
        }
        origin = captured;
      }
      const ranges = rangesFor(
        projection,
        occurrence.startCp,
        occurrence.endCp,
      );
      if (ranges.length === 0) {
        post({
          kind: "FindActivationRejected",
          sessionId,
          queryId,
          ordinal: message.ordinal,
          reason: "OriginUnavailable",
        });
        return;
      }
      publishHighlight(ACTIVE_HIGHLIGHT, ranges);
      const rect = ranges[0]!.getBoundingClientRect();
      window.scrollTo({
        top: Math.max(0, window.scrollY + rect.top - 32),
        left: window.scrollX,
        behavior: "auto",
      });
      post({
        kind: "FindActivated",
        sessionId,
        queryId,
        ordinal: message.ordinal,
      });
      return;
    }
    if (
      exactKeys(message, [
        "channel",
        "kind",
        "sessionId",
        "queryId",
      ]) &&
      message.kind === "FindClear" &&
      isPositiveSafeInteger(message.sessionId) &&
      isPositiveSafeInteger(message.queryId) &&
      sessionId === message.sessionId &&
      queryId === message.queryId
    ) {
      clearHighlights();
      post({ kind: "FindCleared", sessionId, queryId });
      return;
    }
    if (
      exactKeys(message, ["channel", "kind", "sessionId"]) &&
      message.kind === "FindReturn" &&
      isPositiveSafeInteger(message.sessionId) &&
      sessionId === message.sessionId &&
      projection
    ) {
      if (!origin) {
        post({
          kind: "FindReturnRejected",
          sessionId,
          reason: "OriginUnavailable",
        });
        return;
      }
      const ranges = rangesFor(
        projection,
        origin.anchorCp,
        origin.anchorCp + 1,
      );
      if (ranges.length === 0) {
        post({
          kind: "FindReturnRejected",
          sessionId,
          reason: "OriginUnavailable",
        });
        return;
      }
      const savedOrigin = origin;
      const rect = ranges[0]!.getBoundingClientRect();
      window.scrollTo({
        top: Math.max(
          0,
          window.scrollY + rect.top - savedOrigin.viewportTopDeltaPx,
        ),
        left: savedOrigin.scrollLeft,
        behavior: "auto",
      });
      window.requestAnimationFrame(() => {
        const restored = ranges[0]!.getBoundingClientRect();
        if (
          Math.abs(restored.top - savedOrigin.viewportTopDeltaPx) > 1 ||
          Math.abs(window.scrollX - savedOrigin.scrollLeft) > 1
        ) {
          post({
            kind: "FindReturnRejected",
            sessionId,
            reason: "OriginUnavailable",
          });
          return;
        }
        origin = null;
        post({ kind: "FindReturned", sessionId });
      });
    }
  });

  document.addEventListener("click", (event) => {
    const target =
      event.target instanceof Element
        ? event.target.closest(
            "button.dossier-citation[data-nexus-citation]",
          )
        : null;
    if (!target) return;
    event.preventDefault();
    const raw = target.getAttribute("data-nexus-citation");
    if (!raw || !/^[1-9][0-9]*$/u.test(raw)) return;
    const ordinal = Number(raw);
    if (!Number.isSafeInteger(ordinal)) return;
    const disposition =
      event.shiftKey && event.detail !== 0 ? "Fork" : "Follow";
    post({ kind: "Citation", ordinal, disposition });
  });

  window.addEventListener("keydown", (event) => {
    if (
      !findEnabled ||
      event.defaultPrevented ||
      event.shiftKey ||
      event.altKey ||
      !(event.metaKey || event.ctrlKey) ||
      event.key.toLowerCase() !== "f"
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    post({ kind: "FindRequested" });
  });
}

/** Fixed runtime only. Generated title, article, citation, or query data never enters it. */
export const DOSSIER_DOCUMENT_RUNTIME = `(${dossierDocumentRuntime.toString()})();`;
