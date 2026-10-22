// The note body: one ProseMirror block (paragraph, code_block or object_embed) in the
// grammar python validates (schemas/notes.py validate_body), and its text projection,
// which mirrors note_bodies.text_from_pm_json byte for byte (I1) so stored offsets land
// on the right characters. Bodies from the server are trusted as valid.
import {
  Schema,
  type MarkSpec,
  type Node as PMNode,
  type NodeSpec,
} from "prosemirror-model";
import { Decoration, DecorationSet } from "prosemirror-view";
import {
  codepointLength,
  codepointToUtf16,
} from "@/lib/canonicalText/codepoints";

export interface NoteBody {
  readonly body_pm_json: Record<string, unknown>;
  readonly body_text: string;
}

/** `/`-relative (not `//`), http(s) with a host and no `%` authority, or bare mailto (I2). */
export function isSafeHref(href: unknown): href is string {
  if (typeof href !== "string" || !href) return false;
  if (/[\s\u0000-\u001f\u007f\\]/u.test(href)) return false;
  if (href.startsWith("/")) return !href.startsWith("//");
  try {
    const url = new URL(href);
    if (/^mailto:/iu.test(href)) return url.host === "" && url.pathname !== "";
    const authority = /^https?:\/\/([^/?#]+)/iu.exec(href)?.[1];
    return Boolean(authority && !authority.includes("%") && url.host);
  } catch {
    return false;
  }
}

/** What the link dialog accepts: a safe href, with mailto: added to a bare address and
 * https:// to a bare domain. */
export function hrefFromInput(input: string): string | null {
  const value = input.trim();
  const bare =
    !/^[a-z][a-z0-9+.-]*:/iu.test(value) &&
    !value.startsWith("/") &&
    /^(?:localhost(?:[:/]|$)|[^\s/:]+\.[^\s/:]+(?:[:/]|$))/iu.test(value);
  const href = /^[^\s@/:]+@[^\s@/:]+$/u.test(value)
    ? `mailto:${value}`
    : bare
      ? `https://${value}`
      : value;
  return isSafeHref(href) ? href : null;
}

const embedLabel = (node: PMNode): string =>
  node.attrs.label || `${node.attrs.objectType}:${node.attrs.objectId}`;

const nodes = {
  note_body_doc: { content: "block_body" },
  paragraph: {
    content: "inline*",
    group: "block_body block",
    parseDOM: [{ tag: "p" }],
    toDOM: () => ["p", 0],
  },
  text: { group: "inline" },
  hard_break: {
    inline: true,
    group: "inline",
    selectable: false,
    parseDOM: [{ tag: "br" }],
    toDOM: () => ["br"],
  },
  image: {
    inline: true,
    group: "inline",
    draggable: false,
    attrs: { src: {}, alt: { default: null }, title: { default: null } },
    parseDOM: [
      {
        tag: "img[src]",
        getAttrs: (dom) => ({
          src: dom.getAttribute("src"),
          alt: dom.getAttribute("alt"),
          title: dom.getAttribute("title"),
        }),
      },
    ],
    toDOM: (node) => ["img", { ...node.attrs, draggable: "false" }],
  },
  code_block: {
    content: "text*",
    marks: "",
    group: "block_body block",
    code: true,
    defining: true,
    parseDOM: [{ tag: "pre", preserveWhitespace: "full" }],
    toDOM: () => ["pre", ["code", 0]],
  },
  object_embed: {
    group: "block_body block",
    atom: true,
    selectable: true,
    attrs: {
      objectType: {},
      objectId: {},
      label: { default: "" },
      relationType: { default: "embeds" },
      displayMode: { default: "compact" },
    },
    parseDOM: [
      {
        tag: "div[data-object-embed-type][data-object-embed-id]",
        getAttrs: (dom) => ({
          objectType: dom.getAttribute("data-object-embed-type"),
          objectId: dom.getAttribute("data-object-embed-id"),
          label: dom.textContent ?? "",
          relationType: dom.getAttribute("data-relation-type") ?? "embeds",
          displayMode: dom.getAttribute("data-display-mode") ?? "compact",
        }),
      },
    ],
    toDOM: (node) => [
      "div",
      {
        "data-object-type": node.attrs.objectType,
        "data-object-id": node.attrs.objectId,
        "data-object-embed-type": node.attrs.objectType,
        "data-object-embed-id": node.attrs.objectId,
        "data-relation-type": node.attrs.relationType,
        "data-display-mode": node.attrs.displayMode,
        contenteditable: "false",
        class: "note-object-embed",
      },
      embedLabel(node),
    ],
  },
} satisfies Record<string, NodeSpec>;

const marks = {
  strong: {
    parseDOM: [{ tag: "strong" }, { tag: "b" }],
    toDOM: () => ["strong", 0],
  },
  em: { parseDOM: [{ tag: "em" }, { tag: "i" }], toDOM: () => ["em", 0] },
  code: { parseDOM: [{ tag: "code" }], toDOM: () => ["code", 0] },
  underline: {
    parseDOM: [
      { tag: "u" },
      {
        style: "text-decoration",
        getAttrs: (value) =>
          /(?:^|\s)underline(?:\s|$)/u.test(value) ? null : false,
      },
    ],
    toDOM: () => ["u", 0],
  },
  link: {
    attrs: { href: {}, title: { default: null } },
    inclusive: false,
    parseDOM: [
      {
        tag: "a[href]",
        getAttrs: (dom) => {
          const href = dom.getAttribute("href");
          return isSafeHref(href)
            ? { href, title: dom.getAttribute("title") }
            : false;
        },
      },
    ],
    toDOM: (mark) =>
      isSafeHref(mark.attrs.href) ? ["a", mark.attrs, 0] : ["span", 0],
  },
  strikethrough: {
    parseDOM: [
      { tag: "s" },
      { tag: "del" },
      {
        style: "text-decoration",
        getAttrs: (value) =>
          /(?:^|\s)line-through(?:\s|$)/u.test(value) ? null : false,
      },
    ],
    toDOM: () => ["s", 0],
  },
} satisfies Record<string, MarkSpec>;

export const noteBodySchema = new Schema({
  topNode: "note_body_doc",
  nodes,
  marks,
});

export function bodyFromNode(block: PMNode): NoteBody {
  return {
    // justify-type-assertion: a node's toJSON is a plain object.
    body_pm_json: block.toJSON() as Record<string, unknown>,
    body_text: textFromNode(block),
  };
}

/** A body from stored or clipboard json; TypeError unless it is one valid block. */
export function parseBody(json: unknown): NoteBody {
  let block: PMNode;
  try {
    block = noteBodySchema.nodeFromJSON(json);
    block.check();
  } catch {
    throw new TypeError("Not a valid note body");
  }
  if (!block.type.isInGroup("block_body"))
    throw new TypeError("A note body is one block");
  block.descendants((node) => {
    for (const mark of node.marks)
      if (mark.type === noteBodySchema.marks.link && !isSafeHref(mark.attrs.href))
        throw new TypeError("A note link must be a web, mail or local address");
  });
  return bodyFromNode(block);
}

export const emptyBody = (): NoteBody => ({
  body_pm_json: { type: "paragraph" },
  body_text: "",
});

export function bodyText(text: string): NoteBody {
  const paragraph = noteBodySchema.nodes.paragraph!;
  return bodyFromNode(
    paragraph.create(null, text ? noteBodySchema.text(text) : null),
  );
}

export function docFromBody(body: NoteBody): PMNode {
  const block = noteBodySchema.nodeFromJSON(body.body_pm_json);
  return noteBodySchema.nodes.note_body_doc!.create(null, block);
}

// Object key order is not content; postgres jsonb and the editor return different orders.
const canonical = (json: unknown): string =>
  JSON.stringify(json, (_key, value: unknown) =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : value,
  );
export const sameBody = (a: NoteBody, b: NoteBody): boolean =>
  a.body_pm_json === b.body_pm_json ||
  (a.body_text === b.body_text && (
    JSON.stringify(a.body_pm_json) === JSON.stringify(b.body_pm_json) ||
    canonical(a.body_pm_json) === canonical(b.body_pm_json)
  ));

/** Only an unadorned empty paragraph is blank; all other rich structure is content. */
export function bodyHasContent(body: NoteBody): boolean {
  const json = body.body_pm_json;
  return json.type !== "paragraph" || ["content", "attrs", "marks"].some(key => {
    const value = json[key];
    return value !== undefined && value !== null && Object.keys(value).length > 0;
  });
}

// python str.strip/rstrip/splitlines whitespace and line breaks (U+FEFF is not one).
const SPACE = /[\p{White_Space}\u001c-\u001f]/u;
const TRAILING = /[\p{White_Space}\u001c-\u001f]+$/u;
const BREAK = /(\r\n|[\n\r\v\f\u001c-\u001e\u0085\u2028\u2029])/u;

/** Canonical prose projection never constructs inspection ranges while typing. */
function textFromNode(block: PMNode): string {
  const pieces: string[] = [];
  if (block.type.name === "object_embed") pieces.push(embedLabel(block));
  else block.descendants((node) => { pieces.push(textPiece(node)); });
  const text = pieces.join("").split(BREAK).map((part, index) =>
    index % 2 === 1 ? "\n" : part.replace(TRAILING, ""),
  ).join("");
  let first = 0;
  let last = text.length;
  while (first < last && SPACE.test(text[first]!)) first++;
  while (last > first && SPACE.test(text[last - 1]!)) last--;
  return text.slice(first, last);
}

function textPiece(node: PMNode): string {
  if (node.isText) return node.text!;
  switch (node.type.name) {
    case "hard_break": return "\n";
    case "object_embed": return embedLabel(node);
    case "image": return node.attrs.alt ?? "";
    default: return "";
  }
}

interface Span {
  readonly start: number;
  readonly end: number;
  readonly from: number;
  readonly to: number;
  readonly inline: boolean;
  readonly exact: string | null;
}

/**
 * The persisted text and, per piece of it, the editor range it came from (positions
 * are the block's as the one child of note_body_doc). Offsets count codepoints.
 */
export function projectBody(block: PMNode): { text: string; spans: Span[] } {
  const sources: { text: string; start: number; from: number; to: number; inline: boolean }[] = [];
  const rawPieces: string[] = [];
  let rawLength = 0;
  const add = (node: PMNode, at: number) => {
    const piece = textPiece(node);
    if (!piece) return;
    const to = at + node.nodeSize;
    sources.push({ text: piece, start: rawLength, from: at, to, inline: node.isText });
    rawPieces.push(piece);
    rawLength += piece.length;
  };
  if (block.type.name === "object_embed") add(block, 0);
  else block.descendants((node, at) => void add(node, at + 1));
  const raw = rawPieces.join("");
  // The final strip commutes with the per-line rstrip, so trim once and keep positions.
  let first = 0;
  let last = raw.length;
  while (first < last && SPACE.test(raw[first]!)) first++;
  while (last > first && SPACE.test(raw[last - 1]!)) last--;
  const text: string[] = [];
  let offset = 0;
  let sourceIndex = 0;
  const spans: Span[] = [];
  let cursor = first;
  raw
    .slice(first, last)
    .split(BREAK)
    .forEach((part, index) => {
      const isBreak = index % 2 === 1;
      const piece = isBreak ? "\n" : part.replace(TRAILING, "");
      if (piece) {
        const end = cursor + (isBreak ? part.length : piece.length);
        const exact = piece === raw.slice(cursor, end);
        const pieceEnd = offset + codepointLength(piece);
        let at = offset;
        while (sourceIndex < sources.length && sources[sourceIndex]!.start + sources[sourceIndex]!.text.length <= cursor) sourceIndex++;
        for (let index = sourceIndex; index < sources.length; index++) {
          const source = sources[index]!;
          if (source.start >= end) break;
          const a = Math.max(cursor, source.start);
          const b = Math.min(end, source.start + source.text.length);
          if (a >= b) continue;
          const length = codepointLength(raw.slice(a, b));
          spans.push({
            start: exact ? at : offset,
            end: exact ? at + length : pieceEnd,
            from: source.inline ? source.from + a - source.start : source.from,
            to: source.inline ? source.from + b - source.start : source.to,
            inline: source.inline,
            exact: exact && source.inline ? raw.slice(a, b) : null,
          });
          at += length;
        }
        text.push(piece);
        offset = pieceEnd;
      }
      cursor += part.length;
    });
  return { text: text.join(""), spans };
}

/** Decorations over stored-text codepoint offsets (a passage anchor or a citation). */
export function inspectionDecorations(
  doc: PMNode,
  target: { startOffset: number; endOffset: number },
): DecorationSet {
  const start = Math.max(0, Math.floor(target.startOffset));
  const end = Math.max(start, Math.floor(target.endOffset));
  const block = doc.firstChild;
  if (!block || end <= start) return DecorationSet.empty;
  const attrs = {
    class: "nexus-note-inspection",
    "data-note-inspection-range": "true",
  };
  const decorations: Decoration[] = [];
  for (const span of projectBody(block).spans) {
    if (span.end <= start || span.start >= end) continue;
    const from =
      span.exact === null
        ? span.from
        : span.from + codepointToUtf16(span.exact, Math.max(0, start - span.start));
    const to =
      span.exact === null
        ? span.to
        : span.from + codepointToUtf16(span.exact, Math.min(end, span.end) - span.start);
    const previous = decorations.at(-1);
    if (previous?.from === from && previous.to === to) continue;
    decorations.push(
      span.inline
        ? Decoration.inline(from, to, attrs)
        : Decoration.node(from, to, attrs),
    );
  }
  return DecorationSet.create(doc, decorations);
}
