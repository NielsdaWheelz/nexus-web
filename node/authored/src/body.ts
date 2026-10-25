/** Permanent single-block grammar and canonical text/codepoint projection. Code is
 * presentation only: marks and atoms survive every format change. */
import { isResourceRef } from "./identity.ts";
import {
  Schema,
  type MarkSpec,
  type Node as PMNode,
  type NodeSpec,
} from "prosemirror-model";
import {
  codepointLength,
} from "./codepoints.ts";

export interface BodyMark { type: "strong" | "em" | "code" | "underline" | "strikethrough" | "link"; attrs?: Record<string, unknown> }
export interface InlineNode { type: "text" | "hard_break" | "image" | "resource_embed"; text?: string; attrs?: Record<string, unknown>; marks?: BodyMark[] }
export interface BodyJson extends Record<string, unknown> { type: "body"; attrs?: { presentation: "prose" | "code" }; content?: InlineNode[] }
export interface NoteBody {
  readonly body_pm_json: BodyJson;
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

const embedLabel = (node: PMNode): string => node.attrs.label ?? node.attrs.resource_ref;
const nodes = {
  note_body_doc: { content: "body" },
  body: {
    content: "inline*", group: "block_body block",
    attrs: { presentation: { default: "prose" } },
    parseDOM: [{ tag: "p" }, { tag: "pre", getAttrs: () => ({presentation:"code"}), preserveWhitespace: "full" }],
    toDOM: (node) => node.attrs.presentation === "code" ? ["pre", {"data-presentation":"code"}, ["code", 0]] : ["p", 0],
  },
  text: { group: "inline" },
  hard_break: { inline:true, group:"inline", selectable:false, parseDOM:[{tag:"br"}], toDOM:()=>["br"] },
  image: {
    inline:true, group:"inline", draggable:false,
    attrs:{src:{},alt:{default:null},title:{default:null}},
    parseDOM:[{tag:"img[src]",getAttrs:dom=>({src:dom.getAttribute("src"),alt:dom.getAttribute("alt"),title:dom.getAttribute("title")})}],
    toDOM:node=>["img",{...node.attrs,draggable:"false"}],
  },
  resource_embed: {
    inline:true,group:"inline",atom:true,selectable:true,
    attrs:{resource_ref:{},label:{default:null}},
    parseDOM:[{tag:"span[data-resource-ref]",getAttrs:dom=>({resource_ref:dom.getAttribute("data-resource-ref"),label:dom.getAttribute("data-label")})}],
    toDOM:node=>["span",{"data-resource-ref":node.attrs.resource_ref,"data-label":node.attrs.label,contenteditable:"false",class:"note-resource-embed"},embedLabel(node)],
  },
} satisfies Record<string,NodeSpec>;

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
    body_pm_json: block.toJSON() as BodyJson,
    body_text: textFromNode(block),
  };
}

/** A body from stored or clipboard json; TypeError unless it is one valid block. */
export function parseBody(json: unknown): NoteBody {
  validateBodyJson(json);
  let block: PMNode;
  try {
    block = noteBodySchema.nodeFromJSON(json);
    block.check();
  } catch {
    throw new TypeError("Not a valid note body");
  }
  if (block.type.name !== "body" || !["prose", "code"].includes(block.attrs.presentation))
    throw new TypeError("A note body is one block");
  block.descendants((node) => {
    if (node.type.name === "image" && !isSafeImage(node.attrs.src)) throw new TypeError("Invalid image source");
    if (node.type.name === "resource_embed" && !isResourceRef(node.attrs.resource_ref)) throw new TypeError("Invalid resource reference");
    for (const mark of node.marks)
      if (mark.type === noteBodySchema.marks.link && !isSafeHref(mark.attrs.href))
        throw new TypeError("A note link must be a web, mail or local address");
  });
  return bodyFromNode(block);
}

export const emptyBody = (): NoteBody => bodyText("");

export function bodyText(text: string): NoteBody {
  const paragraph = noteBodySchema.nodes.body!;
  return bodyFromNode(
    paragraph.create(null, text ? noteBodySchema.text(text) : null),
  );
}

export function docFromBody(body: NoteBody): PMNode {
  const block = noteBodySchema.nodeFromJSON(parseBody(body.body_pm_json).body_pm_json);
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
  const block = noteBodySchema.nodeFromJSON(parseBody(body.body_pm_json).body_pm_json);
  return block.attrs.presentation === "code" || block.content.size > 0;
}

// python str.strip/rstrip/splitlines whitespace and line breaks (U+FEFF is not one).
const SPACE = /[\p{White_Space}\u001c-\u001f]/u;
const TRAILING = /[\p{White_Space}\u001c-\u001f]+$/u;
const BREAK = /(\r\n|[\n\r\v\f\u001c-\u001e\u0085\u2028\u2029])/u;

/** Canonical prose projection never constructs inspection ranges while typing. */
function textFromNode(block: PMNode): string {
  const pieces: string[] = [];
  block.descendants((node) => { pieces.push(textPiece(node)); });
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
    case "resource_embed": return embedLabel(node);
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
  block.descendants((node, at) => void add(node, at + 1));
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


export function isSafeImage(src: unknown): src is string {
  return typeof src === "string" && (isSafeHref(src) && !src.startsWith("mailto:"));
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Expected body object");
  return Object.fromEntries(Object.entries(value));
}
function validateBodyJson(value: unknown, inline = false): void {
  const node = record(value);
  if (Object.keys(node).some(key => !["type", "attrs", "content", "marks", "text"].includes(key))) throw new TypeError("Unsupported body fields");
  const kind = node.type;
  if ((!inline && kind !== "body") || (inline && !["text", "hard_break", "image", "resource_embed"].includes(String(kind)))) throw new TypeError("Invalid body node");
  const attrs = node.attrs == null ? {} : record(node.attrs);
  const allowed = kind === "body" ? ["presentation"] : kind === "image" ? ["src", "alt", "title"] : kind === "resource_embed" ? ["resource_ref", "label"] : [];
  if (Object.keys(attrs).some(key => !allowed.includes(key))) throw new TypeError("Unsupported node attributes");
  if (kind === "body" && attrs.presentation !== undefined && !["prose", "code"].includes(String(attrs.presentation))) throw new TypeError("Invalid presentation");
  if (kind === "image" && !isSafeImage(attrs.src)) throw new TypeError("Invalid image source");
  if (kind === "resource_embed" && !isResourceRef(attrs.resource_ref)) throw new TypeError("Invalid embedded reference");
  for (const key of ["alt", "title", "label"]) if (attrs[key] != null && typeof attrs[key] !== "string") throw new TypeError("Invalid literal attribute");
  if (kind === "text") {
    if (typeof node.text !== "string" || node.text.length === 0 || /[\uD800-\uDFFF]/u.test(node.text) || node.content !== undefined) throw new TypeError("Invalid text node");
  } else if (node.text !== undefined) throw new TypeError("Text belongs to text nodes");
  if (node.content !== undefined) {
    if (kind !== "body" || !Array.isArray(node.content)) throw new TypeError("Only the body contains inline nodes");
    node.content.forEach(child => validateBodyJson(child, true));
  }
  if (node.marks !== undefined) {
    if (!inline || !Array.isArray(node.marks)) throw new TypeError("Invalid marks");
    for (const value of node.marks) {
      const mark = record(value);
      if (Object.keys(mark).some(key => !["type", "attrs"].includes(key)) || !["strong", "em", "code", "underline", "strikethrough", "link"].includes(String(mark.type))) throw new TypeError("Invalid mark");
      const a = mark.attrs == null ? {} : record(mark.attrs);
      if (mark.type === "link") {
        if (Object.keys(a).some(key => !["href", "title"].includes(key)) || !isSafeHref(a.href) || (a.title != null && typeof a.title !== "string")) throw new TypeError("Invalid link mark");
      } else if (Object.keys(a).length > 0) throw new TypeError("Unsupported mark attributes");
    }
  }
}
