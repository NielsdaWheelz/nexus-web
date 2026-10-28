/** A note has one permanent body element and one permanent inline Y.XmlText.
 * Text, marks and embedded atoms share UTF-16 positions (atoms occupy one). This
 * avoids tree bindings copying/deleting adjacent text containers during atom edits. */
import * as Y from "yjs";
import { parseBody, type NoteBody, type InlineNode, type BodyMark } from "./body.ts";
export const LOCAL_EDIT = Symbol("authored local edit");
export type BodyEdit =
  | { kind: "replace"; from: number; to: number; content: InlineNode[] }
  | { kind: "add_mark" | "remove_mark"; from: number; to: number; mark: BodyMark }
  | { kind: "presentation"; value: "prose" | "code" };
export function encodeBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}
export function decodeBytes(encoded: string): Uint8Array {
  if (typeof encoded !== "string" || !/^[A-Za-z0-9_-]*$/u.test(encoded) || encoded.length % 4 === 1) throw new TypeError("Invalid base64url update");
  const binary = atob(encoded.replaceAll("-", "+").replaceAll("_", "/"));
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
  if (encodeBytes(bytes) !== encoded) throw new TypeError("Noncanonical base64url update");
  return bytes;
}
export function bodyElement(doc: Y.Doc): Y.XmlElement {
  const children = doc.getXmlFragment("body").toArray();
  if (children.length !== 1 || !(children[0] instanceof Y.XmlElement) || children[0].nodeName !== "body") throw new TypeError("A note must retain exactly one permanent body");
  return children[0];
}
export function bodyInline(doc: Y.Doc): Y.XmlText {
  const children = bodyElement(doc).toArray();
  if (children.length !== 1 || !(children[0] instanceof Y.XmlText)) throw new TypeError("A body must retain its permanent inline text");
  return children[0];
}
function attributes(marks: readonly BodyMark[]): Record<string, unknown> {
  return Object.fromEntries(marks.map(mark => [mark.type, mark.attrs ?? {}]));
}
function insert(inline: Y.XmlText, position: number, content: readonly InlineNode[]): void {
  for (const node of content) {
    const attrs = attributes(node.marks ?? []);
    if (node.type === "text") {
      inline.insert(position, node.text!, attrs);
      position += node.text!.length;
    } else {
      inline.insertEmbed(position, { type: node.type, attrs: node.attrs ?? {} }, attrs);
      position++;
    }
  }
}
export function readBody(doc: Y.Doc): NoteBody {
  if ([...doc.share.keys()].some(key => key !== "body")) throw new TypeError("Unknown note root");
  const body = bodyElement(doc);
  const attrs = body.getAttributes();
  if (Object.keys(attrs).some(key => key !== "presentation")) throw new TypeError("Unknown body attribute");
  const content: InlineNode[] = [];
  for (const delta of bodyInline(doc).toDelta()) {
    // justify-type-assertion: parseBody below validates all marks before publication.
    const marks = Object.entries(delta.attributes ?? {}).map(([type, attrs]) => ({ type, attrs })) as BodyMark[];
    if (typeof delta.insert === "string") {
      if (delta.insert.length) content.push({ type: "text", text: delta.insert, marks });
    } else {
      if (!delta.insert || typeof delta.insert !== "object" || Array.isArray(delta.insert)) throw new TypeError("Invalid inline atom");
      content.push({ ...delta.insert, marks });
    }
  }
  return parseBody({ type: "body", attrs: { presentation: attrs.presentation ?? "prose" }, content });
}
export function createNote(body: NoteBody): string {
  const valid = parseBody(body.body_pm_json);
  const doc = new Y.Doc();
  try {
    doc.transact(() => {
      const element = new Y.XmlElement("body");
      doc.getXmlFragment("body").insert(0, [element]);
      element.setAttribute("presentation", String(valid.body_pm_json.attrs?.presentation ?? "prose"));
      const inline = new Y.XmlText();
      element.insert(0, [inline]);
      insert(inline, 0, valid.body_pm_json.content ?? []);
    });
    readBody(doc);
    return encodeBytes(Y.encodeStateAsUpdate(doc));
  } finally { doc.destroy(); }
}
export function hydrateNote(state: string): Y.Doc {
  const doc = new Y.Doc();
  try { Y.applyUpdate(doc, decodeBytes(state)); readBody(doc); return doc; }
  catch (error) { doc.destroy(); throw error; }
}
export function mergeNote(state: string | null, update: string | null): { body_state: string; body: NoteBody } {
  if (state === null && update === null) throw new TypeError("Unknown note needs a complete initializer");
  const doc = new Y.Doc();
  try {
    if (state !== null) Y.applyUpdate(doc, decodeBytes(state));
    const permanent = state === null ? null : bodyElement(doc);
    const inline = state === null ? null : bodyInline(doc);
    if (update !== null) Y.applyUpdate(doc, decodeBytes(update));
    if (permanent !== null && (bodyElement(doc) !== permanent || bodyInline(doc) !== inline)) throw new TypeError("An edit replaced the permanent body or inline text");
    const body = readBody(doc);
    return { body_state: encodeBytes(Y.encodeStateAsUpdate(doc)), body };
  } finally { doc.destroy(); }
}
export function applyBodyEdits(doc: Y.Doc, edits: readonly BodyEdit[], origin: unknown = LOCAL_EDIT): void {
  const inline = bodyInline(doc);
  let length = inline.length;
  for (const edit of edits) {
    if (edit.kind === "presentation") {
      if (edit.value !== "prose" && edit.value !== "code") throw new TypeError("Invalid presentation");
      continue;
    }
    if (!Number.isInteger(edit.from) || !Number.isInteger(edit.to) || edit.from < 0 || edit.to < edit.from || edit.to > length) throw new TypeError("Body edit is outside displayed content");
    if (edit.kind === "replace") {
      parseBody({type:"body",content:edit.content});
      length += edit.content.reduce((n,node)=>n+(node.type === "text" ? node.text!.length : 1),0) - (edit.to-edit.from);
    } else parseBody({type:"body",content:[{type:"text",text:"x",marks:[edit.mark]}]});
  }
  doc.transact(() => {
    for (const edit of edits) {
      if (edit.kind === "presentation") { bodyElement(doc).setAttribute("presentation", edit.value); continue; }
      if (!Number.isInteger(edit.from) || !Number.isInteger(edit.to) || edit.from < 0 || edit.to < edit.from || edit.to > inline.length) throw new TypeError("Body edit is outside displayed content");
      if (edit.kind === "replace") {
        parseBody({ type: "body", content: edit.content });
        inline.delete(edit.from, edit.to - edit.from);
        insert(inline, edit.from, edit.content);
      } else {
        parseBody({ type: "body", content: [{ type: "text", text: "x", marks: [edit.mark] }] });
        inline.format(edit.from, edit.to - edit.from, { [edit.mark.type]: edit.kind === "remove_mark" ? null : edit.mark.attrs ?? {} });
      }
    }
  }, origin);
}
export function createTitle(title: string): string {
  if (typeof title !== "string") throw new TypeError("Expected title text");
  const doc = new Y.Doc();
  try { doc.getText("title").insert(0, title); return encodeBytes(Y.encodeStateAsUpdate(doc)); }
  finally { doc.destroy(); }
}
export function mergeTitle(state: string | null, update: string | null): { title_state: string; title: string } {
  const doc = new Y.Doc();
  try {
    if (state !== null) Y.applyUpdate(doc, decodeBytes(state));
    if (update !== null) Y.applyUpdate(doc, decodeBytes(update));
    if ([...doc.share.keys()].some(key => key !== "title")) throw new TypeError("Unknown page root");
    return { title_state: encodeBytes(Y.encodeStateAsUpdate(doc)), title: doc.getText("title").toString() };
  } finally { doc.destroy(); }
}
/** Structural preparation freezes the displayed suffix/content and emits only
 * incremental deletes/inserts. Unseen source insertions are never moved/deleted. */
export function splitBody(state: string, offset: number): { source_update: string; suffix: NoteBody } {
  const doc = hydrateNote(state);
  try {
    const before = Y.encodeStateVector(doc);
    const body = readBody(doc);
    const content = sliceInline(doc, offset, bodyInline(doc).length);
    const suffix = parseBody({ type: "body", attrs: body.body_pm_json.attrs, content });
    applyBodyEdits(doc, [{ kind: "replace", from: offset, to: bodyInline(doc).length, content: [] }]);
    return { source_update: encodeBytes(Y.encodeStateAsUpdate(doc, before)), suffix };
  } finally { doc.destroy(); }
}
export function sliceInline(doc: Y.Doc, from: number, to: number): InlineNode[] {
  const inline = bodyInline(doc);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to > inline.length) throw new TypeError("Invalid inline slice");
  const content: InlineNode[] = [];
  let offset = 0;
  for (const delta of inline.toDelta()) {
    const length = typeof delta.insert === "string" ? delta.insert.length : 1;
    const a = Math.max(0, from - offset), b = Math.min(length, to - offset);
    if (a < b) {
      // justify-type-assertion: readBody/parseBody validate all encoded marks.
      const marks = Object.entries(delta.attributes ?? {}).map(([type, attrs]) => ({ type, attrs })) as BodyMark[];
      if (typeof delta.insert === "string") content.push({ type: "text", text: delta.insert.slice(a, b), marks });
      else content.push({ ...delta.insert, marks });
    }
    offset += length;
    if (offset >= to) break;
  }
  parseBody({ type: "body", content });
  return content;
}

/** Minimal replacement boundaries in utf16 offsets, expanded to whole codepoints. */
export function textReplacement(old:string,next:string):{from:number;to:number;text:string} {
  let first=0,oldEnd=old.length,newEnd=next.length;
  while(first<oldEnd && first<newEnd && old[first]===next[first])first++;
  while(oldEnd>first && newEnd>first && old[oldEnd-1]===next[newEnd-1]){oldEnd--;newEnd--;}
  const split=(value:string,index:number)=>index>0 && index<value.length && /[\uD800-\uDBFF]/u.test(value[index-1]!) && /[\uDC00-\uDFFF]/u.test(value[index]!);
  if(split(old,first)||split(next,first))first--;
  if(split(old,oldEnd))oldEnd++;
  if(split(next,newEnd))newEnd++;
  return {from:first,to:oldEnd,text:next.slice(first,newEnd)};
}
