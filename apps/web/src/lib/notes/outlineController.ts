/** One mounted outline projection and admission owner. Durable fields remain
 * independent documents; raw in-flight input remains in the retained cell. */
import * as Y from "yjs";
import {type Node as PMNode} from "prosemirror-model";
import {Plugin, TextSelection, NodeSelection} from "prosemirror-state";
import type {EditorView, NodeView} from "prosemirror-view";
import {bodyText, docFromBody, emptyBody, noteBodySchema, parseBody, type NoteBody} from "@nexus/authored/body";
import {decodeBytes, readBody} from "@nexus/authored/documents";
import {isVisible} from "@nexus/authored/merge";
import type {Intent} from "@nexus/authored/commands";
import type {LinkState, ResourceProjection} from "@nexus/authored/types";
import {classifyOutlineOccurrence, enterOutlineOccurrence, type OutlineBranch, type OutlineTarget} from "@/lib/resources/outlineProjection";
import {localResourceHref, localResourceLabel} from "@/lib/resources/localResource";
import type {NoteEditorHandle, NoteEditorProjection, StructuralKeys} from "@/components/notes/NoteEditor";
import type {OutlineRowChrome, OutlineRowMount} from "@/components/notes/OutlineEditorRow";
import rowStyles from "@/components/notes/OutlineEditorRow.module.css";
import {OutlineBinding, type OutlineBindingField} from "./outlineBinding";
import {canonicalBody, fieldById, outlineEditorSchema, outlineTransactionSource, plainTitle} from "./outlineEditorModel";
import {OutlinePendingInput} from "./outlinePending";
import {OutlineHistory, type OutlineBookmark} from "./structure";
import type {WritingDocument, WritingRuntime} from "./runtime";
import type {OutlineWindow, OutlineEdge} from "./useOutlineWindow";
import type {FocusSelection, NoteEdit, OutlineCommand} from "./editorTypes";
import {clipboardPlainText, readOutlineClipboard, writeOutlineClipboard, type ClipItem} from "./clipboard";
import {prepareTarget} from "@/lib/resourceGraph/links";

export interface OutlineRow {
  row_id: string; ref: string | null; link: LinkState | null; parent_id: string | null; parent_ref: string;
  depth: number; branch: OutlineBranch; resource: ResourceProjection | null; kind: "body" | "title" | "reference";
  childrenAvailable: boolean; open: boolean; terminal: boolean; root: boolean; tail: boolean;
  gap?: "before" | "after" | "tail";
  origin: unknown;
}
export interface BranchRequest {parent_id: string; ref: string; branch: OutlineBranch; cursor: string | null; anchor: string | null; limit: number;
  navigation?: {lease(): boolean; previous: BranchRequest}}
interface Held {document: WritingDocument; release(): void}
export interface RootField {label: string; placeholder?: string; initialTitle?: string; inspection?: import("@/components/notes/NoteEditor").NoteInspection | null}
type Arrangement = Exclude<OutlineCommand, "undo" | "redo">;
type ArrangementPlan = {kind: "move"; row: OutlineRow; peer: OutlineRow | OutlineEdge; direction: "up" | "down"}
  | {kind: "indent"; row: OutlineRow; peer: OutlineRow | OutlineEdge}
  | {kind: "outdent"; row: OutlineRow; parent: OutlineRow};
const MAX_REFS = 64, MAX_BYTES = 16 * 1024 * 1024;

export class OutlineController {
  readonly binding = new OutlineBinding(new Map());
  readonly rows = new Map<string, OutlineRow>();
  private readonly occurrences = new Map<string, OutlineRow>();
  readonly windows = new Map<string, OutlineWindow>();
  readonly requests = new Map<string, BranchRequest>();
  readonly documents = new Map<string, Held>();
  readonly mounts = new Map<string, OutlineRowMount & {sync(): void}>();
  readonly selected = new Set<string>();
  private readonly identities = new Map<string, {id: string; origin: unknown}>();
  private readonly tailIds = new Map<string, string>();
  private readonly opened = new Set<string>();
  private readonly embedded = new Map<string, {owner: string; ref: string; branch: OutlineBranch}>();
  private readonly historyLeases = new Map<string, () => void>();
  private admission: Promise<void> = Promise.resolve();
  private versions = new Map<string, number>();
  private readonly proposals = new Map<string, OutlineWindow>();
  private readonly scheduled = new Set<string>();
  private readonly blockedRows = new Set<string>();
  private reservedWindows: ReadonlyMap<string, OutlineWindow> | null = null;
  private reservedBytes = 0;
  private readonly settlingRefs = new Set<string>();
  private readonly attempted = new Set<string>();
  private active = true;
  private intent = 0;
  private focused = false;
  private selectionRow: string | null = null;
  private selection = {anchor: 1, head: 1};
  private view: EditorView | null = null;
  private handle: NoteEditorHandle | null = null;
  private disconnect: (() => void) | null = null;
  private unbindFocus: (() => void) | null = null;
  private waiting: {row_id: string; selection: FocusSelection | null | ((document: WritingDocument) => FocusSelection); lease: () => boolean; resolve(): void} | null = null;
  private deferred = false;
  private initialTitleApplied = false;
  private titleEdited = false;
  filter = "";
  error: unknown | null = null;
  revealExternal: ((target: OutlineTarget) => void) | null = null;
  constructor(readonly runtime: WritingRuntime, readonly history: OutlineHistory, readonly pending: OutlinePendingInput,
    readonly rootRef: string, readonly rootBranch: OutlineBranch, public rootField: RootField | undefined,
    readonly prelude: readonly Intent[], private readonly notify: () => void, private readonly pendingChanged: () => void) {
    this.requests.set(pending.root_id, {parent_id: pending.root_id, ref: rootRef, branch: rootBranch, cursor: null, anchor: null, limit: 48});
    this.attempted.add(pending.root_id);
    for (const row of pending.fields.values()) if (row.link && (row.link.endpoint_a === row.ref ? row.link.endpoint_b : row.link.endpoint_a) === row.parent_ref)
      this.identities.set(`${row.parent_id}/${row.link.link_id}`, {id: row.row_id, origin: row.origin});
  }
  private connect(): void {
    this.disconnect = this.pending.connect(this.history, this.pendingChanged, (row, document, snapshot) => {
      if (!this.active || this.view === null) return true;
      if (!this.handle?.canArrange() || !fieldById(this.view.state.doc, row.row_id)) return false;
      if (!this.documents.has(document.ref)) this.documents.set(document.ref, {document, release: document.retain()});
      this.binding.adopt(row.row_id, this.field(row.row_id, document), snapshot);
      return true;
    }, row => {
      if (!this.active || this.view === null) return;
      if (row.link && (row.link.endpoint_a === row.ref ? row.link.endpoint_b : row.link.endpoint_a) === row.parent_ref) this.transfer(row.row_id, row.parent_id!, row.link.link_id, row.origin);
      this.changed();
    });
    for (const row of this.pending.fields.values()) if (row.link && (row.link.endpoint_a === row.ref ? row.link.endpoint_b : row.link.endpoint_a) === row.parent_ref)
      this.transfer(row.row_id, row.parent_id!, row.link.link_id, row.origin);
    this.unbindFocus = this.history.bindFocus({capture: () => this.capture(), prepare: (target, source, mayFocus) => this.prepare(target, source, mayFocus), restore: (bookmark, mayFocus) => {
      if (mayFocus && !mayFocus()) return Promise.resolve();
      const document = this.documents.get(bookmark.ref)?.document;
      return this.focus(bookmark.key, bookmark.selection === null ? null : bookmark.resolve && document ? bookmark.resolve(document) : bookmark.selection, mayFocus ?? this.lease());
    }, lease: () => this.lease()});
  }
  lease = () => {const at = this.intent; return () => this.active && at === this.intent;};
  revoke(): void {this.intent++; this.waiting?.resolve(); this.waiting = null;}
  setHandle(handle: NoteEditorHandle | null): void {this.handle = handle; if (handle) this.refresh();}
  setView(view: EditorView | null): void {
    this.view = view;
    if (view) {if (!this.disconnect) this.connect(); this.project(true); this.tryFocus();}
    else {this.disconnect?.(); this.disconnect = null; this.unbindFocus?.(); this.unbindFocus = null;}
  }
  setFocused(value: boolean): void {this.focused = value; if (!value) this.refresh(); this.notify();}
  withdraw(): void {this.focused = false; this.selected.clear(); this.refresh(); this.syncMetadata(); this.notify();}
  onSelectionChange = (row_id: string, at: {anchor: number; head: number}) => {
    if (!(this.view?.state.selection instanceof NodeSelection)) {
      if (this.selectionRow !== row_id) this.history.boundary();
      this.selectionRow = row_id; this.selection = at; this.selected.clear();
    }
    this.focused = this.view?.hasFocus() ?? false; this.syncMetadata(); this.notify(); if (this.deferred) this.refresh(); else this.project();
  };
  private changed(semantic = false): void {this.rebuild(semantic); this.notify();}
  refresh(): void {
    this.rebuild();
    if (this.handle?.canArrange()) {this.binding.refresh(); this.pending.resume(); for (const [id, window] of this.proposals) this.accept(id, window);}
  }
  configure(rootField: RootField | undefined): void {
    this.rootField = rootField;
    if (this.initialTitleApplied || this.titleEdited || !rootField?.initialTitle || !this.rootRef.startsWith("page:")) return;
    const document = this.documents.get(this.rootRef)?.document; if (!document) return;
    this.initialTitleApplied = true;
    const text = document.doc.getText("title"); if (text.length) return;
    const editor = this.history.editor(document, this.origin(this.pending.root_id)), release = editor.retain();
    try {
      document.doc.transact(() => text.insert(0, rootField.initialTitle!), editor.origin);
      editor.record({selectionBefore: {anchor: 1, head: 1}, selectionAfter: {anchor: text.length + 1, head: text.length + 1}}, undefined,
        {key: this.pending.root_id, ref: this.rootRef, selection: {anchor: text.length + 1, head: text.length + 1}});
    } finally {release();}
  }
  dismissKeyboard(): void {this.revoke(); if (!this.selected.size && this.view?.hasFocus()) {this.view.dom.blur(); this.focused = false; this.refresh(); this.notify();}}
  private id(parent: string, link: string): string {
    const key = `${parent}/${link}`;
    let row = this.identities.get(key); if (!row) {row = {id: crypto.randomUUID(), origin: this.history.typingOrigin()}; this.identities.set(key, row);} return row.id;
  }
  private origin(id: string): unknown {
    const pending = this.pending.fields.get(id); if (pending) return pending.origin;
    const row = [...this.identities.values()].find(row => row.id === id); if (row) return row.origin;
    const created = {id, origin: this.history.typingOrigin()}; this.identities.set(`row:${id}`, created); return created.origin;
  }
  private transfer(id: string, parent_id: string, link_id: string, origin: unknown): void {
    const key = `${parent_id}/${link_id}`;
    for (const [other, row] of this.identities) if (other !== key && row.id === id) this.identities.set(other, {id: crypto.randomUUID(), origin: this.history.typingOrigin()});
    this.identities.set(key, {id, origin});
  }
  private prepare(bookmark: OutlineBookmark | null, source: OutlineBookmark | null, mayFocus: () => boolean): (revision: string) => void {
    if (!bookmark) {
      const row = source ? this.rows.get(source.key) ?? this.occurrences.get(source.key) : null;
      if (!row?.link || row.root) return () => {};
      const moveSelection = this.selectionRow === row.row_id || this.selected.has(row.row_id);
      const peer = this.visiblePeer(row, "before") ?? this.visiblePeer(row, "after");
      this.pending.fields.set(row.row_id, {...this.pending.fields.get(row.row_id), row_id: row.row_id, parent_id: row.parent_id, parent_ref: row.parent_ref,
        after_id: null, ref: row.ref, link: row.link, kind: row.kind, resource: row.resource, body: emptyBody(), raw: false, hidden: true,
        origin: row.origin, settledRevision: undefined});
      this.selected.delete(row.row_id); if (moveSelection) this.selectionRow = null;
      this.changed(true);
      if (moveSelection && mayFocus()) {
        const next = peer ?? [...this.rows.values()].find(candidate => candidate.tail || candidate.root);
        if (next) void this.focus(next.row_id, next.kind === "reference" ? null : "end", mayFocus); else this.view?.dom.blur();
      }
      return revision => {const field = this.pending.fields.get(row.row_id); if (field?.hidden) {this.pending.fields.set(row.row_id, {...field, settledRevision: revision}); this.changed();}};
    }
    const occurrence = bookmark.occurrence;
    const row = this.rows.get(bookmark.key) ?? this.occurrences.get(bookmark.key);
    if (!occurrence || !row) return () => {};
    const parent_id = occurrence.parent_id ?? (occurrence.parent_ref === this.rootRef ? this.pending.root_id : [...this.occurrences.values()].find(row => row.ref === occurrence.parent_ref)?.row_id);
    if (!parent_id) return () => {};
    const token = crypto.randomUUID(), current = this.pending.fields.get(row.row_id);
    this.transfer(row.row_id, parent_id, occurrence.link_id, row.origin);
    const relation = [...this.windows.values()].flatMap(window => window.rows).find(candidate => candidate.link?.link_id === occurrence.link_id)?.link ?? current?.link ?? row.link;
    this.pending.fields.set(row.row_id, {...current, row_id: row.row_id, parent_id, parent_ref: occurrence.parent_ref, after_id: null,
      ref: bookmark.ref, link: relation, kind: row.kind, resource: row.resource, body: current?.body ?? emptyBody(), raw: current?.raw ?? false, hidden: false,
      origin: row.origin, relocating: token, previousParent: row.parent_id, previousLink: row.link?.link_id, settledRevision: undefined});
    if (parent_id !== this.pending.root_id && !this.opened.has(parent_id)) this.toggle(parent_id, true);
    this.changed(true);
    if (!this.documents.has(bookmark.ref)) {const owner = this.windows.has(parent_id) ? parent_id : this.pending.root_id; const window = this.windows.get(owner); if (window) this.accept(owner, window);}
    return revision => {const field = this.pending.fields.get(row.row_id); if (field?.relocating === token) {this.pending.fields.set(row.row_id, {...field, settledRevision: revision}); this.changed();}};
  }
  private tailId(parent: string): string {
    let id = this.tailIds.get(parent); if (!id) {id = crypto.randomUUID(); this.tailIds.set(parent, id);} return id;
  }
  private body(row_id: string): NoteBody {
    const raw = this.pending.fields.get(row_id);
    if (raw?.raw) return raw.body;
    const row = this.rows.get(row_id), document = row?.ref ? this.documents.get(row.ref)?.document : null;
    if (document) return row?.kind === "title" ? bodyText(document.doc.getText("title").toString()) : readBody(document.doc);
    return row?.kind === "title" ? bodyText(this.rootField?.initialTitle ?? row.resource?.title ?? "") : emptyBody();
  }
  private field(row_id: string, supplied?: WritingDocument): OutlineBindingField {
    const row = this.rows.get(row_id), raw = this.pending.fields.get(row_id);
    const document = supplied ?? (!raw?.raw && row?.ref ? this.documents.get(row.ref)?.document ?? null : null);
    return {kind: row?.kind === "title" ? "title" : "body", document, origin: row?.origin ?? this.origin(row_id), body: () => this.body(row_id),
      deferRefresh: () => [...this.embedded].some(([id, embedded]) => embedded.owner === row_id && this.protectedDescendants(id))};
  }
  private protectedRows(): Set<string> {
    const protectedRows = new Set([...this.pending.fields.values()].filter(row => row.raw || row.relocating).map(row => row.row_id));
    for (const id of this.selected) if (this.rows.has(id)) protectedRows.add(id);
    if (this.view?.hasFocus() && this.selectionRow) protectedRows.add(this.selectionRow);
    for (const id of [...protectedRows]) {let parent = this.parent(id); while (parent) {protectedRows.add(parent); parent = this.parent(parent);}}
    return protectedRows;
  }
  private protectedDescendants(parent_id: string): boolean {
    for (const id of this.protectedRows()) {let parent = this.parent(id); while (parent) {if (parent === parent_id) return true; parent = this.parent(parent);}}
    return false;
  }
  private rawPending(): boolean {return [...this.pending.fields.values()].some(row => row.raw);}
  private refs(windows?: ReadonlyMap<string, OutlineWindow>, historyRefs = this.history.retainedRefs()): Set<string> {
    const current = windows ?? this.reservedWindows ?? this.windows;
    return new Set([...(this.rootField ? [this.rootRef] : []), ...[...current.values()].flatMap(window => [...window.editableRefs]),
      ...[...this.pending.retainedRefs()].filter(ref => /^(note_block|page):/u.test(ref)), ...[...this.protectedRows()].flatMap(id => {const ref = this.rows.get(id)?.ref; return ref && /^(note_block|page):/u.test(ref) ? [ref] : [];}),
      ...[...historyRefs].filter(ref => /^(note_block|page):/u.test(ref)), ...(windows === undefined ? [...this.documents.keys(), ...this.settlingRefs] : [])]);
  }
  private slots(windows?: ReadonlyMap<string, OutlineWindow>, historyRefs?: ReadonlySet<string>): number {
    const owned = this.refs(windows, historyRefs).size + this.pending.provisionalCount();
    const tails = [...(windows ?? this.reservedWindows ?? this.windows).values()].filter(window => window.afterEdge === null).length;
    const visibleTails = windows ? [...this.rows.values()].filter(row => row.tail && !this.pending.fields.has(row.row_id) && !this.blockedRows.has(row.row_id) && windows.has(row.parent_id!) &&
      (!this.requests.get(row.parent_id!)?.navigation || windows.get(row.parent_id!) === this.windows.get(row.parent_id!))).length : 0;
    return owned + Math.max(visibleTails, Math.min(tails, Math.max(0, MAX_REFS - owned)));
  }
  private bytes(wanted = this.refs(), historyBytes = this.history.retainedBytes()): number {return [...this.documents].reduce((n, [ref, held]) => n + (wanted.has(ref) ? Y.encodeStateAsUpdate(held.document.doc).byteLength : 0), this.reservedBytes) + this.pending.retainedBytes() + historyBytes;}
  private denied(parent: string, message: string): void {if (this.attempted.has(parent)) {this.error = new Error(message); this.notify();}}
  private navigationValid(parent: string): boolean {
    const request = this.requests.get(parent);
    if (!request?.navigation || request.navigation.lease()) return true;
    this.requests.set(parent, request.navigation.previous); this.versions.set(parent, (this.versions.get(parent) ?? 0) + 1); this.proposals.delete(parent); this.notify();
    return false;
  }
  private admitNew(count = 1): boolean {
    if (this.slots() + count <= MAX_REFS && this.bytes() <= MAX_BYTES) {this.error = null; return true;}
    const windows = this.reservedWindows ?? this.windows;
    const withoutHistory = new Set<string>();
    if (this.slots(windows, withoutHistory) + count > MAX_REFS || this.bytes(this.refs(windows, withoutHistory), 0) > MAX_BYTES) {
      this.error = new Error("close a branch or load a smaller window before adding more writing"); this.notify(); return false;
    }
    while ((this.slots(windows) + count > MAX_REFS || this.bytes(this.refs(windows)) > MAX_BYTES) && this.history.releaseOldest()) {}
    if (this.slots() + count <= MAX_REFS && this.bytes() <= MAX_BYTES) {this.error = null; return true;}
    const wanted = this.refs(windows), retired = [...this.documents].filter(([ref]) => !wanted.has(ref) && !this.settlingRefs.has(ref));
    const message = "finishing older edits; try again";
    const finishing = this.error instanceof Error && this.error.message === message ? this.error : new Error(message);
    this.error = finishing; this.notify();
    if (retired.length) {
      for (const [ref] of retired) this.settlingRefs.add(ref);
      this.admission = this.admission.then(async () => {
        try {
          await Promise.all(retired.map(([, held]) => held.document.capture()));
          const keep = this.refs(this.reservedWindows ?? this.windows);
          for (const [ref, held] of retired) if (!keep.has(ref) && this.documents.get(ref) === held) {held.release(); this.documents.delete(ref); this.historyLeases.get(ref)?.(); this.historyLeases.delete(ref);}
          if (this.active) {if (this.error === finishing) this.error = null; this.changed();}
        } finally {for (const [ref] of retired) this.settlingRefs.delete(ref);}
      }).catch(error => {if (this.active) {this.error = error; this.notify();}});
    }
    return false;
  }
  accept(parent_id: string, window: OutlineWindow): void {
    if (this.proposals.get(parent_id) !== window) {this.proposals.set(parent_id, window); this.versions.set(parent_id, (this.versions.get(parent_id) ?? 0) + 1);}
    if (this.scheduled.has(parent_id)) return;
    this.scheduled.add(parent_id);
    const version = this.versions.get(parent_id)!;
    const request = this.requests.get(parent_id);
    let released = false, failed = false;
    this.admission = this.admission.then(async () => {
      if (!this.active || this.versions.get(parent_id) !== version || !this.requests.has(parent_id) || !this.navigationValid(parent_id)) return;
      if (this.windows.size && this.view && (this.rawPending() || !this.handle?.canArrange())) return;
      const next = this.reachable(new Map(this.windows).set(parent_id, window));
      while (this.slots(next) > MAX_REFS && this.history.releaseOldest()) {}
      if (this.slots(next) > MAX_REFS) {this.denied(parent_id, "this editing window is full; close a branch before loading more items"); return;}
      const refs = this.refs(next);
      const store = await this.runtime.store;
      const snapshot = await store.readSnapshot({refs: [...refs], link_ids: [], anchor_ids: [], source_refs: []});
      if (!this.active || this.versions.get(parent_id) !== version || !this.navigationValid(parent_id) || snapshot.replica.store_revision !== window.data.store_revision) return;
      const charge = () => [...this.refs(next)].reduce((bytes, ref) => {
        const held = this.documents.get(ref); if (held) return bytes + Y.encodeStateAsUpdate(held.document.doc).byteLength;
        const state = snapshot.states.resources.find(state => state.ref === ref);
        return bytes + (state?.kind === "note" ? decodeBytes(state.body_state).byteLength : state?.kind === "page" ? decodeBytes(state.title_state).byteLength : 0);
      }, this.pending.retainedBytes() + this.history.retainedBytes());
      while (charge() > MAX_BYTES && this.history.releaseOldest()) {}
      const newRefs = [...this.refs(next)].filter(ref => !this.documents.has(ref));
      if (newRefs.length && charge() > MAX_BYTES) {this.denied(parent_id, "this editing window is full; close a branch before loading more writing"); return;}
      const keep = this.refs(next), retired = [...this.documents].filter(([ref]) => !keep.has(ref));
      const activeRow = this.selectionRow ? this.rows.get(this.selectionRow) : null;
      if (this.view?.hasFocus() && activeRow?.ref && retired.some(([ref]) => ref === activeRow.ref)) return;
      this.reservedWindows = next;
      this.reservedBytes = newRefs.reduce((bytes, ref) => {const state = snapshot.states.resources.find(state => state.ref === ref); return bytes + (state?.kind === "note" ? decodeBytes(state.body_state).byteLength : state?.kind === "page" ? decodeBytes(state.title_state).byteLength : 0);}, 0);
      for (const [ref] of retired) this.settlingRefs.add(ref);
      for (const row of this.rows.values()) if (row.ref && retired.some(([ref]) => row.ref === ref)) this.blockedRows.add(row.row_id);
      if (this.requests.get(parent_id)?.navigation) for (const row of this.rows.values()) if (row.parent_id === parent_id && !row.root) this.blockedRows.add(row.row_id);
      this.syncReadOnly();
      try {await Promise.all(retired.map(([, held]) => held.document.capture()));}
      catch (error) {this.blockedRows.clear(); this.syncReadOnly(); throw error;}
      this.settlingRefs.clear();
      if (!this.active || this.versions.get(parent_id) !== version || !this.navigationValid(parent_id) || this.view && this.windows.size > 0 && (this.rawPending() || !this.handle?.canArrange())) {this.blockedRows.clear(); this.syncReadOnly(); return;}
      const retainedFields = new Map<string, OutlineBindingField>();
      for (const row of this.rows.values()) if (this.editableReady(row) && !this.blockedRows.has(row.row_id)) retainedFields.set(row.row_id, this.field(row.row_id));
      this.binding.update(retainedFields);
      for (const [ref, held] of retired) {held.release(); this.documents.delete(ref); this.historyLeases.get(ref)?.(); this.historyLeases.delete(ref);}
      released = retired.length > 0;
      const acquired: [string, Held][] = [];
      try {
        const editable = this.refs(next);
        for (const ref of editable) if (!this.documents.has(ref)) {
          if (this.slots(next) > MAX_REFS) {this.denied(parent_id, "this editing window is full; close a branch before loading more writing"); return;}
          const document = await this.runtime.openDocument(ref, ref === this.rootRef ? this.prelude : []);
          acquired.push([ref, {document, release: document.retain()}]);
        }
        if (!this.active || this.versions.get(parent_id) !== version || !this.navigationValid(parent_id) || this.view && this.windows.size > 0 && (this.rawPending() || !this.handle?.canArrange())) return;
        const actual = acquired.reduce((bytes, [, held]) => bytes + Y.encodeStateAsUpdate(held.document.doc).byteLength, charge());
        // charge() already includes encoded candidates. Replace that part with
        // actual opened state; existing fields may have grown while we waited.
        const estimated = newRefs.reduce((bytes, ref) => {const state = snapshot.states.resources.find(state => state.ref === ref); return bytes + (state?.kind === "note" ? decodeBytes(state.body_state).byteLength : state?.kind === "page" ? decodeBytes(state.title_state).byteLength : 0);}, 0);
        if (newRefs.length && (actual - estimated > MAX_BYTES || this.slots(next) > MAX_REFS)) {this.denied(parent_id, "this editing window is full; close a branch before loading more writing"); return;}
        for (const [ref, held] of acquired.splice(0)) this.documents.set(ref, held);
        this.configure(this.rootField);
        const initial = this.windows.size === 0;
        this.windows.clear(); for (const [id, part] of next) this.windows.set(id, part);
        const accepted = this.requests.get(parent_id); if (accepted?.navigation) this.requests.set(parent_id, {...accepted, navigation: undefined});
        this.blockedRows.clear(); this.error = null; this.changed(initial); this.pending.resume();
        if (this.proposals.get(parent_id) === window) this.proposals.delete(parent_id);
        this.attempted.delete(parent_id);
      } finally {for (const [, held] of acquired) held.release(); this.blockedRows.clear(); if (this.active) this.rebuild(); this.syncReadOnly();}
    }).catch(error => {failed = true; if (this.active) {this.error = error; this.notify();}}).finally(() => {
      this.scheduled.delete(parent_id);
      this.reservedWindows = null; this.reservedBytes = 0; this.settlingRefs.clear();
      const newer = this.proposals.get(parent_id);
      if (newer && newer !== window && this.active && !failed) this.accept(parent_id, newer);
      else if (released && !failed && this.active && [...this.refs(this.windows)].some(ref => !this.documents.has(ref))) {
        const current = this.requests.get(parent_id);
        if (newer === window && current === request && this.handle?.canArrange() && !this.rawPending()) this.accept(parent_id, window);
        else if (!newer && current === request?.navigation?.previous) {const retained = this.windows.get(parent_id); if (retained) this.accept(parent_id, retained);}
      }
    });
  }
  private reachable(candidate: ReadonlyMap<string, OutlineWindow>): Map<string, OutlineWindow> {
    const result = new Map<string, OutlineWindow>();
    const visit = (parent: string) => {
      const window = candidate.get(parent); if (!window || result.has(parent)) return;
      result.set(parent, window);
      for (const row of window.rows) {const id = this.id(parent, row.link!.link_id); if (this.opened.has(id)) visit(id); for (const [key, embed] of this.embedded) if (embed.owner === id) visit(key);}
      for (const row of this.pending.fields.values()) if (row.parent_id === parent && !row.hidden && this.opened.has(row.row_id)) visit(row.row_id);
    };
    visit(this.pending.root_id); for (const [key, embed] of this.embedded) if (embed.owner === this.pending.root_id) visit(key); return result;
  }
  private parent(id: string): string | null {return this.rows.get(id)?.parent_id ?? this.occurrences.get(id)?.parent_id ?? this.embedded.get(id)?.owner ?? null;}
  private syncReadOnly(): void {
    for (const element of this.view?.dom.querySelectorAll<HTMLElement>("[data-outline-field]") ?? []) {
      const row = this.rows.get(element.dataset.outlineField!);
      const unbound = row && row.kind !== "reference" && !row.tail && !this.pending.fields.get(row.row_id)?.raw && this.binding.document(row.row_id) !== this.documents.get(row.ref ?? "")?.document;
      if (this.blockedRows.has(element.dataset.outlineField!) || row && !this.editableReady(row) || unbound) element.contentEditable = "false";
      else if (element.getAttribute("contenteditable") === "false" && row?.kind !== "reference") element.removeAttribute("contenteditable");
    }
  }
  private editableReady(row: OutlineRow): boolean {return row.kind !== "reference" && (row.tail || this.pending.fields.get(row.row_id)?.raw === true || row.ref !== null && this.documents.has(row.ref));}
  private rebuild(semantic = false): void {
    if (this.view && this.windows.size > 0 && !semantic && (this.rawPending() || !this.handle?.canArrange())) {this.deferred = true; return;}
    this.deferred = false;
    for (const row of this.rows.values()) this.occurrences.set(row.row_id, row);
    const protectedRows = this.protectedRows(), previousRows = new Map(this.rows);
    for (const [id, field] of this.pending.fields) if (!field.raw && field.link) {
      const window = this.windows.get(field.parent_id!);
      const old = field.previousParent ? this.windows.get(field.previousParent) : null;
      const acknowledged = !!field.settledRevision && !!window && BigInt(window.data.store_revision) >= BigInt(field.settledRevision);
      const oldAcknowledged = !field.previousParent || !this.requests.has(field.previousParent) || !!old && !!field.settledRevision && BigInt(old.data.store_revision) >= BigInt(field.settledRevision);
      const present = window?.rows.some(row => row.link?.link_id === field.link!.link_id) === true;
      if (field.relocating ? acknowledged && oldAcknowledged : field.hidden ? acknowledged : present) this.pending.fields.delete(id);
    }
    this.rows.clear();
    const root = this.pending.root_id;
    if (this.rootField && (this.documents.has(this.rootRef) || this.pending.fields.get(root)?.raw)) this.rows.set(root, {row_id: root, ref: this.rootRef, link: null, parent_id: null, parent_ref: this.rootRef,
      depth: 0, branch: this.rootBranch, resource: this.windows.get(root)?.rootResource ?? null, kind: this.rootRef.startsWith("page:") ? "title" : "body", childrenAvailable: false, open: true, terminal: false, root: true, tail: false, origin: this.origin(root)});
    let tailSlots = Math.max(0, MAX_REFS - this.refs().size - this.pending.provisionalCount());
    const collect = (parent_id: string, ref: string, branch: OutlineBranch, depth: number) => {
      const window = this.windows.get(parent_id);
      const siblings: OutlineRow[] = (window?.rows ?? []).flatMap<OutlineRow>(item => {
        const link = item.link!, moving = [...this.pending.fields.values()].find(row => row.relocating && row.parent_id === parent_id && row.ref === item.resource.ref);
        let id = moving?.row_id ?? this.id(parent_id, link.link_id);
        const terminal = classifyOutlineOccurrence({branch, targetRef: item.resource.ref, edgeId: link.link_id}).kind === "reference";
        const withdrawal = [...this.pending.fields.values()].find(row => row.relocating && row.previousParent === parent_id && row.previousLink === link.link_id && row.parent_id !== parent_id);
        if (withdrawal && (!withdrawal.settledRevision || !window || BigInt(window.data.store_revision) < BigInt(withdrawal.settledRevision))) return [];
        const override = this.pending.fields.get(id);
        if (override && override.parent_id !== parent_id) {id = crypto.randomUUID(); this.identities.set(`${parent_id}/${link.link_id}`, {id, origin: this.history.typingOrigin()});}
        if (moving) this.identities.set(`${parent_id}/${link.link_id}`, {id, origin: moving.origin});
        return {row_id: id, ref: item.resource.ref, link, parent_id, parent_ref: ref, depth, branch, resource: item.resource,
          kind: terminal || item.resource.kind !== "note" && item.resource.kind !== "page" ? "reference" : item.resource.kind === "page" ? "title" : "body",
          childrenAvailable: window?.childAvailability.get(link.link_id) === true, open: this.opened.has(id), terminal, root: false, tail: false, origin: this.origin(id)};
      });
      for (const pending of this.pending.fields.values()) if (pending.parent_id === parent_id) {
        const at = siblings.findIndex(row => row.row_id === pending.row_id);
        if (pending.hidden) {if (at >= 0) siblings.splice(at, 1); continue;}
        if (at >= 0 && !pending.relocating) continue;
        const existing = at >= 0 ? siblings.splice(at, 1)[0] : null;
        const after = pending.after_id === null ? siblings.length - 1 : siblings.findIndex(row => row.row_id === pending.after_id);
        const before = pending.before_id ? siblings.findIndex(row => row.row_id === pending.before_id) : -1;
        siblings.splice(before >= 0 ? before : after >= 0 ? after + 1 : siblings.length, 0, {row_id: pending.row_id, ref: pending.ref, link: pending.link, parent_id, parent_ref: pending.parent_ref, depth, branch,
          resource: pending.resource ?? existing?.resource ?? null, kind: pending.kind, childrenAvailable: existing?.childrenAvailable ?? false, open: this.opened.has(pending.row_id), terminal: existing?.terminal ?? false, root: false, tail: false, origin: pending.origin});
      }
      if ([...this.pending.fields.values()].some(row => row.parent_id === parent_id && row.relocating)) {
        const rank = new Map(this.pending.order.map((id, index) => [id, index]));
        siblings.sort((a, b) => (rank.get(a.row_id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.row_id) ?? Number.MAX_SAFE_INTEGER));
      }
      if (window?.beforeEdge) this.rows.set(`before:${parent_id}`, {row_id: `before:${parent_id}`, ref: null, link: null, parent_id, parent_ref: ref, depth, branch,
        resource: null, kind: "reference", childrenAvailable: false, open: false, terminal: false, root: false, tail: false, gap: "before", origin: null});
      for (const row of siblings) {
        if (this.filter.trim() && !this.bodyMatches(row) && !protectedRows.has(row.row_id)) continue;
        this.rows.set(row.row_id, row);
        for (const [id, embedded] of this.embedded) if (embedded.owner === row.row_id) collect(id, embedded.ref, embedded.branch, depth + 1);
        if (row.open && !row.terminal) {
          const entered = row.ref ? enterOutlineOccurrence({branch, ref: row.ref, target: {kind: "occurrence", key: row.row_id}, edgeIds: row.link ? [row.link.link_id] : []}) : branch;
          if (!this.requests.has(row.row_id) && row.resource && row.link && row.ref) {
            this.requests.set(row.row_id, {parent_id: row.row_id, ref: row.ref, branch: entered, cursor: null, anchor: null,
              limit: Math.max(1, Math.min(48, MAX_REFS - this.refs().size - 3))});
            this.attempted.add(row.row_id); this.notify();
          }
          collect(row.row_id, row.ref ?? row.parent_ref, entered, depth + 1);
        }
      }
      if (window?.afterEdge) this.rows.set(`after:${parent_id}`, {row_id: `after:${parent_id}`, ref: null, link: null, parent_id, parent_ref: ref, depth, branch,
        resource: null, kind: "reference", childrenAvailable: false, open: false, terminal: false, root: false, tail: false, gap: "after", origin: null});
      else if (window && !this.filter.trim() && tailSlots > 0) {
        const id = this.tailId(parent_id);
        if (!this.pending.fields.has(id)) {tailSlots--; this.rows.set(id, {row_id: id, ref: null, link: null, parent_id, parent_ref: ref, depth, branch, resource: null,
          kind: "body", childrenAvailable: false, open: false, terminal: false, root: false, tail: true, origin: this.origin(id)});}
      }
      else if (window && !this.filter.trim()) this.rows.set(`tail:${parent_id}`, {row_id: `tail:${parent_id}`, ref: null, link: null, parent_id, parent_ref: ref, depth, branch,
        resource: null, kind: "reference", childrenAvailable: false, open: false, terminal: false, root: false, tail: false, gap: "tail", origin: null});
    };
    collect(root, this.rootRef, this.rootBranch, 0);
    for (const [id, embedded] of this.embedded) if (embedded.owner === root) collect(id, embedded.ref, embedded.branch, 1);
    if (!semantic && [...protectedRows].some(id => previousRows.has(id) && !this.rows.has(id))) {
      this.rows.clear(); for (const [id, row] of previousRows) this.rows.set(id, row);
      this.deferred = true; return;
    }
    this.pending.order = [...this.rows.keys(), ...this.pending.order.filter(id => !this.rows.has(id) && this.pending.fields.get(id)?.raw)];
    const fields = new Map<string, OutlineBindingField>();
    for (const row of this.rows.values()) if (this.editableReady(row) && !this.blockedRows.has(row.row_id)) fields.set(row.row_id, this.field(row.row_id));
    this.binding.update(fields);
    const keepRows = new Set([...this.rows.keys(), ...this.pending.fields.keys(), ...[...this.pending.fields.values()].flatMap(row => [row.after_id, row.before_id].filter((id): id is string => id !== null && id !== undefined)), ...this.history.retainedRows()]);
    for (const [key, row] of this.identities) if (!keepRows.has(row.id)) this.identities.delete(key);
    for (const row of this.rows.values()) this.occurrences.set(row.row_id, row);
    for (const id of [...keepRows]) {let parent = this.parent(id); while (parent) {keepRows.add(parent); parent = this.parent(parent);}}
    for (const id of this.occurrences.keys()) if (!keepRows.has(id)) this.occurrences.delete(id);
    for (const row of this.rows.values()) if (row.ref && this.documents.has(row.ref) && !this.historyLeases.has(row.ref))
      this.historyLeases.set(row.ref, this.history.editor(this.documents.get(row.ref)!.document).retain());
    this.project(semantic); this.syncMetadata(); this.tryFocus();
  }
  private bodyMatches(row: OutlineRow): boolean {return [row.resource?.title, row.resource?.body_text, row.resource?.selection?.quote_exact].some(text => text?.toLocaleLowerCase().includes(this.filter.trim().toLocaleLowerCase()));}
  private doc(): PMNode {
    return outlineEditorSchema.topNodeType.create(null, [...this.rows.values()].map(row => {
      const attrs = {row_id: row.row_id, depth: row.depth};
      if (row.kind === "reference") return outlineEditorSchema.nodes.reference_row!.create(attrs);
      const preserve = this.blockedRows.has(row.row_id) || !this.pending.fields.get(row.row_id)?.raw && !row.tail && (!this.editableReady(row) || this.binding.document(row.row_id) === null);
      const displayed = preserve && this.view ? fieldById(this.view.state.doc, row.row_id) : null;
      const body = displayed ? displayed.kind === "body" ? canonicalBody(displayed) : bodyText(plainTitle(displayed)) : this.pending.fields.get(row.row_id)?.raw ? this.body(row.row_id) : this.binding.body(row.row_id);
      return row.kind === "title" ? outlineEditorSchema.nodes.title_row!.create(attrs, clipboardPlainText(noteBodySchema.nodeFromJSON(body.body_pm_json).content) ? outlineEditorSchema.text(clipboardPlainText(noteBodySchema.nodeFromJSON(body.body_pm_json).content)) : null)
        : outlineEditorSchema.nodes.note_row!.create(attrs, outlineEditorSchema.nodeFromJSON(body.body_pm_json));
    }));
  }
  private project(semantic = false): void {
    if (!this.view || !semantic && !this.handle?.canArrange()) return;
    const next = this.doc();
    const start = this.view.state.doc.content.findDiffStart(next.content);
    if (start === null) return;
    const end = this.view.state.doc.content.findDiffEnd(next.content)!, overlap = Math.max(0, start - Math.min(end.a, end.b));
    const active = this.selectionRow, selection = this.selection;
    const tr = this.view.state.tr.replaceWith(start, end.a + overlap, next.content.cut(start, end.b + overlap)).setMeta(outlineTransactionSource, semantic ? "semantic" : "projection");
    const field = active ? fieldById(tr.doc, active) : null;
    if (active && this.selected.size) {
      tr.doc.forEach((node, at) => {if (node.attrs.row_id === active) tr.setSelection(NodeSelection.create(tr.doc, at));});
    } else if (field) tr.setSelection(TextSelection.create(tr.doc, field.from + Math.min(field.to - field.from, selection.anchor - 1), field.from + Math.min(field.to - field.from, selection.head - 1)));
    this.view.dispatch(tr);
  }
  private raw(row: OutlineRow): void {
    if (this.pending.fields.get(row.row_id)?.raw) return;
    const document = row.ref ? this.documents.get(row.ref)?.document : null, state = this.binding.bodyState(row.row_id), proof = this.binding.capture(row.row_id);
    if (!document || state === null || proof === null) throw new Error("the displayed writing is not ready for this change");
    this.pending.freeze({row_id: row.row_id, parent_id: row.parent_id, parent_ref: row.parent_ref, after_id: null, ref: row.ref, link: row.link, kind: row.kind === "title" ? "title" : "body", body: this.binding.body(row.row_id), raw: true, hidden: false, origin: row.origin}, document, state, proof);
  }
  onEdit = (row_id: string, edit: NoteEdit): void => {
    const row = this.rows.get(row_id); if (!row) throw new Error("edited occurrence is not owned by this outline");
    if (row.root && row.kind === "title") this.titleEdited = true;
    if (row.tail && !this.pending.fields.has(row_id)) {
      const window = this.windows.get(row.parent_id!)!;
      this.pending.create({row_id, parent_id: row.parent_id, parent_ref: row.parent_ref, after_id: window.tailEdge ? this.id(row.parent_id!, window.tailEdge.link.link_id) : null,
        ref: null, link: null, kind: "body", body: edit.after, hidden: false, raw: true, origin: row.origin}, window.tailEdge?.link.link_id ?? null, this.prelude);
      this.tailIds.delete(row.parent_id!);
      return;
    }
    if (this.pending.fields.get(row_id)?.raw) this.pending.edit(row_id, edit);
    else {
      const document = row.ref ? this.documents.get(row.ref)?.document : null;
      if (!document) throw new Error("edited note is not retained");
      this.history.editor(document, row.origin).record(edit, undefined, {key: row_id, ref: document.ref, selection: edit.selectionAfter,
        ...(row.link && row.parent_id ? {occurrence: {parent_ref: row.parent_ref, link_id: row.link.link_id, parent_id: row.parent_id}} : {})});
    }
  };
  keys = (row_id: string): StructuralKeys | null => {
    const row = this.rows.get(row_id); if (!row || row.gap || this.filter.trim() || this.blockedRows.has(row_id)) return null;
    const arrangement: StructuralKeys = {indent: at => this.arrangePrepared(row_id, "indent", at), outdent: at => this.arrangePrepared(row_id, "outdent", at),
      move: (direction, at) => this.arrangePrepared(row_id, direction === "up" ? "move_up" : "move_down", at), selectBlock: () => this.select(row_id)};
    if (row.kind === "reference") return arrangement;
    return {...arrangement, split: (left, right, displayed) => {
      if (!this.admitNew()) return;
      if (row.tail && !this.pending.fields.has(row_id)) return;
      this.raw(row);
      const currentSize = docFromBody(this.binding.body(row_id)).firstChild!.content.size;
      const from = docFromBody(left).firstChild!.content.size, to = currentSize - docFromBody(right).firstChild!.content.size;
      const successor = this.pending.split(row_id, left, right, displayed?.from ?? from, displayed?.to ?? to,
        row.root ? {parent_id: this.pending.root_id, parent_ref: this.rootRef, after_id: this.windows.get(this.pending.root_id)?.tailEdge ? this.id(this.pending.root_id, this.windows.get(this.pending.root_id)!.tailEdge!.link.link_id) : null} : undefined);
      const window = this.windows.get(this.pending.root_id);
      if (row.root && window?.afterEdge && window.tailEdge) this.request({...this.requests.get(this.pending.root_id)!, cursor: null, anchor: window.tailEdge.link.link_id});
      this.changed(true); void this.focus(successor, {anchor: 1, head: 1});
    }, enter: () => {if (row.root && row.kind === "title") this.focusFirst(); else void this.appendAfter(row);}, emptyEnter: () => {
      if (row.parent_id === this.pending.root_id || row.root) return;
      this.arrangePrepared(row_id, "outdent", {anchor: 1, head: 1});
    },
      emptyDelete: direction => {this.remove([row_id], direction);}, join: direction => {this.join(row_id, direction);}};
  };
  private async appendAfter(row: OutlineRow): Promise<void> {
    if (!this.admitNew()) return;
    const id = crypto.randomUUID();
    this.pending.create({row_id: id, parent_id: row.root ? this.pending.root_id : row.parent_id, parent_ref: row.root ? this.rootRef : row.parent_ref,
      after_id: row.root ? null : row.row_id, ref: null, link: null, kind: "body", body: emptyBody(), hidden: false, raw: true, origin: this.origin(id)}, row.root ? this.windows.get(this.pending.root_id)?.tailEdge?.link.link_id ?? null : row.link?.link_id ?? null, this.prelude);
    this.changed(true); await this.focus(id, {anchor: 1, head: 1});
  }
  private peer(row: OutlineRow, direction: "before" | "after"): OutlineRow | OutlineEdge | null {
    const siblings = [...this.rows.values()].filter(item => item.parent_id === row.parent_id && !item.gap && !item.tail && !item.root), at = siblings.findIndex(item => item.row_id === row.row_id);
    return direction === "before" ? siblings[at - 1] ?? this.windows.get(row.parent_id!)?.beforeEdge ?? null : siblings[at + 1] ?? this.windows.get(row.parent_id!)?.afterEdge ?? null;
  }
  private visiblePeer(row: OutlineRow, direction: "before" | "after"): OutlineRow | null {
    const peer = this.peer(row, direction); if (!peer) return null;
    if ("row_id" in peer) return peer;
    if (peer.resource.kind !== "note" || classifyOutlineOccurrence({branch: row.branch, targetRef: peer.resource.ref, edgeId: peer.link.link_id}).kind !== "resource") return null;
    const id = this.id(row.parent_id!, peer.link.link_id);
    this.pending.fields.set(id, {row_id: id, parent_id: row.parent_id, parent_ref: row.parent_ref, after_id: direction === "after" ? row.row_id : null,
      ...(direction === "before" ? {before_id: row.row_id} : {}), ref: peer.resource.ref, link: peer.link, kind: "body", body: emptyBody(), hidden: false, raw: false, origin: this.origin(id)});
    this.rebuild(true); return this.rows.get(id) ?? null;
  }
  private join(row_id: string, direction: "backward" | "forward"): void {
    const row = this.rows.get(row_id); if (!row || row.kind !== "body") return;
    const peer = this.visiblePeer(row, direction === "backward" ? "before" : "after");
    if (!peer || peer.kind !== "body" || peer.terminal || peer.ref !== null && peer.ref === row.ref) return;
    const destination = direction === "backward" ? peer : row, source = direction === "backward" ? row : peer;
    const left = this.binding.body(destination.row_id), right = this.binding.body(source.row_id), a = docFromBody(left).firstChild!, b = docFromBody(right).firstChild!;
    this.raw(destination); this.raw(source);
    this.pending.join(destination.row_id, source.row_id, parseBody(a.copy(a.content.append(b.content)).toJSON()));
    this.changed(true); void this.focus(destination.row_id, {anchor: a.content.size + 1, head: a.content.size + 1});
  }
  select(row_id: string, extend = false): void {
    const order = [...this.rows.keys()].filter(id => !this.rows.get(id)!.gap), anchor = [...this.selected][0] ?? row_id;
    if (!extend) this.selected.clear();
    const from = order.indexOf(anchor), to = order.indexOf(row_id);
    for (const id of extend ? order.slice(Math.min(from, to), Math.max(from, to) + 1) : [row_id]) this.selected.add(id);
    this.selectionRow = row_id; this.focused = true;
    if (this.view) {let at = 0; this.view.state.doc.forEach((node, offset) => {if (node.attrs.row_id === row_id) at = offset;}); this.view.dispatch(this.view.state.tr.setSelection(NodeSelection.create(this.view.state.doc, at))); this.view.focus();}
    this.syncMetadata(); this.notify();
  }
  remove(ids: readonly string[], direction?: "backward" | "forward"): void {
    const candidates = ids.flatMap(id => {const row = this.rows.get(id); return row && !row.root && !row.tail && (row.link || this.pending.fields.get(id)?.raw) ? [row] : [];});
    const removing = new Set(candidates.map(row => row.row_id));
    for (const id of new Set([...this.rows.keys(), ...this.pending.fields.keys()])) {
      const field = this.pending.fields.get(id);
      if (removing.has(id) || field?.hidden || !(field?.raw || field?.relocating || this.selected.has(id) || this.view?.hasFocus() && this.selectionRow === id)) continue;
      let parent = field ? field.parent_id : this.parent(id);
      while (parent) {
        if (removing.has(parent)) {this.error = new Error("finish the writing in this branch before unlinking it"); this.notify(); return;}
        parent = this.parent(parent);
      }
    }
    const bookmark = this.capture();
    if (candidates.some(row => row.row_id === this.selectionRow)) {this.selected.clear(); this.selectionRow = null;}
    if (direction || candidates.some(row => this.pending.fields.get(row.row_id)?.raw)) {
      const row = candidates[0]; if (!row) return;
      const previous = this.visiblePeer(row, "before"), following = this.visiblePeer(row, "after");
      const next = direction === "backward" ? previous ?? following : following ?? previous;
      for (const candidate of candidates) {if (!this.pending.fields.get(candidate.row_id)?.raw) this.raw(candidate); this.pending.unlink(candidate.row_id);}
      this.changed(true);
      if (next) void this.focus(next.row_id, direction === "forward" && next === following ? {anchor: 1, head: 1} : "end");
      return;
    }
    const rows = candidates.filter(row => row.link); if (!rows.length) return;
    const next = this.peer(rows[0]!, direction === "backward" ? "before" : "after"), lease = this.lease();
    void this.history.withFocus(bookmark, () => this.history.unlinkMany(rows.map(row => row.link!)), () => null).then(() => {
      if (next && "row_id" in next && lease()) void this.focus(next.row_id, direction === "forward" ? {anchor: 1, head: 1} : "end");
    }, error => {this.error = error; this.notify();});
  }
  arrange(row_id: string, command: "indent" | "outdent" | "move_up" | "move_down"): void {
    if (!this.handle?.settleNativeInput()) return;
    this.arrangePrepared(row_id, command, this.selected.size ? null : this.selection);
  }
  private arrangementPlan(row_id: string, command: Arrangement): ArrangementPlan | null {
    const row = this.rows.get(row_id);
    if (!row || row.root || row.tail || row.gap || this.filter.trim() || this.selected.size > 1 || this.blockedRows.has(row_id) ||
      row.kind !== "reference" && !this.editableReady(row) || !row.link && !this.pending.fields.has(row_id)) return null;
    if (command === "move_up" || command === "move_down") {
      const peer = this.peer(row, command === "move_up" ? "before" : "after");
      return peer && (peer.link || "row_id" in peer && this.pending.fields.has(peer.row_id)) ? {kind: "move", row, peer, direction: command === "move_up" ? "up" : "down"} : null;
    }
    if (command === "outdent") {
      const parent = row.parent_id ? this.rows.get(row.parent_id) : null;
      return parent?.parent_id ? {kind: "outdent", row, parent} : null;
    }
    const peer = this.peer(row, "before");
    if (!peer) return null;
    if ("row_id" in peer) return peer.kind === "body" && !peer.terminal ? {kind: "indent", row, peer} : null;
    return peer.resource.kind === "note" && classifyOutlineOccurrence({branch: row.branch, targetRef: peer.resource.ref, edgeId: peer.link.link_id}).kind === "resource" ? {kind: "indent", row, peer} : null;
  }
  private arrangePrepared(row_id: string, command: "indent" | "outdent" | "move_up" | "move_down", selection: FocusSelection | null): void {
    const plan = this.arrangementPlan(row_id, command); if (!plan) return;
    const {row} = plan;
    const retain = () => {
      if (row.kind !== "reference") this.raw(row);
      else if (!this.pending.fields.has(row_id)) this.pending.fields.set(row_id, {row_id, parent_id: row.parent_id, parent_ref: row.parent_ref, after_id: null,
        ref: row.ref, link: row.link, kind: "reference", resource: row.resource, body: emptyBody(), hidden: false, raw: false, origin: row.origin});
    };
    if (plan.kind === "move") {
      const other = plan.peer;
      const id = "row_id" in other ? other.row_id : this.id(row.parent_id!, other.link.link_id);
      if (!("row_id" in other)) {
        const terminal = classifyOutlineOccurrence({branch: row.branch, targetRef: other.resource.ref, edgeId: other.link.link_id}).kind !== "resource";
        this.pending.fields.set(id, {row_id: id, parent_id: row.parent_id, parent_ref: row.parent_ref, after_id: null,
          ref: other.resource.ref, link: other.link, kind: terminal || other.resource.kind !== "note" && other.resource.kind !== "page" ? "reference" : other.resource.kind === "page" ? "title" : "body",
          resource: other.resource, body: emptyBody(), hidden: false, raw: false, origin: this.origin(id)});
      }
      retain(); this.pending.move(row_id, {row_id: id, link: other.link}, plan.direction, selection); this.changed(true); return;
    }
    const parent = plan.kind === "outdent" ? plan.parent : "row_id" in plan.peer ? plan.peer : this.visiblePeer(row, "before");
    if (!parent) return;
    const destination = plan.kind === "indent" ? parent.ref ?? parent.parent_ref : parent.parent_ref, parent_id = plan.kind === "indent" ? parent.row_id : parent.parent_id!;
    retain();
    if (plan.kind === "indent") this.opened.add(parent_id);
    this.pending.relink(row_id, parent_id, destination, plan.kind === "indent" ? null : parent.row_id, plan.kind === "indent" ? null : parent.link?.link_id ?? null, selection);
    this.changed(true);
  }
  toggle(row_id: string, force?: boolean): void {
    const row = this.rows.get(row_id); if (!row?.ref || row.terminal) return;
    const open = force ?? !this.opened.has(row_id);
    if (!open) {
      if (!this.handle?.canArrange()) return;
      const lease = this.lease();
      const descendants = new Set<string>();
      for (const candidate of this.rows.values()) {let parent = candidate.parent_id; while (parent) {if (parent === row_id) {descendants.add(candidate.row_id); break;} parent = this.parent(parent);}}
      const protectedWriting = () => [...descendants].some(id => this.pending.fields.get(id)?.raw || this.pending.fields.get(id)?.relocating || this.selected.has(id) || this.view?.hasFocus() && this.selectionRow === id);
      if (protectedWriting()) {this.error = new Error("finish the writing in this branch before closing it"); this.notify(); return;}
      this.admission = this.admission.then(async () => {
        if (!this.active || !lease() || protectedWriting() || !this.handle?.canArrange()) return;
        for (const id of descendants) this.blockedRows.add(id);
        this.syncReadOnly(); this.notify();
        try {
          const refs = new Set([...descendants].flatMap(id => {const ref = this.rows.get(id)?.ref; return ref ? [ref] : [];}));
          await Promise.all([...refs].map(ref => this.documents.get(ref)?.document.capture()));
          if (!this.active || !lease() || protectedWriting() || !this.handle?.canArrange()) return;
          this.opened.delete(row_id);
          for (const id of [row_id, ...descendants]) {this.requests.delete(id); this.windows.delete(id);}
          for (const [id, embed] of this.embedded) if (descendants.has(embed.owner)) {this.requests.delete(id); this.windows.delete(id);}
          this.changed();
          const keep = this.refs(this.windows);
          for (const [ref, held] of this.documents) if (!keep.has(ref)) {held.release(); this.documents.delete(ref); this.historyLeases.get(ref)?.(); this.historyLeases.delete(ref);}
          this.changed();
        } finally {for (const id of descendants) this.blockedRows.delete(id); this.syncReadOnly(); this.notify();}
      }).catch(error => {if (this.active) {this.error = error; this.notify();}});
      return;
    }
    const capacity = MAX_REFS - this.refs().size - 3;
    if (capacity < 1) {this.error = new Error("this editing window is full; close a branch first"); this.notify(); return;}
    this.opened.add(row_id);
    this.attempted.add(row_id);
    const branch = enterOutlineOccurrence({branch: row.branch, ref: row.ref, target: {kind: "occurrence", key: row_id}, edgeIds: row.link ? [row.link.link_id] : []});
    this.requests.set(row_id, {parent_id: row_id, ref: row.ref, branch, cursor: null, anchor: null, limit: Math.min(48, capacity)});
    this.changed();
  }
  load(parent_id: string, direction: "before" | "after"): void {
    const request = this.requests.get(parent_id), window = this.windows.get(parent_id); if (!request || !window || !this.handle?.canArrange()) return;
    const anchor = direction === "before" ? window.beforeEdge?.link.link_id ?? null : null;
    this.request({...request, cursor: direction === "after" ? window.data.next_cursor : null, anchor}, true); this.notify();
  }
  private request(request: BranchRequest, navigation: boolean | (() => boolean) = false): void {
    if (navigation) {const previous = this.requests.get(request.parent_id)!; request = {...request, navigation: {lease: typeof navigation === "function" ? navigation : this.lease(), previous: previous.navigation?.previous ?? previous}};}
    this.requests.set(request.parent_id, request); this.attempted.add(request.parent_id); this.versions.set(request.parent_id, (this.versions.get(request.parent_id) ?? 0) + 1); this.proposals.delete(request.parent_id);
  }
  get loading(): boolean {return this.blockedRows.size > 0 || this.scheduled.size > 0 && [...this.rows.values()].some(row => row.kind !== "reference" && !this.editableReady(row));}
  get canRetry(): boolean {return this.proposals.size > 0;}
  retry(): void {
    this.error = null;
    for (const [parent, window] of this.proposals) {
      const request = this.requests.get(parent);
      if (request?.navigation) this.requests.set(parent, {...request, navigation: {...request.navigation, lease: this.lease()}});
      this.accept(parent, window);
    }
    this.notify();
  }
  capture(): OutlineBookmark | null {const row = this.selectionRow ? this.rows.get(this.selectionRow) : null; return row?.ref ? {key: row.row_id, ref: row.ref, selection: this.selected.size ? null : this.selection,
    ...(row.link && row.parent_id ? {occurrence: {parent_ref: row.parent_ref, link_id: row.link.link_id, parent_id: row.parent_id}} : {}),
    ...(!this.selected.size && this.handle ? {resolve: this.handle.captureSelection()} : {})} : null;}
  focus(row_id: string, selection: FocusSelection | null | ((document: WritingDocument) => FocusSelection) = "end", lease = this.lease()): Promise<void> {
    this.waiting?.resolve(); return new Promise(resolve => {this.waiting = {row_id, selection, lease, resolve}; this.tryFocus();});
  }
  private tryFocus(): void {
    const request = this.waiting; if (!request || !this.view) return;
    if (!request.lease()) {this.waiting = null; request.resolve(); return;}
    const row = this.rows.get(request.row_id);
    if (typeof request.selection === "function") {
      const document = row?.ref ? this.documents.get(row.ref)?.document : null;
      if (!document) return;
      request.selection = request.selection(document);
    }
    if (row && row.kind !== "reference" && (!this.editableReady(row) || !row.tail && !this.pending.fields.get(row.row_id)?.raw && this.binding.document(row.row_id) !== this.documents.get(row.ref ?? "")?.document)) return;
    if (request.selection === null || row?.kind === "reference") {
      let at: number | null = null;
      this.view.state.doc.forEach((node, offset) => {if (node.attrs.row_id === request.row_id) at = offset;});
      if (at === null) return;
      this.waiting = null; this.selectionRow = request.row_id; this.selected.clear(); this.selected.add(request.row_id);
      this.view.dispatch(this.view.state.tr.setSelection(NodeSelection.create(this.view.state.doc, at))); this.view.focus(); request.resolve(); this.notify(); return;
    }
    if (!row || !this.editableReady(row)) return;
    const field = fieldById(this.view.state.doc, request.row_id);
    if (!field) {
      const parent = [...this.tailIds].find(([, id]) => id === request.row_id)?.[0], window = parent ? this.windows.get(parent) : null;
      const branch = parent ? this.requests.get(parent) : null;
      if (branch && window?.afterEdge && window.tailEdge && branch.anchor !== window.tailEdge.link.link_id) {this.request({...branch, cursor: null, anchor: window.tailEdge.link.link_id}, request.lease); this.notify();}
      return;
    }
    const at = request.selection === "end" ? {anchor: field.to, head: field.to} : {anchor: field.from + request.selection.anchor - 1, head: field.from + request.selection.head - 1};
    this.waiting = null; this.selectionRow = request.row_id; this.selection = request.selection === "end" ? {anchor: field.to - field.from + 1, head: field.to - field.from + 1} : request.selection;
    this.view.dispatch(this.view.state.tr.setSelection(TextSelection.create(this.view.state.doc, Math.min(field.to, at.anchor), Math.min(field.to, at.head)))); this.view.focus(); request.resolve();
  }
  rootText(): string {return clipboardPlainText(noteBodySchema.nodeFromJSON(this.body(this.pending.root_id).body_pm_json).content);}
  async focusRoot(resolve?: (document: WritingDocument) => FocusSelection): Promise<void> {await this.focus(this.pending.root_id, resolve ?? "end");}
  async append(parent_id = this.pending.root_id): Promise<void> {
    const window = this.windows.get(parent_id), request = this.requests.get(parent_id), lease = this.lease();
    if (!request) return;
    if (!window) {await this.focus(this.tailId(parent_id), {anchor: 1, head: 1}, lease); return;}
    if (window.afterEdge && window.tailEdge) {this.request({...request, cursor: null, anchor: window.tailEdge.link.link_id}, true); this.notify();}
    if (!this.rows.has(this.tailId(parent_id)) && !window.afterEdge) {if (!this.admitNew()) return; this.changed(true);}
    await this.focus(this.tailId(parent_id), {anchor: 1, head: 1}, lease);
  }
  async focusNote(ref: string, signal?: AbortSignal): Promise<boolean> {
    const lease = this.lease(); signal?.throwIfAborted();
    const row = [...this.rows.values()].find(row => row.ref === ref);
    if (row) {await this.focus(row.row_id, "end", () => lease() && !signal?.aborted); return true;}
    const store = await this.runtime.store, binding = await store.query({kind: "binding", key: {kind: "link", endpoint_a: [this.rootRef, ref].sort()[0]!, endpoint_b: [this.rootRef, ref].sort()[1]!}});
    if (!lease() || signal?.aborted || binding.binding_id === null) return false;
    const states = await store.readStates({refs: [], link_ids: [binding.binding_id], anchor_ids: [], source_refs: []});
    if (!lease() || signal?.aborted || !states.links.some(link => link.link_id === binding.binding_id && isVisible(link.add_vv, link.remove_vv))) return false;
    const request = this.requests.get(this.pending.root_id)!; this.request({...request, anchor: binding.binding_id, cursor: null}, () => lease() && !signal?.aborted); this.notify();
    await this.focus(this.id(this.pending.root_id, binding.binding_id), "end", () => lease() && !signal?.aborted); return true;
  }
  focusFirst(): void {const row = [...this.rows.values()].find(row => !row.root && !row.gap); if (row) void this.focus(row.row_id, row.kind === "reference" ? null : {anchor: 1, head: 1});}
  attachEmbedded(prefix: string, ref: string, branch: OutlineBranch, owner: string | null): () => void {
    if (!owner) throw new Error("embedded outline must name its containing occurrence");
    const id = `embed:${prefix}`;
    this.embedded.set(id, {owner, ref, branch});
    this.requests.set(id, {parent_id: id, ref, branch, cursor: null, anchor: null, limit: Math.max(1, Math.min(48, MAX_REFS - this.refs().size - 3))});
    this.notify();
    return () => {
      this.embedded.delete(id); this.requests.delete(id); this.windows.delete(id); this.changed();
      const retired = [...this.documents].filter(([ref]) => !this.refs(this.windows).has(ref));
      for (const [ref] of retired) this.settlingRefs.add(ref);
      this.admission = this.admission.then(async () => {
        try {
          await Promise.all(retired.map(([, held]) => held.document.capture()));
          const keep = this.refs(this.windows);
          for (const [ref, held] of retired) if (!keep.has(ref) && this.documents.get(ref) === held) {held.release(); this.documents.delete(ref); this.historyLeases.get(ref)?.(); this.historyLeases.delete(ref);}
          if (this.active) this.changed();
        } finally {for (const [ref] of retired) this.settlingRefs.delete(ref);}
      }).catch(error => {if (this.active) {this.error = error; this.notify();}});
    };
  }
  private async beforeCollapseEmbedded(scope: string): Promise<boolean> {
    const id = `embed:${scope}`, branch = this.embedded.get(id), lease = this.lease();
    if (!branch) return true;
    const descendants = new Set<string>();
    for (const row of [...this.rows.values(), ...this.pending.fields.values()]) {
      let parent = row.parent_id;
      while (parent) {if (parent === id) {descendants.add(row.row_id); break;} parent = this.parent(parent);}
    }
    const protectedWriting = () => [...descendants].some(row => this.pending.fields.get(row)?.raw || this.pending.fields.get(row)?.relocating || this.selected.has(row) || this.view?.hasFocus() && this.selectionRow === row);
    if (protectedWriting() || !this.handle?.canArrange()) {this.error = new Error("finish the writing in this preview before closing it"); this.notify(); return false;}
    try {
      const refs = new Set([...descendants].flatMap(row => {const ref = this.rows.get(row)?.ref; return ref ? [ref] : [];}));
      await Promise.all([...refs].map(ref => this.documents.get(ref)?.document.capture()));
      return this.active && lease() && this.embedded.get(id) === branch && !protectedWriting() && !!this.handle?.canArrange();
    } catch (error) {if (this.active) {this.error = error; this.notify();} return false;}
  }
  commandState(command: OutlineCommand) {
    if (command === "undo" || command === "redo") {
      const local = this.handle?.localHistory(command); if (local) return {enabled: local.enabled, reason: null};
      return {enabled: !this.pending.risk().changed && !this.pending.risk().unconfirmed && !!this.handle?.canArrange() && (command === "undo" ? this.history.canUndo() : this.history.canRedo()), reason: null};
    }
    const row = this.selectionRow ? this.rows.get(this.selectionRow) : null;
    if (!row || !this.handle?.canArrange()) return {enabled: false, reason: "select one item to arrange"};
    const enabled = this.arrangementPlan(row.row_id, command) !== null;
    return {enabled, reason: enabled ? null : "no item available"};
  }
  publication() {return this.focused || this.selected.size ? {session: `outline:${this.pending.root_id}`, commandState: (command: OutlineCommand) => this.commandState(command), executeCommand: (command: OutlineCommand) => {
    if (!this.commandState(command).enabled) return;
    if (command === "undo" || command === "redo") {const local = this.handle?.localHistory(command); if (local) local.execute(); else if (command === "undo") this.history.undo(); else this.history.redo();}
    else if (this.selectionRow) this.arrange(this.selectionRow, command); this.notify();
  }} : null;}
  chrome(): ReadonlyMap<string, OutlineRowChrome> {
    return new Map([...this.rows.values()].map(row => [row.row_id, {row_id: row.row_id, ref: row.ref, kind: row.kind === "body" ? "note" : row.kind,
      depth: row.depth, parent_id: row.parent_id, label: row.gap ? row.gap === "before" ? "show earlier items" : row.gap === "after" ? "show more items" : "write at end" : this.label(row),
      href: row.resource ? localResourceHref(row.resource) : row.ref ? `/${row.kind === "title" ? "pages" : "notes"}/${row.ref.split(":")[1]}` : null,
      parentLabel: row.parent_id ? this.rows.has(row.parent_id) ? this.label(this.rows.get(row.parent_id)!) : this.windows.get(row.parent_id)?.rootResource ? localResourceLabel(this.windows.get(row.parent_id)!.rootResource!) : "this outline" : "this outline",
      childrenAvailable: row.childrenAvailable, open: row.open, terminal: row.terminal, root: row.root || row.tail || !!row.gap, selected: this.selected.has(row.row_id),
      toggle: () => {this.toggle(row.row_id); this.focused = false; this.notify();}, select: () => this.select(row.row_id), unlink: () => this.remove([row.row_id]), reveal: () => {
        if (row.ref) {const ancestor = row.branch.ancestors.get(row.ref); if (ancestor?.kind === "root" && this.rootField) void this.focusRoot();
          else if (ancestor?.kind === "occurrence" && this.rows.has(ancestor.key)) void this.focus(ancestor.key); else if (ancestor) this.revealExternal?.(ancestor);}
      }}]));
  }
  private label(row: OutlineRow): string {
    if (row.kind !== "reference" && (this.documents.has(row.ref ?? "") || this.pending.fields.get(row.row_id)?.raw)) {
      const text = clipboardPlainText(noteBodySchema.nodeFromJSON(this.body(row.row_id).body_pm_json).content).split("\n")[0]?.trim();
      if (text) return text;
      return row.kind === "title" ? row.resource?.local_date ?? "untitled page" : "empty note";
    }
    return row.resource ? localResourceLabel(row.resource) : row.root ? this.rootField?.label ?? "outline" : "empty note";
  }
  private nodeView = (node: PMNode): NodeView => {
    const id = String(node.attrs.row_id), dom = document.createElement("div"), head = document.createElement("div"), leading = document.createElement("div"), content = document.createElement("div"), trailing = document.createElement("div");
    dom.className = rowStyles.row; head.className = rowStyles.head; leading.className = rowStyles.leading; trailing.className = rowStyles.trailing; content.className = rowStyles.content;
    leading.contentEditable = "false"; trailing.contentEditable = "false"; content.dataset.outlineField = id;
    head.append(leading, content, trailing); dom.append(head);
    const sync = () => {
      const row = this.rows.get(id); if (!row) return;
      dom.dataset.outlineRow = id; dom.dataset.outlineOccurrence = id; dom.dataset.outlineKind = row.kind === "body" ? "note" : row.kind;
      dom.dataset.depth = String(row.depth); dom.style.setProperty("--outline-depth", String(row.depth));
      dom.dataset.root = String(row.root);
      leading.hidden = row.root || row.tail || !!row.gap;
      trailing.hidden = row.root || !(row.terminal || row.childrenAvailable);
      if (row.ref) dom.dataset.resourceRef = row.ref; else delete dom.dataset.resourceRef;
      if (row.parent_id) dom.dataset.parentRow = row.parent_id;
      if (row.root) dom.dataset.outlineRoot = "true";
      if (row.tail) {dom.dataset.outlineInput = "true"; dom.dataset.outlineTail = "true";}
      else {delete dom.dataset.outlineInput; delete dom.dataset.outlineTail;}
      if (this.pending.fields.get(id)?.raw) dom.dataset.outlinePending = "true"; else delete dom.dataset.outlinePending;
      if (this.selected.has(id)) dom.dataset.selected = "true"; else delete dom.dataset.selected;
      if (row.gap && content.dataset.gap !== row.gap) {
        content.dataset.gap = row.gap;
        content.contentEditable = "false"; const button = document.createElement("button"); button.type = "button";
        button.textContent = row.gap === "before" ? "show earlier items" : row.gap === "after" ? "show more items" : "write at end";
        if (row.gap === "tail") button.onclick = () => {void this.append(row.parent_id!);};
        else {const direction = row.gap; button.onclick = () => this.load(row.parent_id!, direction);}
        if (row.gap === "after") {const append = document.createElement("button"); append.type = "button"; append.textContent = "write at end"; append.onclick = () => {void this.append(row.parent_id!);}; content.replaceChildren(button, append);}
        else content.replaceChildren(button);
      }
      else if (row.kind === "reference" && !row.gap) {content.contentEditable = "false"; const text = row.resource ? localResourceLabel(row.resource) : "resource"; if (content.textContent !== text) content.textContent = text;}
    };
    const mount = {row_id: id, leading, trailing, sync};
    sync(); this.mounts.set(id, mount); this.notify();
    return {dom, ...(node.type.name !== "reference_row" ? {contentDOM: content} : {}), update: next => {if (next.type !== node.type || next.attrs.row_id !== id) return false; node = next; sync(); return true;},
      stopEvent: event => event.target instanceof Node && (leading.contains(event.target) || trailing.contains(event.target) || this.rows.get(id)?.kind === "reference"),
      ignoreMutation: mutation => mutation.type !== "selection" && (!content.contains(mutation.target) || mutation.type === "attributes" && mutation.target === content || this.rows.get(id)?.kind === "reference"),
      destroy: () => {if (this.mounts.get(id) === mount) {this.mounts.delete(id); this.notify();}}};
  };
  private syncMetadata(): void {for (const mount of this.mounts.values()) mount.sync(); this.syncReadOnly();}
  readonly projection: NoteEditorProjection = {
    schema: outlineEditorSchema, doc: () => this.doc(), binding: this.binding,
    nodeViews: {note_row: this.nodeView, title_row: this.nodeView, reference_row: this.nodeView},
    plugins: [new Plugin({props: {handleDOMEvents: {
      copy: (_view, event) => this.copy(event, false), cut: (_view, event) => this.copy(event, true),
      paste: (_view, event) => {
        if (!this.selected.size) return false; event.preventDefault();
        const row = this.selectionRow ? this.rows.get(this.selectionRow) : null; if (!row) return true;
        try {const items = readOutlineClipboard(event.clipboardData!); void (async () => {
          const current = this.pending.fields.get(row.row_id)?.raw ? await this.pending.ready(row.row_id) : row;
          await this.history.paste(row.parent_ref, current.link?.link_id ?? null, items, this.prelude);
        })().catch(error => {this.error = error; this.notify();});} catch (error) {this.error = error; this.notify();} return true;
      },
      keydown: (_view, event) => {
        if (!this.selected.size || event.isComposing || event.altKey || event.metaKey || event.ctrlKey) return false;
        if (event.key === "Delete" || event.key === "Backspace") {event.preventDefault(); this.remove([...this.selected]); return true;}
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {event.preventDefault(); const rows = [...this.rows.values()].filter(row => !row.gap && !row.tail && !row.root), at = rows.findIndex(row => row.row_id === this.selectionRow), next = rows[at + (event.key === "ArrowDown" ? 1 : -1)]; if (next) this.select(next.row_id, event.shiftKey); return true;}
        if (event.key === "Enter" && this.selectionRow) {event.preventDefault(); const row = this.rows.get(this.selectionRow); if (row) void this.appendAfter(row); return true;} return false;
      },
    }}})], keys: this.keys, onEdit: this.onEdit, onSelectionChange: this.onSelectionChange, onViewReady: view => this.setView(view),
    context: row_id => {
      const row = this.rows.get(row_id), parent = row?.branch ?? this.rootBranch;
      const branch = row?.ref && !parent.ancestors.has(row.ref) ? enterOutlineOccurrence({branch: parent, ref: row.ref, target: {kind: "occurrence", key: row_id}, edgeIds: row.link ? [row.link.link_id] : []}) : parent;
      return {branch, occurrenceKey: row_id, containingNoteRef: row?.ref ?? null, beforeCollapse: scope => this.beforeCollapseEmbedded(scope)};
    },
    reference: row_id => {
      const row = this.rows.get(row_id); if (!row) return null;
      const parent_ref = row.root ? this.rootRef : row.parent_ref;
      const after = row.root || row.tail ? this.windows.get(row.root ? this.pending.root_id : row.parent_id!)?.tailEdge?.link.link_id ?? null : row.link?.link_id ?? null;
      return {source_ref: parent_ref, label: parent_ref, onSelected: (target, item) => {
        void (async () => {
          const pending = this.pending.fields.get(row_id);
          const current = pending?.raw && !row.tail ? await this.pending.ready(row_id) : null;
          const endpoint = await prepareTarget(this.runtime, target);
          await this.history.paste(parent_ref, current?.link?.link_id ?? after, [{kind: "resource", ref: endpoint.ref, label: item.label, parent: null}], endpoint.intents);
        })().catch(error => {this.error = error; this.notify();});
      }};
    },
  };
  private copy(event: ClipboardEvent, cut: boolean): boolean {
    if (!this.selected.size || !event.clipboardData) return false;
    const rows = [...this.rows.values()].filter(row => this.selected.has(row.row_id) && !row.tail && !row.gap && (row.kind === "body" || row.ref)), items: ClipItem[] = [];
    for (const row of rows) {
      const parent = rows.findIndex(candidate => candidate.row_id === row.parent_id);
      items.push(row.kind === "body" ? {kind: "note", body: this.pending.fields.get(row.row_id)?.raw ? this.body(row.row_id) : this.binding.body(row.row_id), parent: parent < 0 ? null : parent}
        : {kind: "resource", ref: row.ref!, label: row.resource ? localResourceLabel(row.resource) : row.ref!, parent: parent < 0 ? null : parent});
    }
    event.preventDefault(); writeOutlineClipboard(event.clipboardData, items); if (cut) this.remove(rows.map(row => row.row_id)); return true;
  }
  close(): void {
    this.active = false; this.revoke(); this.disconnect?.(); this.unbindFocus?.(); this.view = null;
    for (const held of this.documents.values()) held.release(); this.documents.clear();
    for (const release of this.historyLeases.values()) release(); this.historyLeases.clear();
  }
}
