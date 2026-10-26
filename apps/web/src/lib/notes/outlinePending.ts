/** Retained native input, not another editor or persistence queue. Fields become
 * raw before a structural display change. Their ordered edits merge over the
 * exact structural receipt; a receipt never replaces writing already displayed.
 * The existing history/runtime owns commands, retry bytes and causal inverses. */
import * as Y from "yjs";
import {applyBodyEdits, bodyInline, decodeBytes, encodeBytes, hydrateNote, readBody, type BodyEdit} from "@nexus/authored/documents";
import {bodyText, docFromBody, noteBodySchema, sameBody, type InlineNode, type NoteBody} from "@nexus/authored/body";
import type {LinkState, ResourceProjection, Vector} from "@nexus/authored/types";
import type {Intent} from "@nexus/authored/commands";
import {advanceCoverage} from "@nexus/authored/merge";
import type {NoteEdit} from "./editorTypes";
import type {FocusSelection} from "./editorTypes";
import type {CreatedOutlineNote, OutlineHistory} from "./structure";
import type {WritingDocument, WritingRuntime, WritingSnapshot} from "./runtime";
import {clipboardPlainText} from "./clipboard";
import {snapshotIncludesDocument} from "./outlineBinding";

export interface PendingOutlineField {
  row_id: string;
  parent_id: string | null;
  parent_ref: string;
  after_id: string | null;
  before_id?: string;
  ref: string | null;
  link: LinkState | null;
  kind: "body" | "title" | "reference";
  resource?: ResourceProjection | null;
  body: NoteBody;
  hidden: boolean;
  raw: boolean;
  origin: unknown;
  relocating?: string;
  previousParent?: string | null;
  previousLink?: string;
  settledRevision?: string;
}
interface BoundField {document: WritingDocument; clone: Y.Doc; observed: Promise<Vector>; release(): void; stop(): void}
type Event =
  | {kind: "edit"; row_id: string; before: NoteBody; after: NoteBody; selectionBefore: NoteEdit["selectionBefore"]; selectionAfter: NoteEdit["selectionAfter"]; admission: number; applied?: boolean}
  | {kind: "split"; row_id: string; successor: string; parent_id: string | null; parent_ref: string; from: number; to: number; admission: number; receipt?: CreatedOutlineNote; sourceApplied?: boolean}
  | {kind: "create"; row_id: string; parent_id: string | null; parent_ref: string; after_id: string | null; body: NoteBody; after: string | null; prelude: readonly Intent[]; admission: number; receipt?: CreatedOutlineNote}
  | {kind: "unlink"; row_id: string; admission: number; applied?: boolean}
  | {kind: "relink"; row_id: string; parent_id: string; destination: string; after_id: string | null; before: {parent_id: string | null; parent_ref: string}; predecessor: string | null; selection: FocusSelection | null; admission: number; receipt?: string; token: string}
  | {kind: "move"; row_id: string; parent_id: string | null; parent_ref: string; peer: {row_id: string; link: LinkState | null}; direction: "up" | "down"; selection: FocusSelection | null; admission: number; receipt?: {store_revision: string; link: LinkState}; token: string}
  | {kind: "join"; destination: string; source: string; admission: number; receipt?: WritingSnapshot & {ref: string; store_revision: string; input_offset: number}; previous?: Vector; applied?: boolean};

export class OutlinePendingInput {
  readonly root_id = crypto.randomUUID();
  readonly fields = new Map<string, PendingOutlineField>();
  order: readonly string[] = [];
  private readonly bound = new Map<string, BoundField>();
  private readonly events: Event[] = [];
  private running = false;
  private progress: Promise<void> = Promise.resolve();
  private notify = () => {};
  private adopted: ((row: PendingOutlineField, document: WritingDocument, snapshot: WritingSnapshot) => boolean) | null = null;
  private changedIdentity: ((row: PendingOutlineField) => void) | null = null;
  private history: OutlineHistory | null = null;
  private originHistory: OutlineHistory | null = null;
  error: unknown | null = null;
  constructor(private readonly runtime: WritingRuntime) {}
  connect(history: OutlineHistory, notify: () => void,
    adopted: (row: PendingOutlineField, document: WritingDocument, snapshot: WritingSnapshot) => boolean,
    changedIdentity: (row: PendingOutlineField) => void): () => void {
    if (this.originHistory !== history) {
      for (const [id, field] of this.fields) this.fields.set(id, {...field, origin: history.typingOrigin()});
      for (const event of this.events) event.admission = history.admit();
      this.originHistory = history;
    }
    this.history = history; this.notify = notify; this.adopted = adopted; this.changedIdentity = changedIdentity;
    return () => {if (this.adopted === adopted) {this.adopted = null; this.changedIdentity = null;}};
  }
  risk() {return {changed: [...this.fields.values()].some(field => field.raw), unconfirmed: this.running, stopsBrowserWork: false};}
  retainedRefs(): ReadonlySet<string> {return new Set([...this.fields.values()].filter(field => (field.raw || field.relocating) && field.ref !== null).map(field => field.ref!));}
  provisionalCount(): number {return [...this.fields.values()].filter(field => field.raw && field.ref === null).length;}
  retainedBytes(): number {return [...this.bound.values()].reduce((bytes, bound) => bytes + Y.encodeStateAsUpdate(bound.clone).byteLength, 0)
    + new TextEncoder().encode(JSON.stringify({fields: [...this.fields.values()].filter(field => field.raw).map(field => field.body.body_pm_json), events: this.events})).byteLength;}
  copyText(): string | null {
    const rows = this.order.flatMap(id => {const field = this.fields.get(id); return field?.raw && !field.hidden ? [field] : [];});
    return rows.length ? rows.map(field => clipboardPlainText(noteBodySchema.nodeFromJSON(field.body.body_pm_json).content)).join("\n") : null;
  }
  freeze(row: PendingOutlineField, document: WritingDocument, body_state: string, proof: Promise<WritingSnapshot>): void {
    if (this.fields.get(row.row_id)?.raw) return;
    this.fields.set(row.row_id, {...this.fields.get(row.row_id), ...row, raw: true});
    this.bound.set(row.row_id, this.bind(row, document, body_state, proof.then(snapshot => snapshot.observed_touch)));
  }
  private bind(row: PendingOutlineField, document: WritingDocument, body_state: string, observed: Promise<Vector>): BoundField {
    const clone = row.kind === "title" ? new Y.Doc() : hydrateNote(body_state);
    if (row.kind === "title") Y.applyUpdate(clone, decodeBytes(body_state));
    const bound: BoundField = {document, clone, observed, release: document.retain(), stop: () => {}};
    bound.stop = document.onCommitted((receipt, origin) => {
      if (origin !== this.fields.get(row.row_id)?.origin) return;
      const touch = receipt.change.resources.find(patch => patch.ref === document.ref)?.touch_vv;
      const before = receipt.before.resources.find(state => state.ref === document.ref);
      const proof = encodeBytes(Y.encodeStateAsUpdate(bound.clone));
      if (touch && snapshotIncludesDocument(proof, document.doc)) bound.observed = bound.observed.then(previous => advanceCoverage(previous, before ? {touch: before.touch_vv, removed: before.delete_vv} : null, touch));
    });
    return bound;
  }
  edit(row_id: string, edit: NoteEdit): void {
    const row = this.fields.get(row_id);
    if (!row?.raw || !this.history) throw new Error("pending outline field is not owned");
    this.fields.set(row_id, {...row, body: edit.after});
    const previous = this.events.at(-1);
    if (previous?.kind === "edit" && previous.row_id === row_id && (!this.running || this.events.length > 1)) {previous.after = edit.after; previous.selectionAfter = edit.selectionAfter;}
    else this.events.push({kind: "edit", row_id, before: edit.before, after: edit.after,
      selectionBefore: edit.selectionBefore, selectionAfter: edit.selectionAfter, admission: this.history.admit()});
    this.notify(); this.run();
  }
  split(row_id: string, left: NoteBody, right: NoteBody, from: number, to: number, placement?: {parent_id: string; parent_ref: string; after_id: string | null}): string {
    const row = this.fields.get(row_id);
    if (!row?.raw || !this.history) throw new Error("split requires its retained displayed field");
    const successor = crypto.randomUUID();
    this.fields.set(row_id, {...row, body: left});
    this.fields.set(successor, {...row, ...placement, row_id: successor, after_id: placement?.after_id ?? row_id, ref: null, link: null, resource: null, kind: "body", body: right, hidden: false,
      before_id: undefined, relocating: undefined, previousParent: undefined, previousLink: undefined, settledRevision: undefined, origin: this.history.typingOrigin()});
    const at = this.order.indexOf(row_id);
    this.order = [...this.order.slice(0, at + 1), successor, ...this.order.slice(at + 1)];
    const target = this.fields.get(successor)!;
    this.events.push({kind: "split", row_id, successor, parent_id: target.parent_id, parent_ref: target.parent_ref, from, to, admission: this.history.admit()});
    this.notify(); this.run(); return successor;
  }
  create(row: PendingOutlineField, after: string | null, prelude: readonly Intent[] = []): void {
    if (!this.history) throw new Error("outline history is unavailable");
    this.fields.set(row.row_id, {...row, raw: true});
    this.events.push({kind: "create", row_id: row.row_id, parent_id: row.parent_id, parent_ref: row.parent_ref, after_id: row.after_id, body: row.body, after, prelude, admission: this.history.admit()});
    this.notify(); this.run();
  }
  join(destination: string, source: string, body: NoteBody): void {
    const to = this.fields.get(destination), from = this.fields.get(source);
    if (!to?.raw || !from?.raw || !this.history) throw new Error("join requires both retained displayed fields");
    this.fields.set(destination, {...to, body}); this.fields.set(source, {...from, hidden: true});
    this.events.push({kind: "join", destination, source, admission: this.history.admit()});
    this.notify(); this.run();
  }
  unlink(row_id: string): void {
    const row = this.fields.get(row_id); if (!row?.raw || !this.history) throw new Error("unlink requires its retained occurrence");
    this.fields.set(row_id, {...row, hidden: true});
    this.events.push({kind: "unlink", row_id, admission: this.history.admit()}); this.notify(); this.run();
  }
  relink(row_id: string, parent_id: string, parent_ref: string, after_id: string | null, predecessor: string | null, selection: FocusSelection | null): void {
    const row = this.fields.get(row_id); if (!row || !this.history) throw new Error("reparent requires its retained occurrence");
    const token = crypto.randomUUID();
    this.fields.set(row_id, {...row, parent_id, parent_ref, after_id, before_id: undefined, relocating: token, previousParent: row.relocating ? row.previousParent : row.parent_id,
      previousLink: row.relocating ? row.previousLink : row.link?.link_id, settledRevision: undefined});
    this.events.push({kind: "relink", row_id, parent_id, destination: parent_ref, after_id, before: {parent_id: row.parent_id, parent_ref: row.parent_ref}, predecessor, selection, admission: this.history.admit(), token}); this.notify(); this.run();
  }
  move(row_id: string, peer: {row_id: string; link: LinkState | null}, direction: "up" | "down", selection: FocusSelection | null): void {
    const row = this.fields.get(row_id); if (!row || !this.history) throw new Error("move requires its retained occurrence");
    const token = crypto.randomUUID();
    this.fields.set(row_id, {...row, after_id: direction === "down" ? peer.row_id : null, before_id: direction === "up" ? peer.row_id : undefined,
      relocating: token, previousParent: row.relocating ? row.previousParent : row.parent_id, previousLink: row.relocating ? row.previousLink : row.link?.link_id, settledRevision: undefined});
    const order = this.order.filter(id => id !== row_id);
    if (!order.includes(peer.row_id)) order.splice(Math.max(0, this.order.indexOf(row_id)), 0, peer.row_id);
    const at = order.indexOf(peer.row_id); order.splice(at + (direction === "down" ? 1 : 0), 0, row_id); this.order = order;
    this.events.push({kind: "move", row_id, parent_id: row.parent_id, parent_ref: row.parent_ref, peer, direction, selection, admission: this.history.admit(), token});
    this.notify(); this.run();
  }
  private parentRef(parent_id: string | null, fallback: string): string {
    const parent = parent_id ? this.fields.get(parent_id) : null;
    if (parent && parent.ref === null) throw new Error("the pending parent has not received its identity");
    return parent?.ref ?? fallback;
  }
  private async bindCreated(row_id: string, note: CreatedOutlineNote): Promise<void> {
    const document = await this.runtime.openDocument(note.ref);
    const release = document.retain();
    try {
      const states = await (await this.runtime.store).readStates({refs: [], link_ids: [note.link_id], anchor_ids: [], source_refs: []});
      const link = states.links.find(link => link.link_id === note.link_id);
      if (!link) throw new Error("created occurrence has no committed relationship");
      const bound = this.bind(this.fields.get(row_id)!, document, note.body_state, Promise.resolve(note.observed_touch));
      const previous = this.bound.get(row_id);
      previous?.stop(); previous?.release(); previous?.clone.destroy();
      this.bound.set(row_id, bound);
      const field = this.fields.get(row_id)!;
      const current = {...field, ref: note.ref, link, ...(field.relocating ? {previousLink: field.previousLink ?? link.link_id} : {settledRevision: note.store_revision})};
      this.fields.set(row_id, current); this.changedIdentity?.(current); this.notify();
      for (const [id, child] of this.fields) if (child.parent_id === row_id) this.fields.set(id, {...child, parent_ref: note.ref});
    } finally {release();}
  }
  private async snapshot(row_id: string): Promise<WritingSnapshot> {
    const bound = this.bound.get(row_id);
    if (!bound) throw new Error("pending field has no structural receipt");
    return {observed_touch: await bound.observed, body_state: encodeBytes(Y.encodeStateAsUpdate(bound.clone))};
  }
  private async applyEdit(event: Extract<Event, {kind: "edit"}>, history: OutlineHistory): Promise<void> {
    const bound = this.bound.get(event.row_id), field = this.fields.get(event.row_id);
    if (!bound || !field || !this.history) throw new Error("pending edit lost its receipt");
    if (event.applied) {await bound.document.capture(); return;}
    await bound.observed;
    const editor = history.editor(bound.document, field.origin), release = editor.retain();
    try {
      if (field.kind === "title") {
        const text = bound.clone.getText("title"), after = clipboardPlainText(noteBodySchema.nodeFromJSON(event.after.body_pm_json).content);
        const before = text.toString(); let start = 0, end = 0;
        if (before !== clipboardPlainText(noteBodySchema.nodeFromJSON(event.before.body_pm_json).content)) throw new Error("pending title does not match its displayed baseline");
        while (start < before.length && start < after.length && before[start] === after[start]) start++;
        while (end < before.length - start && end < after.length - start && before[before.length - end - 1] === after[after.length - end - 1]) end++;
        const baseline = Y.encodeStateVector(bound.clone);
        bound.clone.transact(() => {text.delete(start, before.length - start - end); text.insert(start, after.slice(start, after.length - end));});
        Y.applyUpdate(bound.document.doc, Y.encodeStateAsUpdate(bound.clone, baseline), editor.origin);
      } else {
        const shown = readBody(bound.clone);
        if (!sameBody(shown, event.before)) throw new Error("pending edit does not match its displayed baseline");
        const before = docFromBody(event.before).firstChild!, after = docFromBody(event.after).firstChild!;
        const start = before.content.findDiffStart(after.content), edits: BodyEdit[] = [];
        if (start !== null) {
          const end = before.content.findDiffEnd(after.content)!, overlap = Math.max(0, start - Math.min(end.a, end.b));
          const content: InlineNode[] = [];
          // justify-type-assertion: both nodes come from the canonical body schema.
          after.content.cut(start, end.b + overlap).forEach(node => content.push(node.toJSON() as InlineNode));
          edits.push({kind: "replace", from: start, to: end.a + overlap, content});
        }
        if (before.attrs.presentation !== after.attrs.presentation) edits.push({kind: "presentation", value: after.attrs.presentation});
        const baseline = Y.encodeStateVector(bound.clone);
        applyBodyEdits(bound.clone, edits);
        Y.applyUpdate(bound.document.doc, Y.encodeStateAsUpdate(bound.clone, baseline), editor.origin);
      }
      editor.record(event, event.admission, {key: event.row_id, ref: bound.document.ref, selection: event.selectionAfter,
        ...(field.link && field.parent_id ? {occurrence: {parent_ref: field.parent_ref, link_id: field.link.link_id, parent_id: field.parent_id}} : {})});
      event.applied = true;
      await bound.document.capture();
    } finally {release();}
  }
  private run(): void {
    if (this.running || !this.history) return;
    this.running = true; this.error = null; this.notify();
    this.progress = (async () => {
      while (true) {
        const event = this.events[0];
        if (!event) break;
        const history = this.history!;
        if (event.kind === "edit") await this.applyEdit(event, history);
        else if (event.kind === "create") {
          const field = this.fields.get(event.row_id)!;
          event.receipt ??= await history.withFocus(null, () => history.create(this.parentRef(event.parent_id, event.parent_ref),
            event.after_id ? this.fields.get(event.after_id)?.link?.link_id ?? event.after : event.after, event.body, event.prelude),
          note => ({key: field.row_id, ref: note.ref, selection: "end", ...(event.parent_id ? {occurrence: {parent_ref: this.parentRef(event.parent_id, event.parent_ref), parent_id: event.parent_id, link_id: note.link_id}} : {})}), event.admission);
          await this.bindCreated(event.row_id, event.receipt);
        } else if (event.kind === "split") {
          const source = this.fields.get(event.row_id)!, bound = this.bound.get(event.row_id)!;
          if (!event.receipt) {
            const {body_state} = await this.snapshot(event.row_id);
            event.receipt = await history.withFocus({key: source.row_id, ref: source.ref!, selection: {anchor: event.from + 1, head: event.to + 1}},
              () => {const current = this.fields.get(event.row_id)!; return history.split(current.ref!, {body_state, from: event.from, to: event.to}, this.parentRef(event.parent_id, event.parent_ref), current.link?.link_id ?? null);},
              note => ({key: event.successor, ref: note.ref, selection: {anchor: 1, head: 1}, ...(event.parent_id ? {occurrence: {parent_ref: this.parentRef(event.parent_id, event.parent_ref), parent_id: event.parent_id, link_id: note.link_id}} : {})}), event.admission);
          }
          if (!event.sourceApplied) {
            applyBodyEdits(bound.clone, [{kind: "replace", from: event.from, to: bodyInline(bound.clone).length, content: []}]);
            event.sourceApplied = true;
            const proof = encodeBytes(Y.encodeStateAsUpdate(bound.clone)), touch = event.receipt.observed_touch;
            const before = event.receipt.source_before ?? null;
            if (snapshotIncludesDocument(proof, bound.document.doc)) bound.observed = bound.observed.then(previous => advanceCoverage(previous, before, touch));
          }
          await this.bindCreated(event.successor, event.receipt);
        } else if (event.kind === "relink") {
          const current = this.fields.get(event.row_id)!;
          if (!event.receipt) event.receipt = await history.withFocus({key: event.row_id, ref: current.ref!, selection: event.selection,
            ...(current.link && event.before.parent_id ? {occurrence: {parent_ref: this.parentRef(event.before.parent_id, event.before.parent_ref), link_id: current.link.link_id, parent_id: event.before.parent_id}} : {})}, () => {
            const live = this.fields.get(event.row_id)!; if (!live.link || !live.ref) throw new Error("pending occurrence has no committed relationship");
            const from = live.link.endpoint_a === live.ref ? live.link.endpoint_b : live.link.endpoint_a;
            return history.relink(live.link, from, this.parentRef(event.parent_id, event.destination),
              event.after_id ? this.fields.get(event.after_id)?.link?.link_id ?? event.predecessor : event.predecessor, (link, receipt) => {
              event.receipt = link.link_id;
              const live = this.fields.get(event.row_id)!;
              const field = {...live, link, ...(live.relocating === event.token ? {settledRevision: receipt.store_revision} : {})};
              this.fields.set(event.row_id, field); this.changedIdentity?.(field);
            });
          }, link_id => ({key: event.row_id, ref: current.ref!, selection: event.selection, occurrence: {parent_ref: this.parentRef(event.parent_id, event.destination), parent_id: event.parent_id, link_id}}), event.admission);
          const states = await (await this.runtime.store).readStates({refs: [], link_ids: [event.receipt], anchor_ids: [], source_refs: []});
          const row = {...this.fields.get(event.row_id)!, link: states.links[0] ?? null}; this.fields.set(event.row_id, row); this.changedIdentity?.(row);
        } else if (event.kind === "move") {
          const current = this.fields.get(event.row_id)!;
          const bookmark = {key: event.row_id, ref: current.ref!, selection: event.selection,
            ...(current.link && event.parent_id ? {occurrence: {parent_ref: this.parentRef(event.parent_id, event.parent_ref), parent_id: event.parent_id, link_id: current.link.link_id}} : {})};
          event.receipt ??= await history.withFocus(bookmark, () => {
            const row = this.fields.get(event.row_id)!, other = this.fields.get(event.peer.row_id)?.link ?? event.peer.link;
            if (!row.link || !other) throw new Error("moving occurrences have not received their relationships");
            return history.move(row.link, this.parentRef(event.parent_id, event.parent_ref), event.direction === "up" ? [other, row.link] : [row.link, other], event.direction === "up" ? 0 : 1);
          }, () => bookmark, event.admission);
          const live = this.fields.get(event.row_id)!;
          const row = {...live, link: event.receipt.link, ...(live.relocating === event.token ? {settledRevision: event.receipt.store_revision} : {})};
          this.fields.set(event.row_id, row); this.changedIdentity?.(row);
        } else if (event.kind === "unlink") {
          const row = this.fields.get(event.row_id)!;
          if (!event.applied && row.link) {
            const revision = await history.withFocus(null, () => history.unlink(row.link!), () => null, event.admission);
            event.applied = true; this.fields.set(row.row_id, {...this.fields.get(row.row_id)!, settledRevision: revision});
          }
        } else {
          const source = this.fields.get(event.source)!, destination = this.fields.get(event.destination)!;
          if (!event.receipt) {
            const sourceSnapshot = await this.snapshot(event.source), destinationSnapshot = await this.snapshot(event.destination);
            event.previous = destinationSnapshot.observed_touch;
            event.receipt = await history.withFocus({key: source.row_id, ref: source.ref!, selection: {anchor: 1, head: 1}},
              () => history.join(destination.ref!, source.ref!, {source: sourceSnapshot, destination: destinationSnapshot}),
              () => ({key: destination.row_id, ref: destination.ref!, selection: "end"}), event.admission);
          }
          if (!event.applied) {
            const bound = this.bound.get(event.destination)!; bound.clone.destroy(); bound.clone = hydrateNote(event.receipt.body_state);
            bound.observed = Promise.resolve(snapshotIncludesDocument(event.receipt.body_state, bound.document.doc) ? event.receipt.observed_touch : event.previous!);
            event.applied = true;
            this.fields.set(source.row_id, {...this.fields.get(source.row_id)!, settledRevision: event.receipt.store_revision});
          }
        }
        if (this.events[0] === event) this.events.shift();
        this.notify();
      }
      // A new edit can arrive during the final capture. Re-check both the queue
      // and each visible body before transferring identities to the same view.
      const snapshots = new Map<string, WritingSnapshot>();
      for (const [id, bound] of this.bound) {
        await bound.document.capture();
        if (this.events.length) return;
        const field = this.fields.get(id)!;
        const body = field.kind === "title" ? bodyText(bound.clone.getText("title").toString()) : readBody(bound.clone);
        if (!field.hidden && !sameBody(body, field.body)) throw new Error("pending field changed before adoption");
        snapshots.set(id, await this.snapshot(id));
      }
      if (this.events.length) return;
      for (const [id, bound] of this.bound) {
        const field = this.fields.get(id)!;
        if (!field.hidden && this.adopted?.(field, bound.document, snapshots.get(id)!) === false) continue;
        this.fields.set(id, {...field, raw: false}); bound.stop(); bound.release(); bound.clone.destroy();
        this.bound.delete(id);
      }
    })().catch(error => {this.error = error;}).finally(() => {
      this.running = false; this.notify(); if (this.events.length && this.error === null) this.run();
    });
  }
  retry(): void {if (this.error !== null) {this.error = null; this.run();}}
  resume(): void {if (!this.running && this.bound.size && this.error === null) this.run();}
  async ready(row_id: string): Promise<PendingOutlineField> {
    await this.progress;
    if (this.error !== null) throw this.error;
    const row = this.fields.get(row_id);
    if (!row?.ref) throw new Error("the pending note has not received its identity");
    return row;
  }
}
