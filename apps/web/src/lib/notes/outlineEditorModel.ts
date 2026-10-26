/** The outline is an ephemeral flat view of independently owned fields. Only
 * semantic/projection transactions may change its rows. Ordinary edits are
 * admitted against EACH step's input document before any authored write. */
import {Fragment, Schema, Slice, type Node as PMNode} from "prosemirror-model";
import type {Transaction} from "prosemirror-state";
import {noteBodySchema, parseBody, type NoteBody} from "@nexus/authored/body";
import type {BodyEdit} from "@nexus/authored/documents";

export const outlineTransactionSource = "outlineTransactionSource";
export const outlineEditedField = "outlineEditedField";

export const outlineEditorSchema = new Schema({
  topNode: "outline_doc",
  nodes: noteBodySchema.spec.nodes.remove("note_body_doc").prepend({
    outline_doc: {content: "(note_row | title_row | reference_row)*"},
    note_row: {
      content: "body", isolating: true,
      attrs: {row_id: {}, depth: {default: 0}},
      toDOM: node => ["div", {"data-outline-row": node.attrs.row_id, "data-outline-kind": "note", "data-depth": node.attrs.depth}, 0],
    },
    title_row: {
      content: "text*", marks: "", whitespace: "pre", isolating: true,
      attrs: {row_id: {}, depth: {default: 0}},
      toDOM: node => ["div", {"data-outline-row": node.attrs.row_id, "data-outline-kind": "title", "data-depth": node.attrs.depth}, 0],
    },
    reference_row: {
      atom: true, selectable: true,
      attrs: {row_id: {}, depth: {default: 0}},
      toDOM: node => ["div", {"data-outline-row": node.attrs.row_id, "data-outline-kind": "reference", "data-depth": node.attrs.depth, contenteditable: "false"}],
    },
  }),
  marks: noteBodySchema.spec.marks,
});

export interface OutlineField {
  row_id: string;
  kind: "body" | "title";
  /** Global positions of the inline content, excluding its wrapping node. */
  from: number;
  to: number;
  node: PMNode;
}

/** At a row boundary association chooses the preceding or following row. A
 * read-only reference is a barrier; this never searches past it for text. */
export function fieldAt(doc: PMNode, position: number, assoc: -1 | 1 = 1): OutlineField | null {
  if (position < 0 || position > doc.content.size) return null;
  let field: OutlineField | null = null;
  doc.forEach((row, at) => {
    if (position < at || position > at + row.nodeSize ||
      position === at && assoc < 0 || position === at + row.nodeSize && assoc > 0) return;
    if (row.type.name === "note_row") {
      const body = row.firstChild!;
      field = {row_id: row.attrs.row_id, kind: "body", from: at + 2, to: at + 2 + body.content.size, node: body};
    } else if (row.type.name === "title_row") {
      field = {row_id: row.attrs.row_id, kind: "title", from: at + 1, to: at + 1 + row.content.size, node: row};
    }
  });
  return field;
}

export function fieldById(doc: PMNode, row_id: string): OutlineField | null {
  let field: OutlineField | null = null;
  doc.forEach((row, at) => {if (row.attrs.row_id === row_id) field = fieldAt(doc, at, 1);});
  return field;
}

export function canonicalBody(field: OutlineField): NoteBody {
  if (field.kind !== "body") throw new TypeError("a title is not a note body");
  return parseBody(field.node.toJSON());
}

export function plainTitle(field: OutlineField): string {
  if (field.kind !== "title") throw new TypeError("a note body is not a title");
  return field.node.textContent;
}

export type OutlineFieldEdit =
  | {kind: "body"; field: OutlineField; edit: BodyEdit}
  | {kind: "title"; field: OutlineField; from: number; to: number; text: string};
export type OutlineStepRoute =
  | {kind: "edit"; edit: OutlineFieldEdit}
  | {kind: "refused"; reason: string};
export type OutlineTransactionRoute =
  | {kind: "edit"; edits: OutlineFieldEdit[]}
  | {kind: "projection" | "semantic"}
  | {kind: "refused"; reason: string};

/** Positions belong to the document BEFORE this step, never the transaction's
 * final document. Row wrappers/attributes cannot leak into authored fields. */
export function routeInlineStep(before: PMNode, step: Transaction["steps"][number]): OutlineStepRoute {
  const json = step.toJSON();
  if (json.stepType !== "replace" && json.stepType !== "addMark" && json.stepType !== "removeMark")
    return {kind: "refused", reason: "this operation changes outline structure"};
  const field = fieldAt(before, json.from, 1), end = fieldAt(before, json.to, json.to === json.from ? 1 : -1);
  if (!field || !end || field.row_id !== end.row_id || json.from < field.from || json.to > field.to)
    return {kind: "refused", reason: "text editing must stay within one field"};
  const from = json.from - field.from, to = json.to - field.from;
  if (json.stepType === "replace") {
    const slice = Slice.fromJSON(outlineEditorSchema, json.slice);
    let inline = slice.openStart === 0 && slice.openEnd === 0;
    slice.content.forEach(node => { if (!node.isInline) inline = false; });
    if (!inline) return {kind: "refused", reason: "paste must be reduced to field content"};
    if (field.kind === "title") {
      let plain = true;
      slice.content.forEach(node => { if (!node.isText || node.marks.length) plain = false; });
      if (!plain) return {kind: "refused", reason: "page titles accept plain text only"};
      return {kind: "edit", edit: {kind: "title", field, from, to, text: slice.content.textBetween(0, slice.content.size)}};
    }
    const content = parseBody({type: "body", content: slice.content.toJSON() ?? []}).body_pm_json.content ?? [];
    return {kind: "edit", edit: {kind: "body", field, edit: {kind: "replace", from, to, content}}};
  }
  if (field.kind === "title") return {kind: "refused", reason: "page titles accept plain text only"};
  const mark = parseBody({type: "body", content: [{type: "text", text: "x", marks: [json.mark]}]}).body_pm_json.content![0]!.marks![0]!;
  return {kind: "edit", edit: {kind: "body", field, edit: {kind: json.stepType === "addMark" ? "add_mark" : "remove_mark", from, to, mark}}};
}

/** Plan the WHOLE transaction first. A later refused step must not leave an
 * earlier step already applied to an independent canonical document. */
export function routeInlineTransaction(transaction: Transaction): OutlineTransactionRoute {
  const source = transaction.getMeta(outlineTransactionSource);
  if (source === "projection" || source === "semantic") return {kind: source};
  const edits: OutlineFieldEdit[] = [];
  for (const [index, step] of transaction.steps.entries()) {
    const routed = routeInlineStep(transaction.docs[index]!, step);
    if (routed.kind === "refused") return routed;
    if (edits.length && edits[0]!.field.row_id !== routed.edit.field.row_id)
      return {kind: "refused", reason: "text editing must stay within one field"};
    edits.push(routed.edit);
  }
  return {kind: "edit", edits};
}

/** Clipboard wrappers describe a view, never resource identity. Flatten text
 * blocks before constructing an ordinary replacement; retain rich inline data
 * for bodies and explicitly strip it for titles. Structural resource copying
 * uses the outline clipboard owner instead. */
export function inlinePaste(slice: Slice, kind: OutlineField["kind"]): Slice {
  const blocks: Fragment[] = [];
  let inline: PMNode[] = [];
  const collect = (node: PMNode) => {
    if (node.isInline) {inline.push(node); return;}
    if (node.type.name === "reference_row") throw new TypeError("resource rows require block paste");
    if (node.isTextblock) {
      if (inline.length) {blocks.push(Fragment.fromArray(inline)); inline = [];}
      blocks.push(node.content);
    } else node.forEach(collect);
  };
  slice.content.forEach(collect);
  if (inline.length) blocks.push(Fragment.fromArray(inline));
  const nodes: PMNode[] = [];
  for (const [index, block] of blocks.entries()) {
    if (index) nodes.push(outlineEditorSchema.nodes.hard_break!.create());
    block.forEach(node => nodes.push(node));
  }
  const content = Fragment.fromArray(nodes);
  const body = parseBody({type: "body", content: content.toJSON() ?? []});
  if (kind === "body") return new Slice(outlineEditorSchema.nodeFromJSON(body.body_pm_json).content, 0, 0);
  const text = content.textBetween(0, content.size, "", node =>
    node.type.name === "hard_break" ? "\n" : node.type.name === "image" ? node.attrs.alt ?? "" : node.attrs.label ?? node.attrs.resource_ref ?? "");
  return new Slice(text ? Fragment.from(outlineEditorSchema.text(text)) : Fragment.empty, 0, 0);
}
