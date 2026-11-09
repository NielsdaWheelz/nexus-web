/** Retained occurrence metadata and literal copy text. Canonical documents own
 * every accepted edit; the runtime owns command order and exact retry bytes.
 * Receipts acknowledge only their admission, never a later placement or body. */
import * as Y from "yjs";
import {readBody} from "@nexus/authored/documents";
import {bodyText, emptyBody, type NoteBody} from "@nexus/authored/body";
import {isVisible} from "@nexus/authored/merge";
import type {LinkState, ResourceProjection} from "@nexus/authored/types";
import type {DisplayedSplit, NoteEdit, FocusSelection} from "./editorTypes";
import type {AdmittedLink, AdmittedStructure, DisplayedWriting, OccurrenceBookmark, OutlineBirthChange, OutlineHistory, OutlinePlacement, RangePublication} from "./structure";
import {advanceRelationship} from "./structure";
import type {LocalCommit, WritingDocument} from "./runtime";
import {clipboardPlainText} from "./clipboard";
import {noteBodySchema} from "@nexus/authored/body";
import {planRange, type InputBookmark, type Placement, type RangePlan, type RangeReason, type RangeSnapshot} from "./outlineSelection";

export interface PendingOutlineField {
  row_id: string; parent_id: string | null; parent_ref: string; after_id: string | null; before_id?: string;
  ref: string | null; link: LinkState | null; kind: "body" | "title" | "reference";
  resource?: ResourceProjection | null; body: NoteBody; hidden: boolean; pending: boolean; origin: unknown;
  relocating?: string; previousParent?: string | null; previousParentRef?: string; settledRevision?: string;
  receiptOwner?: object; revision?: number;
}
interface RangeState {placement: Placement | null; link: LinkState | null}
interface BirthLocation {placement: Omit<Placement, "row_id" | "ref">; source: RangeState}
interface BoundField {
  document: WritingDocument | null; link: LinkState | Promise<LinkState> | null;
  release(): void; settled: boolean; captureBytes: number; reservations?: number; next?: {state: Promise<RangeState>; link: Promise<LinkState>};
}
interface InputOwner {
  history: OutlineHistory; notify(): void; capture(): InputBookmark;
  rangeSnapshot(): RangeSnapshot;
  canRetain(): boolean;
  installRange(plan: RangePlan, mayFocus: () => boolean, action: "undo" | "redo" | null): void;
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
  private finishing: Promise<void> | null = null;
  private resumeAgain = false;
  /** The latest failure. It stands through a retry, which clears it only if nothing fails meanwhile. */
  error: unknown | null = null;
  /** Failures so far; each is an onset its owner speaks. */
  failures = 0;
  /** From a retry's press until the resume it started settles. */
  retrying = false;
  connect(owner: InputOwner): () => void {
    if (this.owner?.history !== owner.history)
      for (const [id, field] of this.fields) this.fields.set(id, {...field, origin: owner.history.typingOrigin()});
    this.owner = owner; this.notify = owner.notify; this.resume();
    return () => {if (this.owner === owner) this.owner = null;};
  }
  private fail(error: unknown): void {this.error = error; this.failures++; this.notify();}
  private current(): InputOwner {if (!this.owner) throw new Error("outline input is not mounted"); return this.owner;}
  risk() {return {changed: [...this.fields.values()].some(field => field.pending), unconfirmed: this.inflight > 0, stopsBrowserWork: false};}
  retainedRefs(): ReadonlySet<string> {return new Set([...this.fields.values()].filter(field => (field.pending || field.relocating || this.rangeHeld(field.row_id)) && field.ref !== null).map(field => field.ref!));}
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
    const bound = this.bound.get(row_id);
    return bound?.next?.link ?? bound?.link ?? this.fields.get(row_id)?.link ?? null;
  }
  restoreRelationship(row_id: string, link: LinkState | Promise<LinkState>): void {
    const row = this.fields.get(row_id); if (!row) return;
    let bound = this.bound.get(row_id);
    if (!bound) {
      const document = row.ref && row.kind !== "reference" ? this.current().document(row.ref) : null;
      bound = {document, link, release: document?.retain() ?? (() => {}), settled: false, captureBytes: 0};
      this.bound.set(row_id, bound);
    }
    const retained = bound;
    bound.link = link;
    void Promise.resolve(link).then(value => {
      const field = this.fields.get(row_id);
      if (this.bound.get(row_id) !== retained || retained.link !== link || !field ||
        field.ref !== row.ref || !(value.endpoint_a === field.ref && value.endpoint_b === field.parent_ref ||
          value.endpoint_b === field.ref && value.endpoint_a === field.parent_ref)) return;
      retained.link = value;
      const current = {...field, link: value}; this.fields.set(row_id, current); this.owner?.identity(current);
    }).catch(error => this.fail(error));
  }
  bookmark(row: PendingOutlineField, selection: FocusSelection | null): InputBookmark {
    if (row.ref === null) return null;
    if (selection === null) return {kind: "blocks", anchor_id: row.row_id, head_id: row.row_id, row_ids: [row.row_id]};
    return {kind: "text", row_id: row.row_id, ref: row.ref, range: selection, resolve: null};
  }
  placementBookmark(row: PendingOutlineField, placed = false, excluded?: string): OccurrenceBookmark | null {
    if (row.ref === null) return null;
    const siblings = this.order.flatMap(id => {
      const item = this.fields.get(id) ?? this.current().occurrence(id);
      return item && item.parent_id === row.parent_id && item.ref && !item.hidden && item.row_id !== excluded ? [item] : [];
    });
    const index = siblings.findIndex(item => item.row_id === row.row_id);
    const after_id = !placed && index >= 0 ? siblings[index - 1]?.row_id ?? null : row.after_id;
    const before_id = !placed && index >= 0 ? siblings[index + 1]?.row_id ?? null : row.before_id ?? null;
    return {row_id: row.row_id, ref: row.ref, link: this.observedLink(row.row_id) ?? row.link,
      placement: row.parent_id ? {row_id: row.row_id, ref: row.ref, parent_id: row.parent_id, parent_ref: row.parent_ref, after_id, before_id} : null};
  }
  place(row_id: string, after_id: string | null, before_id: string | null): void {
    const previous = this.order.indexOf(row_id), order = this.order.filter(id => id !== row_id);
    const anchor = before_id ?? after_id;
    if (anchor && !order.includes(anchor)) order.splice(Math.max(0, previous), 0, anchor);
    const before = before_id === null ? -1 : order.indexOf(before_id), after = after_id === null ? -1 : order.indexOf(after_id);
    order.splice(before >= 0 ? before : after >= 0 ? after + 1 : order.length, 0, row_id);
    this.order = order;
  }
  private watch(ids: readonly string[], admission: AdmittedStructure, links: ReadonlyMap<string, AdmittedLink["link"]> = new Map(), graph_revisions: ReadonlyMap<string, number | undefined> | null = null): object {
    const token = {};
    for (const id of ids) {
      const row = this.fields.get(id); if (row) this.fields.set(id, {...row, pending: true, receiptOwner: token, settledRevision: undefined});
      const bound = this.bound.get(id); if (bound) bound.settled = false;
    }
    for (const [id, link] of links) this.restoreRelationship(id, link);
    this.inflight++; this.notify();
    void admission.result.catch(error => this.fail(error));
    void admission.committed.then(async receipt => {
      await Promise.all(links.values());
      for (const id of ids) {
        const row = this.fields.get(id);
        if (row?.receiptOwner !== token) continue;
        const bound = this.bound.get(id);
        const graphOnly = graph_revisions !== null && graph_revisions.get(id) === row.revision;
        this.fields.set(id, {...row, settledRevision: receipt.store_revision, pending: !graphOnly && bound ? row.pending : false});
        if (bound) {
          bound.settled = true;
          if (graphOnly && !bound.captureBytes && !bound.reservations && !bound.next) {bound.release(); this.bound.delete(id);}
        } else this.owner?.identity(this.fields.get(id)!);
      }
    }).catch(error => this.fail(error)).finally(() => {
      this.inflight--; this.notify(); this.resume();
    });
    return token;
  }
  edit(row_id: string, edit: NoteEdit): void {
    const row = this.fields.get(row_id), document = this.document(row_id), owner = this.current();
    if (!row?.pending || !document) throw new Error("pending writing has no canonical document");
    this.fields.set(row_id, {...row, body: edit.after, revision: (row.revision ?? 0) + 1});
    owner.history.editor(document, row.origin).record(edit, undefined, this.bookmark(row, edit.selectionAfter) ?? undefined);
    owner.notify(); this.resume();
  }
  /** Pin the neighbour's preceding gesture now, never a later command on that occurrence. */
  private birthLocation(row: PendingOutlineField, beside?: string): Promise<BirthLocation> | null {
    const predecessor = beside ? this.bound.get(beside)?.next?.state : null;
    if (!predecessor) return null;
    return predecessor.then(source => {
      if (!source.placement) throw new Error("the new item's neighbour was removed");
      return {source, placement: {parent_id: source.placement.parent_id, parent_ref: source.placement.parent_ref,
        after_id: row.after_id, before_id: row.before_id ?? null}};
    });
  }
  private resolveBirth(row: PendingOutlineField, beside: PendingOutlineField, location: Promise<BirthLocation>, split: boolean): NonNullable<OutlineBirthChange["resolvePlacement"]> {
    return async document => {
      const {placement, source} = await location;
      const after: OccurrenceBookmark = {row_id: row.row_id, ref: document.ref, placement: {...placement, row_id: row.row_id, ref: document.ref}, link: null};
      const before: OccurrenceBookmark = {row_id: beside.row_id, ref: beside.ref!, placement: source.placement, link: source.link};
      // Early undo may already have hidden the newborn or restored source text. Only its location follows the preceding gesture.
      for (const target of split ? [before, after] : [after]) {
        const current = this.fields.get(target.row_id), at = target.placement;
        if (current && at) this.fields.set(target.row_id, {...current, parent_id: at.parent_id, parent_ref: at.parent_ref,
          after_id: at.after_id, before_id: at.before_id ?? undefined});
      }
      this.owner?.notify();
      return {placement: {parent_ref: placement.parent_ref, parent: null,
        after_ref: row.after_id === beside.row_id ? beside.ref : null,
        before_ref: row.before_id === beside.row_id ? beside.ref : null},
        placements_before: split ? [before] : [], placements_after: [after]};
    };
  }
  private followBirth(row: PendingOutlineField, admitted: AdmittedLink, location: Promise<BirthLocation> | null): void {
    if (!location) return;
    const bound = this.bound.get(row.row_id)!;
    const state = Promise.all([location, admitted.link]).then(([settled, link]) => ({placement: {...settled.placement, row_id: row.row_id, ref: row.ref!}, link}));
    const next = {state, link: admitted.link}; bound.next = next;
    void state.then(() => {
      if (bound.next === next) bound.next = undefined;
      this.resume(); this.notify();
    }).catch(error => this.fail(error));
  }
  /** A birth binds its canonical document immediately; only the graph placement may await a preceding arrangement. */
  create(row: PendingOutlineField, options: {before?: InputBookmark; stays?: boolean; beside?: string} = {}): void {
    const owner = this.current();
    const before = options.before ?? null, location = this.birthLocation(row, options.beside);
    const placement = this.placement(row.parent_id, row.parent_ref, row.after_id, row.before_id);
    const admitted = owner.history.create({placement, body: row.body, change: {before, after: document => options.stays ? before : this.bookmark({...row, ref: document.ref}, "end"),
      placements_after: document => [this.placementBookmark({...row, ref: document.ref})!],
      resolvePlacement: location ? this.resolveBirth(row, {...this.row(options.beside!)}, location, false) : undefined}});
    const field = {...row, ref: admitted.document.ref, pending: true};
    this.fields.set(row.row_id, field);
    this.place(row.row_id, row.after_id, row.before_id ?? null);
    this.bound.set(row.row_id, {document: admitted.document, link: admitted.link, release: admitted.document.retain(), settled: false, captureBytes: 0});
    this.followBirth(field, admitted, location);
    owner.prepared(field, admitted.document); owner.publish([], admitted.committed);
    this.watch([row.row_id], admitted, new Map([[row.row_id, admitted.link]]));
  }
  split(row_id: string, left: NoteBody, right: NoteBody, from: number, to: number, displayed: DisplayedWriting): string {
    const owner = this.current(), row = this.row(row_id), bound = this.bound.get(row_id);
    if (!bound?.document) throw new Error("split requires its displayed canonical identities");
    const successor = crypto.randomUUID();
    const target: PendingOutlineField = {...row, row_id: successor, after_id: row_id, before_id: undefined,
      ref: null, link: null, resource: null, kind: "body", body: right, hidden: false, pending: true, origin: owner.history.typingOrigin(),
      relocating: undefined, previousParent: undefined, previousParentRef: undefined, settledRevision: undefined, receiptOwner: undefined};
    const location = this.birthLocation(target, row_id);
    const admitted = owner.history.split({source: bound.document, displayed: {body_state: displayed.body_state, from, to},
      placement: this.placement(target.parent_id, target.parent_ref, target.after_id),
      change: {before: this.bookmark(row, {anchor: from + 1, head: to + 1}), placements_before: [this.placementBookmark(row)!], after: document => this.bookmark({...target, ref: document.ref}, {anchor: 1, head: 1}),
        placements_after: document => [this.placementBookmark({...target, ref: document.ref}, true)!], resolvePlacement: location ? this.resolveBirth(target, {...row}, location, true) : undefined}});
    this.fields.set(row_id, {...row, body: left});
    const field = {...target, ref: admitted.document.ref}; this.fields.set(successor, field);
    this.bound.set(successor, {document: admitted.document, link: admitted.link, release: admitted.document.retain(), settled: false, captureBytes: 0});
    this.followBirth(field, admitted, location);
    const at = this.order.indexOf(row_id); this.order = [...this.order.slice(0, at + 1), successor, ...this.order.slice(at + 1)];
    owner.prepared(field, admitted.document); owner.publish([bound.document], admitted.committed);
    this.watch([row_id, successor], admitted, new Map([[successor, admitted.link]])); return successor;
  }
  splitChild(args: {source: WritingDocument; displayed: DisplayedSplit; row: PendingOutlineField; placement: OutlinePlacement; before: InputBookmark}): {row_id: string; committed: Promise<LocalCommit>} {
    const owner = this.current(), row = args.row;
    const original = args.before?.kind === "text" ? owner.occurrence(args.before.row_id) : null;
    const placement = original ? this.placementBookmark(original) : null;
    const admitted = owner.history.split({source: args.source, displayed: args.displayed, placement: args.placement,
      change: {before: args.before, after: document => this.bookmark({...row, ref: document.ref}, {anchor: 1, head: 1}),
        placements_before: placement ? [placement] : [],
        placements_after: document => [this.placementBookmark({...row, ref: document.ref}, true)!]}});
    this.installNewborn(row, admitted, [args.source]);
    return {row_id: row.row_id, committed: admitted.committed};
  }
  replaceWithNote(row_id: string, before: InputBookmark): {row_id: string; committed: Promise<LocalCommit>} {
    const owner = this.current(), original = this.row(row_id);
    if (!original.link || !original.ref) throw new Error("reference conversion needs its frozen relationship");
    const row: PendingOutlineField = {...original, row_id: crypto.randomUUID(), after_id: null, before_id: row_id, ref: null, link: null, kind: "body", resource: null,
      body: emptyBody(), hidden: false, pending: true, origin: owner.history.typingOrigin(), receiptOwner: undefined, settledRevision: undefined};
    const retiring = {...this.placementBookmark(original)!, link: original.link};
    const admitted = owner.history.replaceWithNote({placement: this.placement(row.parent_id, row.parent_ref, null, row_id), retiring,
      change: {before, placements_before: [retiring], after: document => this.bookmark({...row, ref: document.ref}, {anchor: 1, head: 1}),
        placements_after: document => [this.placementBookmark({...row, ref: document.ref}, true)!]}});
    this.fields.set(row_id, {...original, hidden: true});
    this.installNewborn(row, admitted, [], [row_id]);
    return {row_id: row.row_id, committed: admitted.committed};
  }
  private installNewborn(row: PendingOutlineField, admitted: import("./structure").AdmittedNote, sources: readonly WritingDocument[], retired: readonly string[] = []): void {
    const owner = this.current(), field = {...row, ref: admitted.document.ref, body: readBody(admitted.document.doc)};
    this.fields.set(row.row_id, field); this.place(row.row_id, row.after_id, row.before_id ?? null);
    this.bound.set(row.row_id, {document: admitted.document, link: admitted.link, release: admitted.document.retain(), settled: false, captureBytes: 0});
    owner.prepared(field, admitted.document); owner.publish(sources, admitted.committed);
    this.watch([...retired, row.row_id], admitted, new Map([[row.row_id, admitted.link]]));
  }
  replaceReference(args: {original: PendingOutlineField; replacement: PendingOutlineField; admission: AdmittedStructure; link: Promise<LinkState>; document: WritingDocument | null}): void {
    const {original, replacement, admission, link, document} = args;
    this.fields.set(original.row_id, {...original, hidden: true});
    this.fields.set(replacement.row_id, replacement); this.place(replacement.row_id, null, original.row_id);
    if (document) {
      this.bound.set(replacement.row_id, {document, link, release: document.retain(), settled: false, captureBytes: 0});
      this.current().prepared(replacement, document);
    }
    this.watch([original.row_id, replacement.row_id], admission, new Map([[replacement.row_id, link]]));
  }
  join(destination: string, source: string, before: InputBookmark, displayed: {source: DisplayedWriting; destination: DisplayedWriting}): (document: WritingDocument) => FocusSelection {
    const owner = this.current(), to = this.row(destination), from = this.row(source), a = this.bound.get(destination), b = this.bound.get(source);
    if (!a?.document || !b?.document) throw new Error("join requires both displayed canonical fields");
    const admitted = owner.history.join({source: b.document, destination: a.document, displayed,
      sourceOccurrence: this.placementBookmark(from)!, change: {before, after: this.bookmark(to, "end"), placements_before: [this.placementBookmark(to)!], placements_after: [this.placementBookmark(to, false, source)!]}});
    this.fields.set(source, {...from, hidden: true});
    owner.publish([a.document], admitted.committed); this.watch([destination, source], admitted); return admitted.selection;
  }
  unlink(row_id: string, refused: (reason: RangeReason) => void): void {
    const selection: InputBookmark = {kind: "blocks", anchor_id: row_id, head_id: row_id, row_ids: [row_id]};
    const result = planRange("remove", this.current().rangeSnapshot(), selection);
    if (result.kind === "refusal") refused(result.reason); else this.range(result.plan, {refused});
  }
  rangeHeld(row_id: string): boolean {return (this.bound.get(row_id)?.reservations ?? 0) > 0;}
  /** A range gesture is still held or unsettled: the shown order may trail it. */
  busy(): boolean {return [...this.bound.values()].some(bound => (bound.reservations ?? 0) > 0 || bound.next !== undefined);}
  range(plan: RangePlan, callbacks: {refused(reason: RangeReason): void}): void {
    const owner = this.current(), snapshot = owner.rangeSnapshot();
    // The selection charges the gesture; every row the plan changes (an adopted sibling too) is captured and bound.
    const selected = [...new Set([...(plan.selection_before?.kind === "blocks" ? plan.selection_before.row_ids : plan.selection_before ? [plan.selection_before.row_id] : []),
      ...plan.changes.map(change => change.before.row_id)])];
    const selectedIds = new Set(selected), captured = new Map<string, PendingOutlineField>();
    for (const id of selected) {
      const row = this.fields.get(id) ?? owner.occurrence(id);
      if (row) captured.set(id, {...row, body: emptyBody()});
    }
    const originalPlacement = (id: string): Placement | null => {
      const row = snapshot.rows.find(row => row.row_id === id);
      if (!row?.ref || !row.parent_id) return null;
      const siblings = snapshot.rows.filter(peer => peer.parent_id === row.parent_id && peer.selectable), at = siblings.indexOf(row);
      return {row_id: id, ref: row.ref, parent_id: row.parent_id, parent_ref: row.parent_ref,
        after_id: siblings[at - 1]?.row_id ?? null, before_id: siblings[at + 1]?.row_id ?? null};
    };
    const pin = (all: boolean): {states: Map<string, Promise<RangeState>>; bytes: number} => {
      let bytes = 0;
      const pinned = new Map<string, Promise<RangeState>>(), displayed = this.owner?.rangeSnapshot() ?? snapshot;
      for (const item of snapshot.rows) {
        const id = item.row_id;
        if (item.ref === null || item.parent_id === null || !all && !selectedIds.has(id)) continue;
        const row = this.fields.get(id) ?? this.owner?.occurrence(id) ?? captured.get(id);
        if (!row) continue;
        let bound = this.bound.get(id);
        if (!bound && selectedIds.has(id)) {
          const document = row.kind === "reference" ? null : this.owner?.document(row.ref!) ?? owner.document(row.ref!);
          bound = {document, link: row.link, release: document?.retain() ?? (() => {}), settled: true, captureBytes: 0};
          this.bound.set(id, bound);
        }
        const visible = displayed.rows.find(item => item.row_id === id);
        const siblings = visible ? displayed.rows.filter(peer => peer.parent_id === visible.parent_id && peer.selectable) : [];
        const at = visible ? siblings.indexOf(visible) : -1;
        const placement = row.hidden ? null : visible?.ref && visible.parent_id ? {row_id: id, ref: visible.ref, parent_id: visible.parent_id, parent_ref: visible.parent_ref,
          after_id: siblings[at - 1]?.row_id ?? null, before_id: siblings[at + 1]?.row_id ?? null} : originalPlacement(id);
        if (!bound?.next) bytes += new TextEncoder().encode(JSON.stringify(placement)).byteLength;
        const predecessor = bound?.next?.state ?? Promise.resolve(bound?.link ?? row.link).then(link => ({placement, link}));
        pinned.set(id, predecessor);
        if (bound && selectedIds.has(id)) bound.reservations = (bound.reservations ?? 0) + 1;
      }
      return {states: pinned, bytes};
    };
    const initial = pin(true);
    // A plan's null anchors mean last among the siblings it saw; rows born beside them since stay after, so the last
    // sibling the gesture's snapshot knew (else the parent) anchors the row in the displayed order.
    const anchor = (row_id: string, after: Placement): string | null => after.after_id ?? (after.before_id !== null ? null
      : snapshot.rows.filter(peer => peer.parent_id === after.parent_id && peer.selectable && peer.row_id !== row_id).at(-1)?.row_id ?? (after.parent_id === this.root_id ? null : after.parent_id));
    const reserve = (pinned: {states: ReadonlyMap<string, Promise<RangeState>>; bytes: number}, displayed: RangeSnapshot, action: "undo" | "redo" | null): RangePublication => {
      const charged = this.bound.get(selected[0]!);
      const bytes = pinned.bytes + (displayed === snapshot ? 0 : new TextEncoder().encode(JSON.stringify(displayed)).byteLength);
      if (charged) charged.captureBytes += bytes;
      let finished = false;
      const finish = () => {
        if (finished) return; finished = true;
        if (charged) {
          charged.captureBytes -= bytes;
          if (this.bound.get(selected[0]!) === charged && !charged.captureBytes && !charged.reservations && !charged.next && !this.fields.get(selected[0]!)?.pending) {charged.release(); this.bound.delete(selected[0]!);}
        }
      };
      const successors = new Map<string, {resolve(state: RangeState): void; previous: Promise<RangeState>; next: NonNullable<BoundField["next"]>}>();
      for (const id of selected) {
        const previous = pinned.states.get(id), bound = this.bound.get(id); if (!previous || !bound) continue;
        let resolve: (state: RangeState) => void = () => {};
        const state = new Promise<RangeState>(done => {resolve = done;});
        const link = state.then(async current => {const value = current.link ?? (await previous).link; if (!value) throw new Error("range occurrence has no relationship"); return value;});
        void link.catch(() => {});
        const next = {state, link}; bound.next = next; successors.set(id, {resolve, previous, next});
      }
      let released = false;
      const release = () => {
        if (released) return; released = true;
        for (const id of selected) {
          const bound = this.bound.get(id); if (!bound) continue;
          bound.reservations = (bound.reservations ?? 0) - 1;
          if (!bound.captureBytes && !bound.reservations && !bound.next && !this.fields.get(id)?.pending) {bound.release(); this.bound.delete(id);}
        }
        this.resume(); this.notify();
      };
      const settle = (id: string, state: Promise<RangeState>) => {
        const successor = successors.get(id); if (!successor) return;
        void state.then(value => {
          successor.resolve(value);
          const bound = this.bound.get(id);
          if (bound?.next === successor.next) {
            bound.next = undefined; bound.link = value.link;
            if (!bound.captureBytes && !bound.reservations && !this.fields.get(id)?.pending) {bound.release(); this.bound.delete(id);}
          }
        }).catch(error => this.fail(error));
      };
      return {
        snapshot: displayed,
        refused: () => {for (const [id, successor] of successors) settle(id, successor.previous); release(); finish();},
        accepted: (accepted, links, committed, mayFocus, members, confirmed) => {
          const changed = new Set(accepted.changes.map(change => change.before.row_id));
          const presentation = [...accepted.changes, ...selected.filter(id => !changed.has(id)).flatMap(id => {
            const before = originalPlacement(id); return before ? [{before, after: members.find(member => member.row_id === id) ?? null}] : [];
          })];
          for (const change of presentation) {
            const row = this.fields.get(change.before.row_id) ?? captured.get(change.before.row_id);
            if (!row) continue;
            const after = change.after;
            // A reparented row's relationship is unknown until the receipt; a stale link would seed its branch request with the wrong edge.
            const field: PendingOutlineField = after ? {...row, parent_id: after.parent_id, parent_ref: after.parent_ref, after_id: after.after_id,
              link: after.parent_id === row.parent_id && after.parent_ref === row.parent_ref ? row.link : null,
              before_id: after.before_id ?? undefined, hidden: false, pending: changed.has(row.row_id) || row.pending, relocating: crypto.randomUUID(),
              previousParent: row.relocating ? row.previousParent : row.parent_id, previousParentRef: row.relocating ? row.previousParentRef : row.parent_ref, settledRevision: undefined}
              : {...row, hidden: true, pending: changed.has(row.row_id) || row.pending, settledRevision: undefined};
            this.fields.set(row.row_id, field);
            const document = this.bound.get(row.row_id)?.document ?? (row.ref ? this.owner?.document(row.ref) : null);
            if (document) {
              const prepared = {...field, body: field.kind === "title" ? bodyText(document.doc.getText("title").toString()) : readBody(document.doc)};
              if (changed.has(row.row_id)) this.freeze(prepared, document); else this.fields.set(row.row_id, prepared);
            }
            if (after) this.place(row.row_id, anchor(row.row_id, after), after.before_id);
          }
          for (const [id, successor] of successors) {
            const link = links.get(id);
            settle(id, Promise.all([confirmed, successor.previous, link]).then(([final, previous, relationship]) => {
              const change = final.plan.changes.find(change => change.before.row_id === id), member = final.members.find(member => member.row_id === id);
              return {placement: change ? change.after : member ?? previous.placement, link: relationship ?? previous.link};
            }));
          }
          const ids = accepted.changes.map(change => change.before.row_id), revisions = new Map(presentation.map(change => [change.before.row_id, this.fields.get(change.before.row_id)?.revision]));
          const receiptOwner = this.watch(ids, {result: committed, committed}, new Map([...links].filter(([id]) => changed.has(id))), revisions);
          for (const change of presentation) if (!changed.has(change.before.row_id)) {
            const row = this.fields.get(change.before.row_id)!; this.fields.set(row.row_id, {...row, receiptOwner});
            const link = links.get(row.row_id); if (link) this.restoreRelationship(row.row_id, link);
          }
          void Promise.all([confirmed, committed]).then(([final, receipt]) => {
            let repaired = false;
            for (const change of presentation) {
              const row = this.fields.get(change.before.row_id);
              if (!row || row.receiptOwner !== receiptOwner || row.revision !== revisions.get(row.row_id)) continue;
              const physical = final.plan.changes.find(change => change.before.row_id === row.row_id);
              const after = physical ? physical.after : final.members.find(member => member.row_id === row.row_id) ?? null;
              const hidden = after === null;
              if (row.hidden !== hidden || after && (row.parent_id !== after.parent_id || row.parent_ref !== after.parent_ref || row.after_id !== after.after_id || (row.before_id ?? null) !== after.before_id)) repaired = true;
              this.fields.set(row.row_id, {...row, ...(after ? {parent_id: after.parent_id, parent_ref: after.parent_ref, after_id: after.after_id, before_id: after.before_id ?? undefined} : {}), hidden, settledRevision: receipt.store_revision});
              if (after) this.place(row.row_id, anchor(row.row_id, after), after.before_id);
            }
            if (repaired || JSON.stringify(final.plan.selection_after) !== JSON.stringify(accepted.selection_after)) this.owner?.installRange(final.plan, mayFocus, action);
            this.resume(); this.notify();
          }).catch(error => this.fail(error)).finally(finish);
          release(); this.owner?.installRange(accepted, mayFocus, action);
        },
      };
    };
    const publication = reserve(initial, snapshot, null);
    const prepare = async (readLinks: (link_ids: readonly string[]) => Promise<readonly LinkState[]>) => {
      const predecessors = new Map<string, RangeState>();
      try {for (const [id, future] of initial.states) predecessors.set(id, await future);}
      finally {initial.states.clear();}
      const rows = snapshot.rows.map(item => {
        const placement = predecessors.get(item.row_id)?.placement;
        return placement ? {...item, parent_id: placement.parent_id, parent_ref: placement.parent_ref, link_id: predecessors.get(item.row_id)!.link?.link_id ?? item.link_id} : {...item};
      });
      const byId = new Map(rows.map(row => [row.row_id, row])), children = new Map<string | null, typeof rows>();
      for (const row of rows) {const siblings = children.get(row.parent_id) ?? []; siblings.push(row); children.set(row.parent_id, siblings);}
      const reparented = new Set(rows.flatMap((row, index) => row.parent_id === snapshot.rows[index]!.parent_id && row.parent_ref === snapshot.rows[index]!.parent_ref
        ? [] : [row.parent_id, snapshot.rows[index]!.parent_id]));
      if ([...children].some(([parent, siblings]) => reparented.has(parent) && siblings.some(row => row.gap)))
        return {kind: "refusal" as const, reason: "gap" as const};
      const items = rows.filter(row => row.selectable && (!predecessors.has(row.row_id) || predecessors.get(row.row_id)!.placement !== null));
      const links = new Map((await readLinks([...new Set(items.flatMap(row => row.link_id ? [row.link_id] : []))])).map(link => [link.link_id, link]));
      const positions = new Map<string, string>();
      for (const row of items) {
        const link = row.link_id ? links.get(row.link_id) : null;
        const position = link?.endpoint_a === row.parent_ref && link.endpoint_b === row.ref ? link.position_a
          : link?.endpoint_b === row.parent_ref && link.endpoint_a === row.ref ? link.position_b : null;
        if (!link || !isVisible(link.add_vv, link.remove_vv) || !position) return {kind: "refusal" as const, reason: "changed" as const};
        positions.set(row.row_id, position.value);
      }
      // One leased graph head owns order. Captured links below still own observed membership; a fresh position read does not extend it.
      for (const [parent, siblings] of children) {
        const sorted = siblings.filter(row => positions.has(row.row_id)).sort((a, b) => {
          const x = positions.get(a.row_id)!, y = positions.get(b.row_id)!;
          return x < y ? -1 : x > y ? 1 : a.link_id! < b.link_id! ? -1 : a.link_id! > b.link_id! ? 1 : 0;
        });
        let at = 0;
        children.set(parent, siblings.map(row => positions.has(row.row_id) ? sorted[at++]! : row));
      }
      const ordered: typeof rows = [], visited = new Set<string>();
      const append = (row: typeof rows[number]) => {
        if (visited.has(row.row_id) || predecessors.has(row.row_id) && predecessors.get(row.row_id)!.placement === null) return;
        visited.add(row.row_id); ordered.push(row); for (const child of children.get(row.row_id) ?? []) append(child);
      };
      for (const row of rows) if (row.parent_id === null || !byId.has(row.parent_id)) append(row);
      const occurrences: OccurrenceBookmark[] = ordered.flatMap(row => row.ref === null ? [] : [{row_id: row.row_id, ref: row.ref,
        placement: predecessors.get(row.row_id)?.placement ?? null, link: predecessors.get(row.row_id)?.link ?? null}]);
      const result = planRange(plan.command, {rows: ordered}, plan.selection_before, plan.destination);
      return result.kind === "refusal" ? result : {...result, snapshot: {rows: ordered}, occurrences, plan: plan.command === "remove" && plan.selection_before?.kind === "text"
        ? {...result.plan, selection_after: plan.selection_after} : result.plan};
    };
    const documents = selected.flatMap(id => {const row = captured.get(id); const document = row?.ref ? owner.document(row.ref) : null; return document ? [document] : [];});
    owner.history.range({plan, documents, snapshot, metadata: () => [...captured.values()], canRetain: () => this.owner?.canRetain() ?? false, prepare, publication, reserve: action => reserve(pin(false), this.owner?.rangeSnapshot() ?? snapshot, action), active: () => this.owner === owner,
      refused: callbacks.refused});
  }
  resume(): void {
    if (this.finishing) {this.resumeAgain = true; return;}
    if (![...this.bound].some(([id, bound]) => bound.settled && this.fields.get(id)?.pending)) return;
    let changed = false;
    this.finishing = (async () => {
      for (const [id, bound] of this.bound) {
        const row = this.fields.get(id);
        if (!row?.pending || !bound.settled) continue;
        const revision = row.revision, token = row.receiptOwner, relationship = bound.link;
        const observed = await relationship;
        if (bound.document) {
          const bytes = Y.encodeStateAsUpdate(bound.document.doc).byteLength;
          bound.captureBytes += bytes;
          try {await bound.document.capture().then(() => {});} finally {bound.captureBytes -= bytes;}
        }
        const field = this.fields.get(id);
        if (!field || this.bound.get(id) !== bound || field.revision !== revision || field.receiptOwner !== token || !bound.settled ||
          bound.link !== relationship && bound.link !== observed) continue;
        if (!field.hidden && bound.document && this.owner && !this.owner.confirmed(field, bound.document)) continue;
        const body = bound.document ? field.kind === "title" ? bodyText(bound.document.doc.getText("title").toString()) : readBody(bound.document.doc) : field.body;
        this.fields.set(id, {...field, body, pending: false}); changed = true;
        if (!bound.captureBytes && !bound.reservations && !bound.next) {bound.release(); this.bound.delete(id);}
        this.owner?.identity(this.fields.get(id)!);
      }
    })().catch(error => {this.resumeAgain = false; this.fail(error);}).finally(() => {
      const again = this.resumeAgain; this.resumeAgain = false; this.finishing = null;
      if (changed) this.notify();
      if (again) this.resume();
    });
  }
  acknowledge(row_id: string, owner: object, committed: Promise<LocalCommit>): void {
    const row = this.fields.get(row_id); if (row?.receiptOwner !== owner) return;
    // Capture before replacement: a later command may already need this
    // future, even when a superseding owner suppresses its publication.
    const previous = this.observedLink(row_id);
    const link = previous ? Promise.all([previous, committed]).then(([observed, receipt]) => advanceRelationship(observed, receipt)) : null;
    if (link) this.restoreRelationship(row_id, link);
    const retained = this.bound.get(row_id); if (retained) retained.settled = false;
    void committed.then(async receipt => {
      await link;
      const field = this.fields.get(row_id);
      if (field?.receiptOwner !== owner || this.bound.get(row_id) !== retained || field.ref !== row.ref) return;
      this.fields.set(row_id, {...field, settledRevision: receipt.store_revision});
      const bound = this.bound.get(row_id); if (bound) bound.settled = true;
      else this.fields.set(row_id, {...this.fields.get(row_id)!, pending: false});
      this.resume(); this.notify();
    }).catch(error => this.fail(error));
  }
  /** Finishes what settled writing still owes; a failed commit is the runtime's to resend. */
  retry(): void {
    if (this.retrying) return;
    const failures = this.failures;
    this.retrying = true; this.notify();
    this.resume();
    void (async () => {while (this.finishing) await this.finishing;})().then(() => {
      this.retrying = false;
      if (this.failures === failures) this.error = null;
      this.notify();
    });
  }
}
