/** Narrow ProseMirror/Yjs binding for the one permanent inline text. A view keeps
 * its displayed baseline through IME or reference input; incoming edits merge
 * before the next normal render. User steps retain observed character identity. */
import * as Y from "yjs";
import { Fragment, Slice } from "prosemirror-model";
import { TextSelection, type Transaction } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { docFromBody, noteBodySchema, sameBody, type InlineNode, type NoteBody } from "@nexus/authored/body";
import { applyBodyEdits, bodyInline, readBody, LOCAL_EDIT, type BodyEdit } from "@nexus/authored/documents";
import type { WritingDocument } from "./runtime";
export class InlineBinding {
  readonly baseline = new Y.Doc();
  private view: EditorView | null = null;
  private deferred: () => boolean = () => false;
  private updating = false;
  private readonly receive = () => this.refresh();
  constructor(private readonly document: WritingDocument, private readonly origin: unknown = LOCAL_EDIT) { Y.applyUpdate(this.baseline, Y.encodeStateAsUpdate(document.doc)); }
  body(): NoteBody { return readBody(this.baseline); }
  attach(view: EditorView, deferred: () => boolean): void {
    this.view = view; this.deferred = deferred;
    this.document.doc.on("update", this.receive);
  }
  apply(transaction: Transaction): void {
    this.updating = true;
    try {
      applyBodyEdits(this.baseline, transactionEdits(transaction));
      Y.applyUpdate(this.document.doc, Y.encodeStateAsUpdate(this.baseline, Y.encodeStateVector(this.document.doc)), this.origin);
    } finally { this.updating = false; }
  }
  /** Explicit attachment/literal handoff must match its displayed baseline. */
  handoff(before: NoteBody, after: NoteBody): void {
    const current = this.body();
    if (sameBody(current, after)) return;
    if (!sameBody(current, before)) throw new Error("the note changed. review this insertion before applying it.");
    const old = docFromBody(before).firstChild!, next = docFromBody(after).firstChild!;
    const start = old.content.findDiffStart(next.content);
    const edits: BodyEdit[] = [];
    if (start !== null) {
      const end = old.content.findDiffEnd(next.content)!;
      const overlap = Math.max(0, start - Math.min(end.a, end.b));
      const content: InlineNode[] = [];
      next.content.cut(start, end.b + overlap).forEach(node => {
        // justify-type-assertion: canonical body schema and applyBodyEdits validate this inline value.
        content.push(node.toJSON() as InlineNode);
      });
      edits.push({ kind: "replace", from: start, to: end.a + overlap, content });
    }
    if (old.attrs.presentation !== next.attrs.presentation) edits.push({ kind: "presentation", value: next.attrs.presentation });
    this.updating = true;
    try {
      applyBodyEdits(this.baseline, edits);
      Y.applyUpdate(this.document.doc, Y.encodeStateAsUpdate(this.baseline, Y.encodeStateVector(this.document.doc)), this.origin);
    } finally { this.updating = false; }
    this.refresh();
  }
  refresh(): void {
    const view = this.view;
    if (!view || this.updating || view.composing || this.deferred()) return;
    const inline = bodyInline(this.baseline), selection = view.state.selection;
    const relative = (position: number) => Y.createRelativePositionFromTypeIndex(inline, Math.max(0, Math.min(inline.length, position - 1)));
    const anchor = relative(selection.anchor), head = relative(selection.head);
    Y.applyUpdate(this.baseline, Y.encodeStateAsUpdate(this.document.doc, Y.encodeStateVector(this.baseline)));
    const next = docFromBody(this.body());
    const start = view.state.doc.content.findDiffStart(next.content);
    if (start === null) return;
    const end = view.state.doc.content.findDiffEnd(next.content)!;
    const overlap = Math.max(0, start - Math.min(end.a, end.b));
    const transaction = view.state.tr.replaceWith(start, end.a + overlap, next.content.cut(start, end.b + overlap)).setMeta("noteEditSource", "external");
    const a = Y.createAbsolutePositionFromRelativePosition(anchor, this.baseline), b = Y.createAbsolutePositionFromRelativePosition(head, this.baseline);
    if (a && b) transaction.setSelection(TextSelection.create(transaction.doc, a.index + 1, b.index + 1));
    view.dispatch(transaction);
  }
  close(): void { this.document.doc.off("update", this.receive); this.view = null; this.baseline.destroy(); }
}
function inlineContent(fragment: Fragment): Fragment {
  const nodes: import("prosemirror-model").Node[] = [];
  fragment.forEach(node => {
    if (node.isInline) nodes.push(node);
    else if (node.type === noteBodySchema.nodes.body) {
      if (nodes.length) nodes.push(noteBodySchema.nodes.hard_break!.create());
      node.content.forEach(child => nodes.push(child));
    } else throw new TypeError("This operation would discard unsupported content");
  });
  return Fragment.fromArray(nodes);
}
function transactionEdits(transaction: Transaction): BodyEdit[] {
  return transaction.steps.map((step, index) => {
    const json = step.toJSON();
    if (json.stepType === "replace") {
      const content: InlineNode[] = [];
      inlineContent(Slice.fromJSON(noteBodySchema, json.slice).content).forEach(node => {
        // justify-type-assertion: canonical schema and applyBodyEdits validate this inline value.
        content.push(node.toJSON() as InlineNode);
      });
      return { kind: "replace", from: Math.max(0, json.from - 1), to: Math.min(transaction.docs[index]!.firstChild!.content.size, json.to - 1), content };
    }
    if (json.stepType === "addMark" || json.stepType === "removeMark") return { kind: json.stepType === "addMark" ? "add_mark" : "remove_mark", from: json.from - 1, to: json.to - 1, mark: json.mark };
    throw new TypeError(`Unsupported note operation: ${json.stepType}`);
  });
}
