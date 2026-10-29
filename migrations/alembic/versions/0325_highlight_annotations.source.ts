/** Frozen 0325 body grammar. Runtime executes the sibling bundled .mjs only.
 * Rebuild: bun build migrations/alembic/versions/0325_highlight_annotations.source.ts
 *   --target=node --minify --outfile=migrations/alembic/versions/0325_highlight_annotations.mjs
 * Dependencies are frozen into that artifact: yjs 13.6.33, prosemirror-model 1.25.4,
 * fractional-indexing 4.0.0. Never import application modules here.
 */
import * as Y from "../../../node/authored/node_modules/yjs/dist/yjs.mjs";
import { generateNKeysBetween } from "../../../node/authored/node_modules/fractional-indexing/src/index.js";
import { createHash } from "node:crypto";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
function isResourceRef(value: unknown): value is string {
  return typeof value === "string" && value.split(":").length === 2 && /^(media|library|evidence_span|content_chunk|highlight|page|note_block|fragment|conversation|message|oracle_reading|oracle_passage_anchor|external_snapshot|contributor|podcast|reader_apparatus_item|passage_anchor):/u.test(value) && UUID.test(value.split(":")[1] ?? "");
}
/** Permanent single-block grammar and canonical text/codepoint projection. Code is
 * presentation only: marks and atoms survive every format change. */

import {
  Schema,
  type MarkSpec,
  type Node as PMNode,
  type NodeSpec,
} from "../../../node/authored/node_modules/prosemirror-model/dist/index.js";


interface BodyMark { type: "strong" | "em" | "code" | "underline" | "strikethrough" | "link"; attrs?: Record<string, unknown> }
interface InlineNode { type: "text" | "hard_break" | "image" | "resource_embed"; text?: string; attrs?: Record<string, unknown>; marks?: BodyMark[] }
interface BodyJson extends Record<string, unknown> { type: "body"; attrs?: { presentation: "prose" | "code" }; content?: InlineNode[] }
interface NoteBody {
  readonly body_pm_json: BodyJson;
  readonly body_text: string;
}

/** `/`-relative (not `//`), http(s) with a host and no `%` authority, or bare mailto (I2). */
function isSafeHref(href: unknown): href is string {
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

const embedLabel = (node: PMNode): string => node.attrs.label ?? node.attrs.resource_ref;
const nodes = {
  note_body_doc: {content:"body"},
  body: {content:"inline*",group:"block",attrs:{presentation:{default:"prose"}}},
  text: {group:"inline"},
  hard_break: {inline:true,group:"inline"},
  image: {inline:true,group:"inline",attrs:{src:{},alt:{default:null},title:{default:null}}},
  resource_embed: {inline:true,group:"inline",atom:true,attrs:{resource_ref:{},field:{default:null},label:{default:null}}},
} satisfies Record<string,NodeSpec>;
const marks = {
  strong:{},em:{},code:{},underline:{},strikethrough:{},
  link:{attrs:{href:{},title:{default:null}},inclusive:false},
} satisfies Record<string,MarkSpec>;

const noteBodySchema = new Schema({
  topNode: "note_body_doc",
  nodes,
  marks,
});

function bodyFromNode(block: PMNode): NoteBody {
  return {
    // justify-type-assertion: a node's toJSON is a plain object.
    body_pm_json: block.toJSON() as BodyJson,
    body_text: textFromNode(block),
  };
}

/** A body from stored or clipboard json; TypeError unless it is one valid block. */
function parseBody(json: unknown): NoteBody {
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

/** Only an unadorned empty paragraph is blank; all other rich structure is content. */
function bodyHasContent(body: NoteBody): boolean {
  const block = noteBodySchema.nodeFromJSON(parseBody(body.body_pm_json).body_pm_json);
  return block.attrs.presentation === "code" || block.content.size > 0;
}

// python str.strip/rstrip/splitlines whitespace and line breaks (U+FEFF is not one).
const SPACE = /[\p{White_Space}\u001c-\u001f]/u;
const TRAILING = /[\p{White_Space}\u001c-\u001f]+$/u;
const BREAK = /(\r\n|[\n\r\v\f\u001c-\u001e\u0085\u2028\u2029])/u;

/** Literal canonical pieces for copying: preserve whitespace and line endings. */
function rawBodyText(block: PMNode): string {
  const pieces: string[] = [];
  block.descendants((node) => { pieces.push(textPiece(node)); });
  return pieces.join("");
}

/** Canonical prose projection never constructs inspection ranges while typing. */
function textFromNode(block: PMNode): string {
  const text = rawBodyText(block).split(BREAK).map((part, index) =>
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

function isSafeImage(src: unknown): src is string {
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
  const allowed = kind === "body" ? ["presentation"] : kind === "image" ? ["src", "alt", "title"] : kind === "resource_embed" ? ["resource_ref", "field", "label"] : [];
  if (Object.keys(attrs).some(key => !allowed.includes(key))) throw new TypeError("Unsupported node attributes");
  if (kind === "body" && attrs.presentation !== undefined && !["prose", "code"].includes(String(attrs.presentation))) throw new TypeError("Invalid presentation");
  if (kind === "image" && !isSafeImage(attrs.src)) throw new TypeError("Invalid image source");
  if (kind === "resource_embed") {
    if (!isResourceRef(attrs.resource_ref)) throw new TypeError("Invalid embedded reference");
    if (attrs.field !== null && (attrs.field !== "annotation" || !attrs.resource_ref.startsWith("highlight:"))) throw new TypeError("Invalid embedded resource field");
  }
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

function bodyParts(doc: Y.Doc): { element: Y.XmlElement; inline: Y.XmlText } {
  if ([...doc.share.keys()].some(key => key !== "body")) throw new TypeError("unknown body root");
  const roots = doc.getXmlFragment("body").toArray();
  if (roots.length !== 1 || !(roots[0] instanceof Y.XmlElement) || roots[0].nodeName !== "body") throw new TypeError("expected one permanent body element");
  const children = roots[0].toArray();
  if (children.length !== 1 || !(children[0] instanceof Y.XmlText)) throw new TypeError("expected one permanent inline XmlText");
  if (Object.keys(roots[0].getAttributes()).some(key => key !== "presentation")) throw new TypeError("unknown body attribute");
  return { element: roots[0], inline: children[0] };
}
function readBody(doc: Y.Doc, legacy: boolean): NoteBody {
  const { element, inline } = bodyParts(doc);
  const content = inline.toDelta().map(delta => {
    const marks = Object.entries(delta.attributes ?? {}).map(([type, attrs]) => ({type, attrs}));
    if (typeof delta.insert === "string") return {type:"text",text:delta.insert,marks};
    const atom = structuredClone(record(delta.insert));
    if (legacy && atom.type === "resource_embed") {
      const attrs = record(atom.attrs);
      if ("field" in attrs) throw new TypeError("old-format embed already has a field");
      atom.attrs = {...attrs,field:null};
    }
    return {...atom,marks};
  });
  return parseBody({type:"body",attrs:{presentation:element.getAttribute("presentation") ?? "prose"},content});
}
function decode(state: string): Uint8Array {
  if (typeof state !== "string" || !/^[A-Za-z0-9_-]+$/u.test(state)) throw new TypeError("invalid base64url body state");
  const bytes = Buffer.from(state,"base64url");
  if (bytes.toString("base64url") !== state) throw new TypeError("noncanonical base64url body state");
  return bytes;
}
function href(value: string, mapping: Record<string,string>): string {
  const match = /^\/notes\/([0-9a-f-]{36})(\?[^#]*)?(#.*)?$/u.exec(value);
  if (!match || !UUID.test(match[1]!)) return value;
  const target = mapping[`note_block:${match[1]}`];
  if (!target) return value;
  const hash = match[3];
  if (hash && (!hash.startsWith("#passage-") || !UUID.test(hash.slice(9)))) throw new TypeError(`unsupported note destination ${value}; repair its fragment before retrying`);
  return `/highlights/${target.split(":")[1]}${match[2] ?? ""}${hash ?? "#annotation"}`;
}
function convertBody(input: {ref:string;state:string|null}, mapping: Record<string,string>) {
  const doc = new Y.Doc({gc:false});
  try {
    if (input.state === null) {
      doc.clientID = createHash("sha256").update(`0325:${input.ref}`).digest().readUInt32BE();
      const element = new Y.XmlElement("body");
      doc.getXmlFragment("body").insert(0,[element]);
      element.setAttribute("presentation","prose");
      element.insert(0,[new Y.XmlText()]);
    } else Y.applyUpdate(doc,decode(input.state));
    if (doc.store.pendingStructs !== null || doc.store.pendingDs !== null) throw new TypeError("body update has missing causal dependencies");
    const parts = bodyParts(doc);
    const before = readBody(doc,input.state !== null);
    const vector = Buffer.from(Y.encodeStateVector(doc)).toString("base64url");
    let changed = input.state === null;
    // A format cut rewrites retained struct payloads, not the Yjs edit history.
    // Preserve ids of roots, text, atoms and marks, including retained tombstones.
    // No old-format writer can replay these structs beyond the snapshot floor.
    for (const structs of doc.store.clients.values()) for (const item of structs) {
      if (!(item instanceof Y.Item)) continue;
      if (item.content instanceof Y.ContentEmbed) {
        const atom = record(item.content.embed);
        if (!["hard_break","image","resource_embed"].includes(String(atom.type))) throw new TypeError("unsupported retained inline atom");
        if (atom.type === "resource_embed") {
          const attrs = record(atom.attrs);
          if ("field" in attrs) throw new TypeError("old-format embed already has a field");
          const oldRef = String(attrs.resource_ref);
          const target = mapping[oldRef];
          atom.attrs = {...attrs,resource_ref:target ?? oldRef,field:target ? "annotation" : null,label:target && attrs.label == null ? oldRef : attrs.label ?? null};
          item.content.embed = atom;
          changed = true;
        }
        parseBody({type:"body",content:[atom]});
      } else if (item.content instanceof Y.ContentFormat && item.content.key === "link" && item.content.value !== null) {
        const attrs = record(item.content.value);
        const oldHref = attrs.href;
        if (typeof oldHref !== "string") throw new TypeError("invalid retained link mark");
        const next = href(oldHref,mapping);
        if (next !== oldHref) { item.content.value = {...attrs,href:next}; changed = true; }
      }
    }
    const body = readBody(doc,false);
    if (bodyParts(doc).element !== parts.element || bodyParts(doc).inline !== parts.inline || Buffer.from(Y.encodeStateVector(doc)).toString("base64url") !== vector) throw new TypeError("conversion changed permanent body identity or causal vector");
    if (before.body_text !== body.body_text) throw new TypeError("reference conversion changed canonical body text");
    return {ref:input.ref,body_state:changed ? Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64url") : input.state,...body,has_content:bodyHasContent(body),embedded_refs:[...new Set((body.body_pm_json.content ?? []).filter(node=>node.type === "resource_embed").map(node=>String(node.attrs!.resource_ref)))]};
  } finally { doc.destroy(); }
}
let raw = "";
for await (const part of process.stdin) {raw += part;if (Buffer.byteLength(raw)>32*1024*1024) throw new TypeError("0325 converter input exceeds 32 MiB; split the batch");}
const input = JSON.parse(raw);
let result;
try {
  if (input.op === "positions") result = {positions:generateNKeysBetween(input.lower,input.upper,input.count)};
  else if (input.op === "validate_positions") {
    for (const position of input.positions) {
      try {generateNKeysBetween(position.value,null,1);}
      catch(error) {throw new TypeError(`link ${position.record}: invalid fractional position ${position.value}; ${error.message}`);}
    }
    result = {valid:true};
  }
  else if (input.op === "bodies") result = {bodies:input.bodies.map(body=>{
    try {return convertBody(body,input.mapping);} catch(error) {throw new TypeError(`body ${body.ref}: ${error.message}; repair the source body before retrying`);}
  })};
  else throw new TypeError("unknown 0325 converter operation");
} catch(error) {process.stderr.write(`0325 ${error.message}\n`);process.exit(1);}
process.stdout.write(JSON.stringify(result));
