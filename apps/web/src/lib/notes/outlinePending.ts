/** Retained occurrence metadata and literal copy text. Canonical documents own
 * every accepted edit; the runtime owns command order and exact retry bytes.
 * Receipts acknowledge only their admission, never a later placement or body. */
import * as Y from "yjs";
import {readBody} from "@nexus/authored/documents";
import {bodyText, type NoteBody} from "@nexus/authored/body";
import type {LinkState, ResourceProjection} from "@nexus/authored/types";
import type {NoteEdit, FocusSelection} from "./editorTypes";
import type {AdmittedLink, AdmittedStructure, DisplayedWriting, OutlineBookmark, OutlineHistory, OutlineOccurrence, OutlinePlacement} from "./structure";
import {LocalCommitError, type LocalCommit, type WritingDocument} from "./runtime";
import {clipboardPlainText} from "./clipboard";
import {noteBodySchema} from "@nexus/authored/body";

export interface PendingOutlineField {
  row_id: string; parent_id: string | null; parent_ref: string; after_id: string | null; before_id?: string;
  ref: string | null; link: LinkState | null; kind: "body" | "title" | "reference";
  resource?: ResourceProjection | null; body: NoteBody; hidden: boolean; pending: boolean; origin: unknown;
  relocating?: string; previousParent?: string | null; previousLink?: string; settledRevision?: string;
  receiptOwner?: object; revision?: number;
}
interface BoundField {
  document: WritingDocument | null; link: LinkState | Promise<LinkState> | null;
  release(): void; settled: boolean; captureBytes: number;
}
interface InputOwner {
  history: OutlineHistory; notify(): void; capture(): OutlineBookmark | null;
  document(ref: string): WritingDocument | null;
  occurrence(row_id: string): PendingOutlineField | null;
  prepared(row: PendingOutlineField, document: WritingDocument): void;
  publish(documents: readonly WritingDocument[], committed: Promise<LocalCommit>): void;
  confirmed(row: PendingOutlineField, document: WritingDocument): boolean;
  identity(row: PendingOutlineField): void;
}
export class OutlinePendingInput {
  readonly root_id = crypto.randomUUID();
  readonly fields = new Map<string, PendingOutlineField>();
  order: readonly string[] = [];
  private readonly bound = new Map<string, BoundField>();
  private owner: InputOwner | null = null;
  private notify = () => {};
  private inflight = 0;
  private finishing = false;
  error: unknown | null = null;
  connect(owner: InputOwner): () => void {
    if (this.owner?.history !== owner.history)
      for (const [id, field] of this.fields) this.fields.set(id, {...field, origin: owner.history.typingOrigin()});
    this.owner = owner; this.notify = owner.notify; this.resume();
    return () => {if (this.owner === owner) this.owner = null;};
  }
  private current(): InputOwner {if (!this.owner) throw new Error("outline input is not mounted"); return this.owner;}
  risk() {return {changed: [...this.fields.values()].some(field => field.pending), unconfirmed: this.inflight > 0, stopsBrowserWork: false};}
  retainedRefs(): ReadonlySet<string> {return new Set([...this.fields.values()].filter(field => (field.pending || field.relocating) && field.ref !== null).map(field => field.ref!));}
  provisionalCount(): number {return [...this.fields.values()].filter(field => field.pending && field.ref === null).length;}
  encodedBytes(): number {return [...this.bound.values()].reduce((bytes, bound) => bytes + bound.captureBytes, 0);}
  copyText(): string | null {
    const rows = this.order.flatMap(id => {const field = this.fields.get(id); return field?.pending && !field.hidden ? [field] : [];});
    return rows.length ? rows.map(field => clipboardPlainText(noteBodySchema.nodeFromJSON(field.body.body_pm_json).content)).join("\n") : null;
  }
  document(row_id: string): WritingDocument | null {return this.bound.get(row_id)?.document ?? null;}
  freeze(row: PendingOutlineField, document: WritingDocument): void {
    const previous = this.bound.get(row.row_id);
    if (previous && previous.document !== document) throw new Error("an occurrence cannot replace its canonical writing document");
    this.fields.set(row.row_id, {...this.fields.get(row.row_id), ...row, pending: true});
    if (!previous) this.bound.set(row.row_id, {document, link: row.link, release: document.retain(), settled: row.receiptOwner === undefined, captureBytes: 0});
  }
  private row(id: string): PendingOutlineField {
    const field = this.fields.get(id) ?? this.current().occurrence(id);
    if (!field) throw new Error("the outline occurrence is unavailable");
    return field;
  }
  private placement(parent_id: string | null, parent_ref: string, after_id: string | null, before_id?: string): OutlinePlacement {
    const owner = this.current(), parent = parent_id ? this.fields.get(parent_id) : null;
    const ref = parent?.ref ?? parent_ref;
    return {parent_ref: ref, parent: owner.document(ref), after_ref: after_id === null ? null : this.row(after_id).ref,
      before_ref: before_id ? this.row(before_id).ref : null};
  }
  observedLink(row_id: string): LinkState | Promise<LinkState> | null {
    return this.bound.get(row_id)?.link ?? this.fields.get(row_id)?.link ?? null;
  }
  restoreRelationship(row_id: string, link: LinkState | Promise<LinkState>): void {
    const row = this.fields.get(row_id); if (!row) return;
    let bound = this.bound.get(row_id);
    if (!bound) {
      const document = row.ref && row.kind !== "reference" ? this.current().document(row.ref) : null;
      bound = {document, link, release: document?.retain() ?? (() => {}), settled: false, captureBytes: 0};
      this.bound.set(row_id, bound);
    }
    bound.link = link;
    void Promise.resolve(link).then(value => {
      if (this.bound.get(row_id)?.link !== link) return;
      this.bound.get(row_id)!.link = value;
      const field = this.fields.get(row_id);
      if (field) {const current = {...field, link: value}; this.fields.set(row_id, current); this.owner?.identity(current);}
    }).catch(error => {this.error = error; this.notify();});
  }
  private occurrence(id: string): OutlineOccurrence {
    const row = this.row(id), bound = this.bound.get(id), link = bound?.link ?? row.link;
    if (!row.ref || !link) throw new Error("the occurrence has no admitted relationship");
    return {ref: row.ref, parent_ref: row.parent_ref, document: bound?.document ?? this.current().document(row.ref),
      parent: this.current().document(row.parent_ref), link};
  }
  bookmark(row: PendingOutlineField, selection: FocusSelection | null, placed = false, excluded?: string): OutlineBookmark | null {
    if (row.ref === null) return null;
    const siblings = this.order.flatMap(id => {
      const item = this.fields.get(id) ?? this.current().occurrence(id);
      return item && item.parent_id === row.parent_id && item.ref && !item.hidden && item.row_id !== excluded ? [item] : [];
    });
    const index = siblings.findIndex(item => item.row_id === row.row_id);
    const after_id = !placed && index >= 0 ? siblings[index - 1]?.row_id ?? null : row.after_id;
    const before_id = !placed && index >= 0 ? siblings[index + 1]?.row_id ?? null : row.before_id ?? null;
    const link = this.observedLink(row.row_id);
    return {key: row.row_id, ref: row.ref, selection,
      ...(row.parent_id ? {occurrence: {parent_ref: row.parent_ref, parent_id: row.parent_id, link_id: row.link?.link_id ?? null,
        after_id, before_id, ...(link ? {link} : {})}} : {})};
  }
  place(row_id: string, after_id: string | null, before_id: string | null): void {
    const previous = this.order.indexOf(row_id), order = this.order.filter(id => id !== row_id);
    const anchor = before_id ?? after_id;
    if (anchor && !order.includes(anchor)) order.splice(Math.max(0, previous), 0, anchor);
    const before = before_id === null ? -1 : order.indexOf(before_id), after = after_id === null ? -1 : order.indexOf(after_id);
    order.splice(before >= 0 ? before : after >= 0 ? after + 1 : order.length, 0, row_id);
    this.order = order;
  }
  private watch(ids: readonly string[], admission: AdmittedStructure, links: ReadonlyMap<string, AdmittedLink["link"]> = new Map()): void {
    const token = {}, owner = this.current();
    for (const id of ids) {
      const row = this.fields.get(id); if (row) this.fields.set(id, {...row, receiptOwner: token, settledRevision: undefined});
      const bound = this.bound.get(id); if (bound) bound.settled = false;
    }
    for (const [id, link] of links) this.restoreRelationship(id, link);
    this.inflight++; owner.notify();
    void admission.result.catch(error => {this.error = error; this.notify();});
    void admission.committed.then(async receipt => {
      await Promise.all(links.values());
      for (const id of ids) {
        const row = this.fields.get(id);
        if (row?.receiptOwner !== token) continue;
        const bound = this.bound.get(id);
        this.fields.set(id, {...row, settledRevision: receipt.store_revision, pending: bound ? row.pending : false});
        if (bound) bound.settled = true; else this.owner?.identity(this.fields.get(id)!);
      }
    }).catch(error => {this.error = error;}).finally(() => {
      this.inflight--; this.notify(); this.resume();
    });
  }
  edit(row_id: string, edit: NoteEdit): void {
    const row = this.fields.get(row_id), document = this.document(row_id), owner = this.current();
    if (!row?.pending || !document) throw new Error("pending writing has no canonical document");
    this.fields.set(row_id, {...row, body: edit.after, revision: (row.revision ?? 0) + 1});
    owner.history.editor(document, row.origin).record(edit, undefined, this.bookmark(row, edit.selectionAfter) ?? undefined);
    owner.notify(); this.resume();
  }
  create(row: PendingOutlineField): void {
    const owner = this.current();
    const placement = this.placement(row.parent_id, row.parent_ref, row.after_id, row.before_id);
    const admitted = owner.history.create({placement, body: row.body, change: {before: null, after: document => this.bookmark({...row, ref: document.ref}, "end")}});
    const field = {...row, ref: admitted.document.ref, pending: true};
    this.fields.set(row.row_id, field);
    this.bound.set(row.row_id, {document: admitted.document, link: admitted.link, release: admitted.document.retain(), settled: false, captureBytes: 0});
    owner.prepared(field, admitted.document); owner.publish([], admitted.committed);
    this.watch([row.row_id], admitted, new Map([[row.row_id, admitted.link]]));
  }
  split(row_id: string, left: NoteBody, right: NoteBody, from: number, to: number, displayed: DisplayedWriting, placement?: {parent_id: string; parent_ref: string; after_id: string | null}): string {
    const owner = this.current(), row = this.row(row_id), bound = this.bound.get(row_id);
    if (!bound?.document) throw new Error("split requires its displayed canonical identities");
    const successor = crypto.randomUUID(), parent = {...row, ...placement};
    const target: PendingOutlineField = {...parent, row_id: successor, after_id: placement ? placement.after_id : row_id, before_id: undefined,
      ref: null, link: null, resource: null, kind: "body", body: right, hidden: false, pending: true, origin: owner.history.typingOrigin(),
      relocating: undefined, previousParent: undefined, previousLink: undefined, settledRevision: undefined, receiptOwner: undefined};
    const admitted = owner.history.split({source: bound.document, displayed: {body_state: displayed.body_state, from, to},
      placement: this.placement(target.parent_id, target.parent_ref, target.after_id),
      change: {before: this.bookmark(row, {anchor: from + 1, head: to + 1}), after: document => this.bookmark({...target, ref: document.ref}, {anchor: 1, head: 1})}});
    this.fields.set(row_id, {...row, body: left});
    const field = {...target, ref: admitted.document.ref}; this.fields.set(successor, field);
    this.bound.set(successor, {document: admitted.document, link: admitted.link, release: admitted.document.retain(), settled: false, captureBytes: 0});
    const at = this.order.indexOf(row_id); this.order = [...this.order.slice(0, at + 1), successor, ...this.order.slice(at + 1)];
    owner.prepared(field, admitted.document); owner.publish([bound.document], admitted.committed);
    this.watch([row_id, successor], admitted, new Map([[successor, admitted.link]])); return successor;
  }
  join(destination: string, source: string, before: OutlineBookmark | null, displayed: {source: DisplayedWriting; destination: DisplayedWriting}): (document: WritingDocument) => FocusSelection {
    const owner = this.current(), to = this.row(destination), from = this.row(source), a = this.bound.get(destination), b = this.bound.get(source);
    if (!a?.document || !b?.document) throw new Error("join requires both displayed canonical fields");
    const admitted = owner.history.join({source: b.document, destination: a.document, displayed,
      sourceOccurrence: this.bookmark(from, {anchor: 1, head: 1})!, change: {before, after: this.bookmark(to, "end", false, source)}});
    this.fields.set(source, {...from, hidden: true});
    owner.publish([a.document], admitted.committed); this.watch([destination, source], admitted); return admitted.selection;
  }
  unlink(ids: readonly string[]): void {
    const owner = this.current(), rows = ids.map(id => this.row(id));
    const admitted = owner.history.unlinkMany({occurrences: ids.map(id => this.occurrence(id)), change: {before: this.bookmark(rows[0]!, null), after: null, rows: rows.map(row => this.bookmark(row, null)!)}});
    for (const row of rows) this.fields.set(row.row_id, {...row, hidden: true, pending: true});
    owner.publish([], admitted.committed); this.watch(ids, admitted);
  }
  relink(row_id: string, parent_id: string, parent_ref: string, after_id: string | null, selection: FocusSelection | null): void {
    const owner = this.current(), row = this.row(row_id), token = crypto.randomUUID();
    const target = {...row, parent_id, parent_ref, after_id};
    const captured = owner.capture(), resolve = selection !== null && captured?.key === row_id && captured.ref === row.ref ? captured.resolve : undefined;
    const admitted = owner.history.relink({occurrence: this.occurrence(row_id), placement: this.placement(parent_id, parent_ref, after_id),
      change: {before: {...this.bookmark(row, selection)!, resolve}, after: {...this.bookmark(target, selection, true)!, resolve}}});
    this.fields.set(row_id, {...target, before_id: undefined, relocating: token, previousParent: row.relocating ? row.previousParent : row.parent_id,
      previousLink: row.relocating ? row.previousLink : row.link?.link_id, settledRevision: undefined});
    this.place(row_id, after_id, null);
    owner.publish([], admitted.committed); this.watch([row_id], admitted, new Map([[row_id, admitted.link]]));
  }
  move(row_id: string, peer: {row_id: string; link: LinkState | null}, direction: "up" | "down", selection: FocusSelection | null): void {
    const owner = this.current(), row = this.row(row_id), token = crypto.randomUUID();
    const captured = owner.capture(), resolve = selection !== null && captured?.key === row_id && captured.ref === row.ref ? captured.resolve : undefined;
    const placement = this.placement(row.parent_id, row.parent_ref, direction === "down" ? peer.row_id : null, direction === "up" ? peer.row_id : undefined);
    const admitted = owner.history.move({occurrence: this.occurrence(row_id), placement, change: {before: {...this.bookmark(row, selection)!, resolve}, after: {...this.bookmark({...row, after_id: direction === "down" ? peer.row_id : null, before_id: direction === "up" ? peer.row_id : undefined}, selection, true)!, resolve}}});
    this.fields.set(row_id, {...row, after_id: direction === "down" ? peer.row_id : null, before_id: direction === "up" ? peer.row_id : undefined,
      relocating: token, previousParent: row.relocating ? row.previousParent : row.parent_id, previousLink: row.relocating ? row.previousLink : row.link?.link_id, settledRevision: undefined});
    this.place(row_id, direction === "down" ? peer.row_id : null, direction === "up" ? peer.row_id : null);
    owner.publish([], admitted.committed); this.watch([row_id], admitted, new Map([[row_id, admitted.link]]));
  }
  resume(): void {
    if (this.finishing || ![...this.bound].some(([id, bound]) => bound.settled && this.fields.get(id)?.pending)) return;
    this.finishing = true;
    let changed = false;
    void (async () => {
      for (const [id, bound] of this.bound) {
        const row = this.fields.get(id);
        if (!row?.pending || !bound.settled) continue;
        const revision = row.revision, token = row.receiptOwner;
        if (bound.document) {
          const bytes = Y.encodeStateAsUpdate(bound.document.doc).byteLength;
          bound.captureBytes += bytes;
          try {await bound.document.capture().then(() => {});} finally {bound.captureBytes -= bytes;}
        }
        const field = this.fields.get(id);
        if (!field || field.revision !== revision || field.receiptOwner !== token || !bound.settled) continue;
        if (!field.hidden && bound.document && this.owner && !this.owner.confirmed(field, bound.document)) continue;
        const body = bound.document ? field.kind === "title" ? bodyText(bound.document.doc.getText("title").toString()) : readBody(bound.document.doc) : field.body;
        this.fields.set(id, {...field, body, pending: false}); changed = true;
        bound.release(); this.bound.delete(id); this.owner?.identity(this.fields.get(id)!);
      }
    })().catch(error => {this.error = error; changed = true;}).finally(() => {this.finishing = false; if (changed) this.notify();});
  }
  acknowledge(row_id: string, owner: object, revision: string): void {
    const row = this.fields.get(row_id); if (row?.receiptOwner !== owner) return;
    this.fields.set(row_id, {...row, settledRevision: revision});
    const bound = this.bound.get(row_id); if (bound) bound.settled = true;
    else this.fields.set(row_id, {...this.fields.get(row_id)!, pending: false});
    this.resume(); this.notify();
  }
  retry(): void {
    const error = this.error; this.error = null;
    if (error instanceof LocalCommitError) void error.retry().catch(next => {this.error = next; this.notify();});
    this.resume();
  }
}
