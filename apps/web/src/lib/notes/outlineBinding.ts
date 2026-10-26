/** Field-local displayed Yjs baselines share one outline view. View wrappers
 * never enter authored documents. A blank slot binds its real initializer at
 * synchronous admission; a receipt never replaces ahead-of-receipt writing. */
import * as Y from "yjs";
import {TextSelection, type Transaction} from "prosemirror-state";
import type {EditorView} from "prosemirror-view";
import {bodyText, docFromBody, emptyBody, sameBody, type InlineNode, type NoteBody} from "@nexus/authored/body";
import {applyBodyEdits, bodyInline, decodeBytes, encodeBytes, readBody, type BodyEdit} from "@nexus/authored/documents";
import {advanceCoverage, mergeVector} from "@nexus/authored/merge";
import type {Vector} from "@nexus/authored/types";
import type {DisplayedWriting} from "./structure";
import type {EditorBinding} from "./editorBinding";
import type {LocalCommit, WritingDocument} from "./runtime";
import {canonicalBody, fieldAt, fieldById, outlineEditedField, outlineEditorSchema, outlineTransactionSource, plainTitle, routeInlineTransaction, type OutlineField} from "./outlineEditorModel";

export interface OutlineBindingField {
  kind: "body" | "title";
  document: WritingDocument | null;
  origin: unknown;
  body(): NoteBody;
  deferRefresh?(): boolean;
}
interface BoundField {
  row_id: string; captureBytes: number; retiring: boolean;
  field: OutlineBindingField;
  baseline: Y.Doc | null;
  /** A paired capture may still await a dot dominating unseen queued writing. */
  frontier: Promise<Vector>;
  safe: Vector;
  release(): void;
}

/** Vectors cannot represent an unseen earlier write from the same replica.
 * A structural command may cover a newer dot only when its frozen displayed
 * state already includes the canonical state that dot could dominate. False
 * negatives retain the source; they never discard independent writing. */
export function snapshotIncludesDocument(body_state: string, document: Y.Doc): boolean {
  const clone = new Y.Doc();
  try {
    Y.applyUpdate(clone, decodeBytes(body_state));
    const before = Y.encodeStateAsUpdate(clone);
    Y.applyUpdate(clone, Y.encodeStateAsUpdate(document));
    const after = Y.encodeStateAsUpdate(clone);
    return before.length === after.length && before.every((byte, index) => byte === after[index]);
  } finally {clone.destroy();}
}

export class OutlineBinding implements EditorBinding {
  private readonly fields = new Map<string, BoundField>();
  private view: EditorView | null = null;
  private deferred: () => boolean = () => false;
  private updating = false;
  constructor(fields: ReadonlyMap<string, OutlineBindingField>) {this.update(fields);}
  private active(): OutlineField | null {return this.view ? fieldAt(this.view.state.doc, this.view.state.selection.head) : null;}
  private entry(row_id?: string): BoundField | null {return this.fields.get(row_id ?? this.active()?.row_id ?? "") ?? null;}
  get baseline(): Y.Doc | null {return this.entry()?.baseline ?? null;}
  document(row_id?: string): WritingDocument | null {return this.entry(row_id)?.field.document ?? null;}
  bodyState(row_id?: string): string | null {
    const baseline = this.entry(row_id)?.baseline;
    return baseline ? encodeBytes(Y.encodeStateAsUpdate(baseline)) : null;
  }
  /** A synchronous admission supplies the real initializer before another key
   * can depend on it. This changes the binding, never the native editor host. */
  prepare(row_id: string, field: OutlineBindingField): void {
    if (!field.document) throw new Error("prepared writing needs its canonical document");
    const previous = this.fields.get(row_id);
    if (previous?.field.document) {
      if (previous.field.document !== field.document || previous.field.kind !== field.kind) throw new Error("an occurrence cannot replace its canonical document or grammar");
      previous.field = field; previous.retiring = false; return;
    }
    const displayed = this.view && fieldById(this.view.state.doc, row_id);
    const body = field.kind === "body" ? readBody(field.document.doc) : bodyText(field.document.doc.getText("title").toString());
    if (displayed && !sameBody(this.body(row_id), body)) throw new Error("the initializer differs from its admitted field");
    previous?.release(); this.fields.set(row_id, this.bind(row_id, field));
  }
  /** Only a reconciled local semantic command may publish while its native
   * packet is open. The post-command baseline must include every Y dependency. */
  publish(documents: readonly WritingDocument[], committed: Promise<LocalCommit>): void {
    const wanted = new Set(documents);
    for (const entry of this.fields.values()) {
      const document = entry.field.document;
      if (!entry.baseline || !document || !wanted.has(document)) continue;
      Y.applyUpdate(entry.baseline, Y.encodeStateAsUpdate(document.doc));
      entry.frontier = Promise.all([entry.frontier, committed]).then(([covered, receipt]) => {
        const before = receipt.before.resources.find(state => state.ref === document.ref);
        const patch = receipt.change.resources.find(state => state.ref === document.ref);
        return advanceCoverage(covered, before ? {touch: before.touch_vv, removed: before.delete_vv} : null, patch?.touch_vv ?? {});
      });
      void entry.frontier.catch(() => {});
    }
  }
  /** Freeze displayed identities and their proof NOW. Waiting for local writes
   * extends only this occurrence's dots, never a later broad resource frontier.
   * The retained owner detaches this field before submitting continuation. */
  captureDisplayed(row_id: string): DisplayedWriting | null {
    const entry = this.fields.get(row_id), document = entry?.field.document;
    if (!entry?.baseline || !document) return null;
    const encoded = Y.encodeStateAsUpdate(entry.baseline), body_state = encodeBytes(encoded), safe = {...entry.safe};
    entry.captureBytes += encoded.byteLength;
    let observed = entry.frontier.then(candidate => snapshotIncludesDocument(body_state, document.doc) ? mergeVector(safe, candidate) : safe);
    void observed.catch(() => {});
    const release = document.retain();
    const stop = document.onCommitted((receipt, origin) => {
      if (origin !== entry.field.origin) return;
      observed = observed.then(covered => {
        if (!snapshotIncludesDocument(body_state, document.doc)) return covered;
        const prior = receipt.before.resources.find(resource => resource.ref === document.ref);
        for (const patch of receipt.change.resources) if (patch.ref === document.ref)
          covered = advanceCoverage(covered, prior ? {touch: prior.touch_vv, removed: prior.delete_vv} : null, patch.touch_vv);
        return covered;
      });
      void observed.catch(() => {});
    });
    const proof = this.captureDocument(entry).then(() => observed).then(covered => {
      entry.safe = mergeVector(entry.safe, covered); return covered;
    }).finally(() => {stop(); release(); this.releaseCapture(entry, encoded.byteLength);});
    void proof.catch(() => {});
    return {body_state, observed: proof};
  }
  /** Charge each independently owned baseline and unresolved frozen capture.
   * A proposed map estimates new aliases; retained history occurrences keep
   * their old baselines even when their native row is not displayed. A new
   * binding also reserves its initial independently frozen capture. */
  encodedBytes(proposed?: ReadonlyMap<string, number>, retained?: ReadonlySet<string>): number {
    let bytes = 0;
    for (const [id, entry] of this.fields) {
      bytes += entry.captureBytes;
      if (entry.baseline && (!proposed || proposed.has(id) || retained?.has(id) || entry.captureBytes > 0))
        bytes += Y.encodeStateAsUpdate(entry.baseline).byteLength;
    }
    if (proposed) for (const [id, size] of proposed) if (!this.fields.get(id)?.baseline) bytes += 2 * size;
    return bytes;
  }
  private releaseCapture(entry: BoundField, bytes: number): void {
    entry.captureBytes -= bytes;
    if (entry.retiring && entry.captureBytes === 0 && this.fields.get(entry.row_id) === entry) {
      entry.release(); this.fields.delete(entry.row_id);
    }
  }
  private captureDocument(entry: BoundField): Promise<Vector> {
    const document = entry.field.document!;
    const bytes = Y.encodeStateAsUpdate(document.doc).byteLength;
    entry.captureBytes += bytes;
    return document.capture().then(snapshot => snapshot.observed_touch).finally(() => this.releaseCapture(entry, bytes));
  }
  body(row_id?: string): NoteBody {
    const id = row_id ?? this.active()?.row_id, entry = this.entry(id);
    if (!entry) return emptyBody();
    if (entry.baseline) return entry.field.kind === "body" ? readBody(entry.baseline) : bodyText(entry.baseline.getText("title").toString());
    const displayed = id && this.view ? fieldById(this.view.state.doc, id) : null;
    return displayed ? displayed.kind === "body" ? canonicalBody(displayed) : bodyText(plainTitle(displayed)) : entry.field.body();
  }
  update(fields: ReadonlyMap<string, OutlineBindingField>, retained?: ReadonlySet<string>): void {
    for (const [id, entry] of this.fields) if (!fields.has(id) && !retained?.has(id)) {
      if (entry.captureBytes > 0) entry.retiring = true;
      else {entry.release(); this.fields.delete(id);}
    }
    for (const [id, field] of fields) {
      const previous = this.fields.get(id);
      if (previous && previous.field.document === field.document && previous.field.kind === field.kind) {previous.field = field; previous.retiring = false; continue;}
      // Prepared fields bind at synchronous admission. A plain update may only
      // introduce an already ready field or remove a settled occurrence.
      if (previous?.field.document === null && field.document !== null)
        throw new Error("a prepared field must bind at its admission");
      previous?.release();
      this.fields.set(id, this.bind(id, field));
    }
  }
  private bind(row_id: string, field: OutlineBindingField): BoundField {
    const document = field.document;
    if (!document) return {row_id, captureBytes: 0, retiring: false, field, baseline: null, frontier: Promise.resolve({}), safe: {}, release() {}};
    const baseline = new Y.Doc();
    // capture() freezes its state/frontier synchronously, then waits for writes
    // already admitted. No event can intervene between this clone and capture.
    Y.applyUpdate(baseline, Y.encodeStateAsUpdate(document.doc));
    const frontier = Promise.resolve({});
    // The runtime owns write failures. Preserve rejection for a later structural
    // capture without an unobserved admission/refresh promise rejection.
    void frontier.catch(() => {});
    const unpin = document.retain();
    const receive = () => this.refresh();
    document.doc.on("update", receive);
    const entry: BoundField = {row_id, captureBytes: 0, retiring: false, field, baseline, frontier, safe: {}, release: () => {document.doc.off("update", receive); stop(); baseline.destroy(); unpin();}};
    entry.frontier = this.captureDocument(entry);
    void entry.frontier.catch(() => {});
    const stop = document.onCommitted((receipt, origin) => {
      if (origin !== entry.field.origin) return;
      entry.frontier = entry.frontier.then(covered => {
        const prior = receipt.before.resources.find(resource => resource.ref === document.ref);
        for (const patch of receipt.change.resources) if (patch.ref === document.ref)
          covered = advanceCoverage(covered, prior ? {touch: prior.touch_vv, removed: prior.delete_vv} : null, patch.touch_vv);
        return covered;
      });
      void entry.frontier.catch(() => {});
    });
    return entry;
  }
  attach(view: EditorView, deferred: () => boolean): void {this.view = view; this.deferred = deferred;}
  apply(transaction: Transaction): void {
    const route = routeInlineTransaction(transaction);
    if (route.kind === "refused") throw new Error(route.reason);
    if (route.kind !== "edit" || !route.edits.length) return;
    const row_id = route.edits[0]!.field.row_id;
    transaction.setMeta(outlineEditedField, row_id);
    const entry = this.fields.get(row_id);
    if (!entry) throw new Error("outline field has no writing owner");
    if (!entry.baseline || !entry.field.document) return;
    this.updating = true;
    try {
      if (entry.field.kind === "body") {
        const edits: BodyEdit[] = [];
        for (const edit of route.edits) {if (edit.kind !== "body") throw new Error("a body cannot receive title edits"); edits.push(edit.edit);}
        applyBodyEdits(entry.baseline, edits);
      } else {
        const title = entry.baseline.getText("title");
        entry.baseline.transact(() => {
          for (const edit of route.edits) {
            if (edit.kind !== "title") throw new Error("a title cannot receive body edits");
            title.delete(edit.from, edit.to - edit.from);
            if (edit.text) title.insert(edit.from, edit.text);
          }
        });
      }
      Y.applyUpdate(entry.field.document.doc, Y.encodeStateAsUpdate(entry.baseline, Y.encodeStateVector(entry.field.document.doc)), entry.field.origin);
    } finally {this.updating = false;}
  }
  /** Ordinary input already applied through apply(); explicit attachment/link
   * insertion uses the same observed baseline, while raw input stays retained. */
  handoff(before: NoteBody, after: NoteBody, row_id?: string): void {
    const id = row_id ?? this.active()?.row_id;
    const entry = id ? this.fields.get(id) : null;
    if (!entry) throw new Error("there is no selected outline field");
    const current = this.body(id);
    if (sameBody(current, after)) return;
    if (!sameBody(current, before)) throw new Error("the field changed. review this insertion before applying it.");
    if (!entry.baseline || !entry.field.document) return;
    const old = docFromBody(before).firstChild!, next = docFromBody(after).firstChild!;
    const start = old.content.findDiffStart(next.content);
    this.updating = true;
    try {
      if (entry.field.kind === "title") {
        let plain = next.attrs.presentation === "prose";
        next.forEach(node => {if (!node.isText || node.marks.length) plain = false;});
        if (!plain) throw new Error("page titles accept plain text only");
        if (start !== null) {
          const end = old.content.findDiffEnd(next.content)!, overlap = Math.max(0, start - Math.min(end.a, end.b));
          const title = entry.baseline.getText("title");
          entry.baseline.transact(() => {title.delete(start, end.a + overlap - start); title.insert(start, next.textContent.slice(start, end.b + overlap));});
        }
      } else {
        const edits: BodyEdit[] = [];
        if (start !== null) {
          const end = old.content.findDiffEnd(next.content)!, overlap = Math.max(0, start - Math.min(end.a, end.b));
          const content: InlineNode[] = [];
          next.content.cut(start, end.b + overlap).forEach(node => {
            // justify-type-assertion: both nodes came from the canonical body grammar.
            content.push(node.toJSON() as InlineNode);
          });
          edits.push({kind: "replace", from: start, to: end.a + overlap, content});
        }
        if (old.attrs.presentation !== next.attrs.presentation) edits.push({kind: "presentation", value: next.attrs.presentation});
        applyBodyEdits(entry.baseline, edits);
      }
      Y.applyUpdate(entry.field.document.doc, Y.encodeStateAsUpdate(entry.baseline, Y.encodeStateVector(entry.field.document.doc)), entry.field.origin);
    } finally {this.updating = false;}
    this.refresh();
  }
  refresh(): void {
    const view = this.view;
    if (!view || view.isDestroyed || this.updating || view.composing || this.deferred()) return;
    const selected = this.active(), active = selected && this.fields.get(selected.row_id);
    const selection = view.state.selection;
    const textSelection = selection instanceof TextSelection && selected && selection.from >= selected.from && selection.to <= selected.to;
    const inline = textSelection && active?.baseline ? active.field.kind === "body" ? bodyInline(active.baseline) : active.baseline.getText("title") : null;
    const relative = (position: number) => inline && selected ? Y.createRelativePositionFromTypeIndex(inline, Math.max(0, Math.min(inline.length, position - selected.from))) : null;
    const anchor = relative(view.state.selection.anchor), head = relative(view.state.selection.head);
    const transaction = view.state.tr.setMeta(outlineTransactionSource, "projection").setMeta("noteEditSource", "external");
    const ordered = [...this.fields].map(([id, entry]) => ({entry, field: fieldById(view.state.doc, id)})).filter(item => item.field !== null).sort((a, b) => b.field!.from - a.field!.from);
    for (const {entry, field} of ordered) {
      if (!entry.baseline || !entry.field.document || !field) continue;
      if (entry.field.deferRefresh?.()) continue;
      const captured = this.captureDocument(entry);
      Y.applyUpdate(entry.baseline, Y.encodeStateAsUpdate(entry.field.document.doc, Y.encodeStateVector(entry.baseline)));
      entry.frontier = captured;
      void entry.frontier.catch(() => {});
      const text = entry.field.kind === "title" ? entry.baseline.getText("title").toString() : "";
      const next = entry.field.kind === "body" ? outlineEditorSchema.nodeFromJSON(readBody(entry.baseline).body_pm_json)
        : outlineEditorSchema.nodes.title_row!.create(field.node.attrs, text ? outlineEditorSchema.text(text) : null);
      const start = field.node.content.findDiffStart(next.content);
      if (start !== null) {
        const end = field.node.content.findDiffEnd(next.content)!, overlap = Math.max(0, start - Math.min(end.a, end.b));
        transaction.replaceWith(field.from + start, field.from + end.a + overlap, next.content.cut(start, end.b + overlap));
      }
      if (entry.field.kind === "body" && field.node.attrs.presentation !== next.attrs.presentation)
        transaction.setNodeMarkup(field.from - 1, undefined, next.attrs);
    }
    if (!transaction.docChanged) return;
    const nextField = selected && fieldById(transaction.doc, selected.row_id);
    if (nextField && active?.baseline && anchor && head) {
      const a = Y.createAbsolutePositionFromRelativePosition(anchor, active.baseline), b = Y.createAbsolutePositionFromRelativePosition(head, active.baseline);
      if (a && b) transaction.setSelection(TextSelection.create(transaction.doc, nextField.from + a.index, nextField.from + b.index));
    }
    view.dispatch(transaction);
  }
  close(): void {for (const entry of this.fields.values()) entry.release(); this.fields.clear(); this.view = null;}
}
