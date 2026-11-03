/** One mounted outline projection and admission owner. Every admitted field
 * binds its canonical document; the retained cell owns placement and copy text. */
import * as Y from "yjs";
import {type Node as PMNode} from "prosemirror-model";
import {Plugin, TextSelection, NodeSelection, type Transaction} from "prosemirror-state";
import type {EditorView, NodeView} from "prosemirror-view";
import {bodyText, docFromBody, emptyBody, noteBodySchema, type NoteBody} from "@nexus/authored/body";
import {decodeBytes, readBody} from "@nexus/authored/documents";
import {isVisible} from "@nexus/authored/merge";
import type {Intent} from "@nexus/authored/commands";
import type {LinkState, ResourceProjection} from "@nexus/authored/types";
import {classifyOutlineOccurrence, enterOutlineOccurrence, type OutlineBranch, type OutlineTarget} from "@/lib/resources/outlineProjection";
import {localResourceHref, localResourceLabel} from "@/lib/resources/localResource";
import type {NoteEditorHandle, TextEditorHandle, NoteEditorProjection, StructuralKeys} from "@/components/notes/NoteEditor";
import type {OutlineRowChrome, OutlineRowMount} from "@/components/notes/OutlineEditorRow";
import type {PlatformKind} from "@/lib/renderEnvironment/types";
import {outlineFoldCommand, outlineHistoryCommand, outlineStructuralCommand, usesMeta} from "@/lib/shortcuts";
import {planRange, rangeSelection, rangeReasonMessage, type BlockRange, type Destination, type InputBookmark, type RangePlan, type RangeReason, type RangeSnapshot, type RangeCommand, type SelectionRow} from "./outlineSelection";
import rowStyles from "@/components/notes/OutlineEditorRow.module.css";
import {isTextEntryTarget} from "@/lib/ui/eventTarget";
import type {WorkGuard} from "@/lib/unsavedWork";
import {OutlineBinding, type OutlineBindingField} from "./outlineBinding";
import {canonicalBody, fieldAt, fieldById, outlineEditorSchema, outlineTransactionSource, plainTitle} from "./outlineEditorModel";
import {OutlinePendingInput, type PendingOutlineField} from "./outlinePending";
import {OutlineHistory, type Birth, type EditorHistory, type DisplayedWriting, type OccurrenceBookmark, type OutlineVisibility} from "./structure";
import type {LocalCommit, WritingDocument, WritingRuntime} from "./runtime";
import type {OutlineWindow, OutlineEdge} from "./useOutlineWindow";
import type {FocusSelection, NoteEdit, OutlineCommand} from "./editorTypes";
import {clipboardPlainText, readOutlineClipboard, writeOutlineClipboard, type ClipItem} from "./clipboard";

interface ChildProof {descriptor: string; store_revision: string; available: boolean | null}
export interface OutlineRow {
  row_id: string; ref: string | null; link: LinkState | null; parent_id: string | null; parent_ref: string;
  depth: number; branch: OutlineBranch; resource: ResourceProjection | null; kind: "body" | "title" | "reference";
  children: ChildProof | null; open: boolean; terminal: boolean; root: boolean; tail: boolean;
  gap?: "before" | "after" | "tail";
  origin: unknown;
}
export interface BranchRead {pending: boolean; error: unknown | null; occurrence: object | null; retry(): void}
/** A command the outline refused before it changed anything: its fact and, where one is known, why. */
export class OutlineActionRefusal extends Error {
  constructor(readonly line: {readonly fact: string; readonly reason?: string}) {super(line.fact);}
}
const AT_LIMIT = "this outline has reached its editing limit.";
/** What a session retains across its controllers: open occurrences by row id, and the ids by parent row and link. */
export interface OutlineSession {opened: Set<string>; identities: Map<string, {id: string; origin: unknown}>}
export interface BranchRequest {parent_id: string; ref: string; branch: OutlineBranch; cursor: string | null; anchor: string | null; limit: number; foreground?: boolean;
  navigation?: {lease(): boolean; previous: BranchRequest}}
interface Held {document: WritingDocument; captureBytes: number; release(): void}
interface EmbeddedBranch {owner: string; projection: {ref: string; branch: OutlineBranch} | null}
export interface RootField {label: string; placeholder?: string; initialTitle?: string; inspection?: import("@/components/notes/NoteEditor").NoteInspection | null}
export interface OutlineRootAttachment {
  handle: TextEditorHandle; visible: boolean; ownsFocus(): boolean; reveal(): void;
}
type ProjectionReason = "initial" | "projection" | "semantic";
const MAX_REFS = 64, MAX_BYTES = 16 * 1024 * 1024;
const CLIPBOARD_EVENTS = ["beforecopy", "beforecut", "beforepaste", "copy", "cut", "paste"];

export class OutlineController {
  readonly binding = new OutlineBinding(new Map());
  readonly rows = new Map<string, OutlineRow>();
  private readonly occurrences = new Map<string, OutlineRow>();
  readonly windows = new Map<string, OutlineWindow>();
  readonly requests = new Map<string, BranchRequest>();
  readonly documents = new Map<string, Held>();
  private readonly reads = new Map<string, {request: BranchRequest; token: object; value: BranchRead}>();
  private readonly admissionFailures = new Map<string, {request: BranchRequest; error: unknown; occurrence: object}>();
  readonly mounts = new Map<string, OutlineRowMount & {sync(): void}>();
  /** Counts projections that changed the rows, their order, depth or parent; a drag session is void once it moves. */
  private epochCount = 0;
  get epoch(): number {return this.epochCount;}
  /** Visible links per resource across the windows and the pending fields, counted once per rebuild for the mirror pill. */
  private incidence = new Map<string, Set<string>>();
  /** A drop into a parent that opened for it; it lands as the first child once that window is shown, unless the projection moved first. */
  private placing: {rows: readonly string[]; destination: Destination; epoch: number} | null = null;
  private readonly workOwners = new Map<string, readonly string[]>();
  private blockRange: BlockRange | null = null;
  private cutting: InputBookmark = null;
  get selected(): ReadonlySet<string> {return new Set(this.blockRange?.row_ids ?? []);}
  announcement = "";
  announcementId = 0;
  platform: PlatformKind = "other";
  private removalKey: string | null = null;
  private removalPress: string | null = null;
  private readonly identities: Map<string, {id: string; origin: unknown}>;
  private readonly tailIds = new Map<string, string>();
  private readonly opened: Set<string>;
  private readonly embedded = new Map<string, EmbeddedBranch>();
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
  private touchCommandsDismissed = true;
  private selectionRow: string | null = null;
  private selection = {anchor: 1, head: 1};
  private view: EditorView | null = null;
  private handle: NoteEditorHandle | null = null;
  private rootAttachment: OutlineRootAttachment | null = null;
  private rootHistoryEntry: {document: WritingDocument; history: EditorHistory} | null = null;
  private rootSelectionBefore: ((document: WritingDocument) => FocusSelection) | null = null;
  private disconnect: (() => void) | null = null;
  private unbindFocus: (() => void) | null = null;
  private waiting: {row_id: string; selection: FocusSelection | null | ((document: WritingDocument) => FocusSelection); lease: () => boolean; resolve(): void; native?: {ref: string | null; kind: "body" | "title"}} | null = null;
  private deferred = false;
  private initialTitleApplied = false;
  private titleEdited = false;
  filter = "";
  error: unknown | null = null;
  revealExternal: ((target: OutlineTarget) => void) | null = null;
  constructor(readonly runtime: WritingRuntime, readonly history: OutlineHistory, readonly pending: OutlinePendingInput,
    readonly rootRef: string, readonly rootBranch: OutlineBranch, public rootField: RootField | undefined,
    readonly prelude: readonly Intent[], private readonly notify: () => void, private readonly pendingChanged: () => void,
    private readonly workGuard: Pick<WorkGuard, "confirmLoss" | "hasWork">, session: OutlineSession) {
    // fold state and occurrence ids belong to the session (decision 4): a remount, as a pane's return, reopens what was
    // open under the same row ids. a typing origin is the history's own, so each retained id takes a fresh one.
    this.opened = session.opened; this.identities = session.identities;
    for (const [key, row] of this.identities) this.identities.set(key, {id: row.id, origin: history.typingOrigin()});
    this.requests.set(pending.root_id, {parent_id: pending.root_id, ref: rootRef, branch: rootBranch, cursor: null, anchor: null, limit: 48});
    this.attempted.add(pending.root_id);
    for (const row of pending.fields.values()) if (row.link && (row.link.endpoint_a === row.ref ? row.link.endpoint_b : row.link.endpoint_a) === row.parent_ref)
      this.identities.set(`${row.parent_id}/${row.link.link_id}`, {id: row.row_id, origin: row.origin});
  }
  publishRead(request: BranchRequest, value: BranchRead): () => void {
    if (!this.active || this.requests.get(request.parent_id) !== request) return () => {};
    const token = {};
    this.reads.set(request.parent_id, {request, token, value});
    this.notify();
    return () => {if (this.reads.get(request.parent_id)?.token === token) {this.reads.delete(request.parent_id); if (this.active) this.notify();}};
  }
  branchRead(parent_id: string): BranchRead {
    const request = this.requests.get(parent_id);
    const collected = this.reads.get(parent_id);
    const read = collected !== undefined && collected.request === request ? collected.value : null;
    const admission = this.admissionFailures.get(parent_id);
    const failed = admission?.request === request ? admission : null;
    const pending = read?.pending === true || this.scheduled.has(parent_id) && (request?.foreground === true || !this.windows.has(parent_id));
    return {pending, error: read?.error ?? failed?.error ?? null, occurrence: read?.occurrence ?? failed?.occurrence ?? null,
      retry: () => {
        if (!request || this.requests.get(parent_id) !== request) return;
        request.foreground = true;
        // renew navigation without replacing the collector's request identity.
        if (request.navigation) request.navigation.lease = this.lease();
        if (read?.error !== null && read?.error !== undefined) read.retry();
        else if (failed) {const window = this.proposals.get(parent_id); if (window) this.accept(parent_id, window);}
      }};
  }
  private connect(): void {
    this.disconnect = this.pending.connect({
      history: this.history, notify: this.pendingChanged, capture: () => this.capture(),
      canRetain: () => this.refs().size <= MAX_REFS && this.bytes() <= MAX_BYTES,
      rangeSnapshot: () => this.rangeSnapshot(), installRange: (plan, mayFocus, action) => this.installRange(plan, mayFocus, action),
      document: ref => this.writing(ref),
      occurrence: id => this.retained(id),
      prepared: (row, document) => {
        if (!this.documents.has(document.ref)) this.documents.set(document.ref, {document, captureBytes: 0, release: document.retain()});
        this.binding.prepare(row.row_id, this.field(row.row_id, document));
      },
      publish: (documents, committed) => this.publishWriting(documents, committed),
      confirmed: (row, document) => {
        if (!this.active || !this.view || !this.handle?.canArrange() || !fieldById(this.view.state.doc, row.row_id)) return false;
        this.binding.refresh();
        return this.binding.document(row.row_id) === document;
      },
      identity: row => {
        if (!this.active || this.view === null) return;
        if (row.link && (row.link.endpoint_a === row.ref ? row.link.endpoint_b : row.link.endpoint_a) === row.parent_ref)
          this.transfer(row.row_id, row.parent_id!, row.link.link_id, row.origin);
        this.changed();
      },
    });
    for (const row of this.pending.fields.values()) if (row.link && (row.link.endpoint_a === row.ref ? row.link.endpoint_b : row.link.endpoint_a) === row.parent_ref)
      this.transfer(row.row_id, row.parent_id!, row.link.link_id, row.origin);
    this.unbindFocus = this.history.bindFocus({publish: (documents, target, source, mayFocus, committed, action) => {
      this.publishWriting(documents, committed, target, source, mayFocus);
      if (mayFocus()) void committed.then(() => {if (this.active && !this.blockRange) {this.announce(action === "undo" ? "outline change undone" : "outline change redone"); this.notify();}}, () => {});
    },
      capture: () => this.capture(), prepare: (targets, sources, mayFocus, visibility) => this.prepare(targets, sources, mayFocus, visibility),
      lease: () => this.lease()});
  }
  lease = () => {const at = this.intent; return () => this.active && at === this.intent;};
  revoke(): void {this.intent++; this.waiting?.resolve(); this.waiting = null;}
  /** Native tab chooses the focus destination. The existing request reconciles
   * this admitted entry only after the browser actually enters its host. */
  armNativeEntry(): void {
    this.waiting?.resolve(); this.waiting = null;
    const view = this.view;
    if (!this.active || !view || view.hasFocus() || this.selected.size || !this.handle?.canArrange()) return;
    const selection = view.state.selection;
    if (!(selection instanceof TextSelection)) return;
    const field = fieldAt(view.state.doc, selection.anchor), row = field ? this.rows.get(field.row_id) : null;
    if (!field || !row || !row.tail || !this.editableReady(row) || selection.from < field.from || selection.to > field.to) return;
    this.waiting = {row_id: row.row_id, selection: {anchor: selection.anchor - field.from + 1, head: selection.head - field.from + 1},
      lease: this.lease(), resolve() {}, native: {ref: row.ref, kind: field.kind}};
  }
  attachRoot(attachment: OutlineRootAttachment | null): void {this.rootAttachment = attachment; this.tryFocus();}
  get rootDocument(): WritingDocument | null {return this.rootField ? this.documents.get(this.rootRef)?.document ?? null : null;}
  rootHistory(): EditorHistory | null {
    const document = this.rootDocument; if (!document) return null;
    if (this.rootHistoryEntry?.document === document) return this.rootHistoryEntry.history;
    const history = this.history.editor(document, this.origin(this.pending.root_id));
    const entry: EditorHistory = {...history, record: (edit, admission) => {
      if (this.rootRef.startsWith("page:")) this.titleEdited = true;
      const before = this.rootSelectionBefore;
      history.record(edit, admission, {kind: "text", root: true, row_id: this.pending.root_id, ref: this.rootRef,
        range: edit?.selectionAfter ?? this.selection,
        resolve: this.rootAttachment?.handle.captureSelection() ?? null, resolveBefore: before ?? undefined});
    }};
    this.rootHistoryEntry = {document, history: entry}; return entry;
  }
  onRootSelectionChange = (at: {anchor: number; head: number}): void => {
    if (this.rootAttachment?.ownsFocus()) {
      if (this.selectionRow !== this.pending.root_id) this.history.boundary();
      this.selectionRow = this.pending.root_id; this.selection = at; this.blockRange = null; this.handle?.setInputMode("text"); this.announcement = ""; this.focused = true;
      this.rootSelectionBefore = this.rootAttachment.handle.captureSelection(); this.syncMetadata(); this.notify();
    }
    this.tryFocus();
  };
  blurRoot(): void {if (this.selectionRow === this.pending.root_id && !this.rootAttachment?.ownsFocus()) this.setFocused(false);}
  setHandle(handle: NoteEditorHandle | null): void {this.handle = handle; if (handle) {handle.setInputMode(this.blockRange ? "blocks" : "text"); this.refresh();}}
  setView(view: EditorView | null): void {
    this.view = view;
    if (view) {
      view.dom.addEventListener("keydown", this.blockKey, true);
      for (const name of ["beforeinput", "compositionstart", "drop"])
        view.dom.addEventListener(name, this.blockInput, true);
      for (const name of CLIPBOARD_EVENTS) window.addEventListener(name, this.blockClipboard, true);
      window.addEventListener("keydown", this.removalFence, true); window.addEventListener("beforeinput", this.removalFence, true);
      window.addEventListener("keyup", this.releaseRemoval, true); window.addEventListener("blur", this.releaseRemoval);
      if (!this.disconnect) this.connect();
      this.project("initial");
      if (this.selectionRow === null && !this.selected.size) {
        const tr = view.state.tr.setMeta(outlineTransactionSource, "projection");
        if (this.setNativeEntry(tr)) view.dispatch(tr);
      }
      this.tryFocus();
    }
    else {this.releaseRemoval(); for (const name of CLIPBOARD_EVENTS) window.removeEventListener(name, this.blockClipboard, true); window.removeEventListener("keydown", this.removalFence, true); window.removeEventListener("beforeinput", this.removalFence, true); window.removeEventListener("keyup", this.releaseRemoval, true); window.removeEventListener("blur", this.releaseRemoval); this.disconnect?.(); this.disconnect = null; this.unbindFocus?.(); this.unbindFocus = null;}
  }
  setFocused(value: boolean): void {this.focused = value; if (value) this.touchCommandsDismissed = false; else {this.releaseRemoval(); this.refresh();} this.notify();}
  withdraw(): void {
    // the retained header settles a departure after its pointer activation.
    if (this.selectionRow === this.pending.root_id && this.rootAttachment?.ownsFocus()) return;
    this.releaseRemoval(); this.announcement = ""; this.focused = false; this.blockRange = null; this.handle?.setInputMode("text"); this.refresh(); this.syncMetadata(); this.notify();
  }
  onSelectionChange = (row_id: string, at: {anchor: number; head: number}) => {
    // Keyup and composition/query release retry the same certified entry. Its
    // dispatch notifies with the settled selection; this call's old args do not.
    if (this.waiting?.native) {this.tryFocus(); return;}
    if (this.blockRange === null) {
      if (this.selectionRow !== row_id) this.history.boundary();
      this.selectionRow = row_id; this.selection = at;
    }
    this.focused = this.view?.hasFocus() ?? false; this.syncMetadata(); this.notify(); if (this.deferred) this.refresh(); else this.project();
  };
  private changed(reason: ProjectionReason = "projection"): void {this.rebuild(reason); this.notify();}
  refresh(): void {
    this.rebuild();
    if (this.handle?.canArrange()) {this.binding.refresh(); this.pending.resume(); for (const [id, window] of this.proposals) this.resumeAdmission(id, window);}
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
        {kind: "text", root: true, row_id: this.pending.root_id, ref: this.rootRef, range: {anchor: text.length + 1, head: text.length + 1}, resolve: null});
    } finally {release();}
  }
  /** IME visibility controls presentation, never DOM focus or input authority. */
  setTouchCommandsVisible(visible: boolean): void {
    if (this.touchCommandsDismissed === !visible) return;
    this.touchCommandsDismissed = !visible; this.notify();
  }
  revealTouchCommands(event: Event): void {
    if (event instanceof KeyboardEvent && ["Alt", "AltGraph", "Control", "Meta", "Shift", "Tab"].includes(event.key)) return;
    const target = event.target, host = this.view?.dom;
    if (!(target instanceof Element) || !host || target.closest(".ProseMirror") !== host || !isTextEntryTarget(target)) return;
    if (target !== host) {
      const field = target.closest<HTMLElement>("[data-outline-field]");
      if (!field?.isContentEditable || target.closest("button, input, textarea, select, a[href]")) return;
    }
    this.setTouchCommandsVisible(true);
  }
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
  private protectField(row_id: string): void {
    const field = this.pending.fields.get(row_id), document = field?.ref ? this.writing(field.ref) : null;
    if (!field || field.kind === "reference" || !document) return;
    this.pending.freeze(field, document);
  }
  private prepare(targets: readonly OccurrenceBookmark[], sources: readonly OccurrenceBookmark[], _mayFocus: () => boolean,
    visibility: OutlineVisibility): (committed: Promise<LocalCommit>) => void {
    const acknowledgements: ((committed: Promise<LocalCommit>) => void)[] = [];
    const shown = [...targets, ...visibility.show], hidden = [...sources, ...visibility.hide].filter(source => !shown.some(target => target.row_id === source.row_id));
    for (const target of [...hidden, ...shown]) {
      const row = this.rows.get(target.row_id) ?? this.occurrences.get(target.row_id);
      if (!row || row.root || !row.ref) continue;
      const placement = shown.includes(target) ? target.placement : null, current = this.pending.fields.get(row.row_id), receiptOwner = {};
      const parent_id = placement?.parent_id ?? row.parent_id, parent_ref = placement?.parent_ref ?? row.parent_ref;
      const observed = target.link && "link_id" in target.link ? target.link : null;
      const compatible = row.link && (row.link.endpoint_a === row.ref ? row.link.endpoint_b : row.link.endpoint_a) === parent_ref ? row.link : null;
      this.pending.fields.set(row.row_id, {...current, row_id: row.row_id, ref: row.ref, parent_id, parent_ref,
        after_id: placement?.after_id ?? null, before_id: placement?.before_id ?? undefined, link: observed ?? compatible,
        kind: row.kind, resource: row.resource, body: current?.body ?? this.body(row.row_id), pending: row.kind !== "reference", hidden: placement === null,
        origin: row.origin, relocating: placement ? crypto.randomUUID() : undefined, previousParent: current?.relocating ? current.previousParent : row.parent_id,
        previousParentRef: current?.relocating ? current.previousParentRef : row.parent_ref, settledRevision: undefined, receiptOwner});
      this.protectField(row.row_id);
      if (placement) {
        this.pending.place(row.row_id, placement.after_id, placement.before_id);
        if (target.link) this.pending.restoreRelationship(row.row_id, target.link);
        if (observed) this.transfer(row.row_id, placement.parent_id, observed.link_id, row.origin);
        if (placement.parent_id !== this.pending.root_id) this.opened.add(placement.parent_id);
      }
      acknowledgements.push(committed => this.pending.acknowledge(row.row_id, receiptOwner, committed));
    }
    this.changed("semantic");
    return committed => {for (const acknowledge of acknowledgements) acknowledge(committed);};
  }
  private installRange(plan: RangePlan, mayFocus: () => boolean, action: "undo" | "redo" | null): void {
    if (!this.active) return;
    // The destination opens whatever the lease says: a later key moves the caret on, never hides the row just placed.
    for (const change of plan.changes) if (change.after && change.after.parent_id !== this.pending.root_id) this.opened.add(change.after.parent_id);
    for (const change of plan.changes) if (change.merged?.former && this.opened.delete(change.merged.former)) this.opened.add(change.before.row_id);
    this.changed("semantic");
    if (mayFocus()) {
      void this.restoreInput(plan.selection_after, mayFocus);
      if (action !== null && !this.blockRange) this.announce(action === "undo" ? "outline change undone" : "outline change redone");
      // a cut's remove carries the cut's own bookmark object through planning and history to this receipt.
      else if (action === null && plan.command === "remove") this.announce(this.cutting !== null && plan.selection_before === this.cutting
        ? plan.changes.length === 1 ? "cut" : `cut ${plan.changes.length} items` : `removed from this outline${this.blockRange ? `. ${this.announcement}` : ""}`);
      else if (action === null && plan.command !== "indent" && plan.command !== "outdent") this.announce(this.placed(plan));
    }
    this.notify();
  }
  private restoreInput(bookmark: InputBookmark, mayFocus = this.lease()): Promise<void> {
    if (!mayFocus()) return Promise.resolve();
    if (bookmark?.kind === "blocks") {
      const row_ids = bookmark.row_ids.filter(id => this.rows.has(id) && !this.pending.fields.get(id)?.hidden);
      if (row_ids.length) {
        this.setRange({anchor_id: row_ids.includes(bookmark.anchor_id) ? bookmark.anchor_id : row_ids[0]!,
          head_id: row_ids.includes(bookmark.head_id) ? bookmark.head_id : row_ids[row_ids.length - 1]!, row_ids});
        return Promise.resolve();
      }
    } else if (bookmark && this.rows.has(bookmark.row_id) && !this.pending.fields.get(bookmark.row_id)?.hidden) return this.focus(bookmark.row_id, bookmark.resolve ?? bookmark.range, mayFocus);
    this.blockRange = null; this.handle?.setInputMode("text");
    const fallback = [...this.rows.values()].find(row => row.tail && row.parent_id === this.pending.root_id) ?? this.rows.get(this.pending.root_id);
    return fallback ? this.focus(fallback.row_id, {anchor: 1, head: 1}, mayFocus) : Promise.resolve();
  }
  private tailId(parent: string): string {
    let id = this.tailIds.get(parent); if (!id) {id = crypto.randomUUID(); this.tailIds.set(parent, id);} return id;
  }
  private writing(ref: string): WritingDocument | null {
    return this.documents.get(ref)?.document ?? [...this.pending.fields.values()].filter(row => row.ref === ref).map(row => this.pending.document(row.row_id)).find(document => document !== null) ?? null;
  }
  private retained(id: string): import("./outlinePending").PendingOutlineField | null {
    const pending = this.pending.fields.get(id); if (pending) return pending;
    const row = this.rows.get(id); if (!row) return null;
    return {row_id: id, parent_id: row.parent_id, parent_ref: row.parent_ref, after_id: null, ref: row.ref, link: row.link, kind: row.kind,
      resource: row.resource, body: row.kind === "reference" ? emptyBody() : this.binding.body(id), hidden: false, pending: false, origin: row.origin};
  }
  private publishWriting(documents: readonly WritingDocument[], committed: Promise<LocalCommit>, target?: InputBookmark, source?: InputBookmark, mayFocus = this.lease()): void {
    if (!this.active || !this.view) return;
    const active = this.selectionRow ? this.rows.get(this.selectionRow) : null, resolve = active && (active.root ? this.rootAttachment?.handle : this.handle)?.captureSelection();
    for (const document of documents) {
      if (!this.documents.has(document.ref)) this.documents.set(document.ref, {document, captureBytes: 0, release: document.retain()});
      for (const [id, field] of this.pending.fields) if (field.ref === document.ref) {
        if (!this.pending.document(id) && field.pending) this.pending.freeze(field, document);
        this.binding.prepare(id, this.field(id, document));
        this.pending.fields.set(id, {...field, body: field.kind === "title" ? bodyText(document.doc.getText("title").toString()) : readBody(document.doc)});
      }
    }
    this.binding.publish(documents, committed);
    if (active?.ref && resolve && documents.some(document => document.ref === active.ref)) {
      const at = resolve(this.writing(active.ref)!);
      const end = docFromBody(active.root ? this.body(active.row_id) : this.binding.body(active.row_id)).firstChild!.content.size + 1;
      this.selection = at === "end" ? {anchor: end, head: end} : at;
    }
    this.changed("semantic");
    if (target !== undefined && mayFocus()) void this.restoreInput(target, mayFocus);
  }
  private body(row_id: string): NoteBody {
    const pending = this.pending.fields.get(row_id);
    if (pending?.pending) return pending.body;
    const row = this.rows.get(row_id), document = row?.ref ? this.documents.get(row.ref)?.document : null;
    if (document) return row?.kind === "title" ? bodyText(document.doc.getText("title").toString()) : readBody(document.doc);
    return row?.kind === "title" ? bodyText(this.rootField?.initialTitle ?? row.resource?.title ?? "") : emptyBody();
  }
  private field(row_id: string, supplied?: WritingDocument): OutlineBindingField {
    const row = this.rows.get(row_id) ?? this.pending.fields.get(row_id);
    const document = supplied ?? this.pending.document(row_id) ?? (row?.ref ? this.writing(row.ref) : null);
    return {kind: row?.kind === "title" ? "title" : "body", document, origin: row?.origin ?? this.origin(row_id), body: () => this.body(row_id),
      deferRefresh: () => [...this.embedded].some(([id, embedded]) => embedded.projection !== null && embedded.owner === row_id && this.protectedDescendants(id))};
  }
  private detached(row_id: string): boolean {
    let parent: string | null = row_id;
    while (parent) {if (this.embedded.get(parent)?.projection === null) return true; parent = this.parent(parent);}
    return false;
  }
  private protectedRows(includePlacements = true): Set<string> {
    const protectedRows = new Set([...this.pending.fields.values()].filter(row => row.pending || includePlacements && row.relocating && !this.detached(row.parent_id ?? row.row_id)).map(row => row.row_id));
    for (const id of this.selected) if (this.rows.has(id)) protectedRows.add(id);
    if (this.view?.hasFocus() && this.selectionRow) protectedRows.add(this.selectionRow);
    for (const id of [...protectedRows]) {let parent = this.parent(id); while (parent) {protectedRows.add(parent); parent = this.parent(parent);}}
    return protectedRows;
  }
  /** Why these rows cannot leave view now, or null: writing not yet saved, else a block selection
   * among them, else the caret in one. */
  private keepReason(rows: ReadonlySet<string>): string | null {
    const ids = [...rows];
    if (ids.some(id => this.pending.fields.get(id)?.pending || this.pending.fields.get(id)?.relocating)) return "it has writing that isn’t saved yet.";
    if (ids.some(id => this.selected.has(id))) return "items in it are selected.";
    return this.view?.hasFocus() && this.selectionRow !== null && rows.has(this.selectionRow) ? "the caret is in it." : null;
  }
  private protectedDescendants(parent_id: string): boolean {
    for (const id of this.protectedRows()) {let parent = this.parent(id); while (parent) {if (parent === parent_id) return true; parent = this.parent(parent);}}
    return false;
  }
  private hasPendingWriting(): boolean {return [...this.pending.fields.values()].some(row => row.pending);}
  private refs(windows?: ReadonlyMap<string, OutlineWindow>, historyRefs = this.history.retainedRefs()): Set<string> {
    const current = windows ?? this.reservedWindows ?? this.windows;
    return new Set([...this.binding.capturedDocuments().map(document => document.ref), ...[...this.documents].filter(([, held]) => held.captureBytes > 0).map(([ref]) => ref), ...(this.rootField ? [this.rootRef] : []), ...[...current.values()].flatMap(window => [...window.editableRefs]),
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
  private baselineRefs(windows: ReadonlyMap<string, OutlineWindow>): Map<string, string> {
    const fields = new Map<string, string>();
    for (const [parent, window] of windows) for (const item of window.rows) {
      if (!item.link || item.resource.kind !== "note" && item.resource.kind !== "page" ||
        classifyOutlineOccurrence({branch: window.branch, targetRef: item.resource.ref, edgeId: item.link.link_id}).kind !== "resource") continue;
      fields.set(this.id(parent, item.link.link_id), item.resource.ref);
    }
    for (const field of this.pending.fields.values()) if (!field.hidden && field.kind !== "reference" && field.ref &&
      (field.parent_id === null || windows.has(field.parent_id) || this.opened.has(field.parent_id))) fields.set(field.row_id, field.ref);
    for (const id of this.protectedRows()) {const row = this.rows.get(id); if (row?.ref && !row.root && row.kind !== "reference") fields.set(id, row.ref);}
    return fields;
  }
  private captureDocument(ref: string): Promise<void> {
    const held = this.documents.get(ref); if (!held) return Promise.resolve();
    const bytes = Y.encodeStateAsUpdate(held.document.doc).byteLength;
    held.captureBytes += bytes;
    return held.document.capture().then(() => {}).finally(() => {held.captureBytes -= bytes;});
  }
  private capturedBytes(): number {return [...this.documents.values()].reduce((bytes, held) => bytes + held.captureBytes, this.pending.encodedBytes());}
  private bytes(wanted = this.refs(), historyBytes = this.history.retainedBytes(), baselines?: ReadonlyMap<string, number>): number {
    const captured = this.binding.capturedDocuments();
    return [...wanted].reduce((bytes, ref) => {const document = this.writing(ref) ?? captured.find(document => document.ref === ref); return bytes + (document ? Y.encodeStateAsUpdate(document.doc).byteLength : 0);},
      this.reservedBytes + (this.rootAttachment?.handle.encodedBytes() ?? (this.rootDocument ? Y.encodeStateAsUpdate(this.rootDocument.doc).byteLength : 0)) + this.binding.encodedBytes(baselines) + this.capturedBytes() + historyBytes);
  }
  private denied(parent: string): void {if (this.attempted.has(parent)) {this.error = new OutlineActionRefusal({fact: "couldn’t open more here.", reason: AT_LIMIT}); this.notify();}}
  private navigationValid(parent: string): boolean {
    const request = this.requests.get(parent);
    if (!request?.navigation || request.navigation.lease()) return true;
    if (this.admissionFailures.get(parent)?.request === request) return false;
    this.requests.set(parent, request.navigation.previous); this.versions.set(parent, (this.versions.get(parent) ?? 0) + 1); this.proposals.delete(parent); this.notify();
    return false;
  }
  private admitNew(count = 1): boolean {
    if (this.slots() + count <= MAX_REFS && this.bytes() <= MAX_BYTES) {this.error = null; return true;}
    const windows = this.reservedWindows ?? this.windows;
    const withoutHistory = new Set<string>();
    // The hypothetical estimate drops only baselines owned solely by history.
    // Outstanding captures remain protected; actual admission still checks all charge.
    const visibleBaselines = new Map([...this.baselineRefs(windows).keys()].map(id => [id, 0]));
    if (this.slots(windows, withoutHistory) + count > MAX_REFS || this.bytes(this.refs(windows, withoutHistory), 0, visibleBaselines) > MAX_BYTES) {
      this.error = new OutlineActionRefusal({fact: "couldn’t add more writing here.", reason: AT_LIMIT}); this.notify(); return false;
    }
    while ((this.slots(windows) + count > MAX_REFS || this.bytes(this.refs(windows)) > MAX_BYTES) && this.history.releaseOldest()) {}
    if (this.slots() + count <= MAX_REFS && this.bytes() <= MAX_BYTES) {this.error = null; return true;}
    const fact = "couldn’t add writing yet.";
    const finishing = this.error instanceof OutlineActionRefusal && this.error.message === fact ? this.error : new OutlineActionRefusal({fact, reason: "older edits are still finishing."});
    this.error = finishing; this.notify();
    this.admission = this.admission.then(async () => {
      await this.history.settleRetired();
      const wanted = this.refs(this.reservedWindows ?? this.windows);
      const retired = [...this.documents].filter(([ref]) => !wanted.has(ref) && !this.settlingRefs.has(ref));
      for (const [ref] of retired) this.settlingRefs.add(ref);
      try {
        await Promise.all(retired.map(([ref]) => this.captureDocument(ref)));
        const keep = this.refs(this.reservedWindows ?? this.windows);
        for (const [ref, held] of retired) if (!keep.has(ref) && this.documents.get(ref) === held && held.captureBytes === 0) {held.release(); this.documents.delete(ref); this.historyLeases.get(ref)?.(); this.historyLeases.delete(ref);}
        if (this.active && this.error === finishing) this.error = null;
      } finally {for (const [ref] of retired) this.settlingRefs.delete(ref);}
      if (this.active) this.changed();
    }).catch(error => {if (this.active) {this.error = error; this.notify();}});
    return false;
  }
  private childDescriptor(row: OutlineRow): string | null {
    if (!row.parent_id || !row.ref || !row.link) return null;
    return JSON.stringify([row.parent_id, row.parent_ref, row.ref, row.link.link_id,
      [...row.branch.ancestors].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([ref, target]) => [ref, target.kind, target.kind === "occurrence" ? target.key : null]),
      [...row.branch.traversedEdgeIds].sort()]);
  }
  private childProof(row: OutlineRow, window: OutlineWindow | undefined): ChildProof | null {
    if (!window || !row.link || !window.rows.some(item => item.link?.link_id === row.link!.link_id && item.resource.ref === row.ref)) return null;
    const descriptor = this.childDescriptor(row);
    if (descriptor === null || descriptor !== this.childDescriptor({...row, parent_ref: window.ref, branch: window.branch})) return null;
    const available = window.childAvailability.get(row.link.link_id);
    return typeof available === "boolean" ? {descriptor, store_revision: window.data.store_revision, available} : null;
  }
  private refreshChildren(parent_id: string, window: OutlineWindow): void {
    if (!this.active || !this.requests.has(parent_id)) return;
    let changed = false;
    for (const row of this.rows.values()) {
      if (row.parent_id !== parent_id) continue;
      const proof = this.childProof(row, window);
      if (!proof || row.children?.descriptor === proof.descriptor && (BigInt(row.children.store_revision) > BigInt(proof.store_revision)
        || row.children.available !== null && row.children.store_revision === proof.store_revision)) continue;
      row.children = proof; changed = true;
    }
    if (changed) {this.syncMetadata(); this.notify();}
  }
  private compatibleWindow(parent_id: string, window: OutlineWindow): boolean {
    const request = this.requests.get(parent_id);
    return !!request && window.ref === request.ref && window.branch === request.branch;
  }
  private sourceConfirmed(field: PendingOutlineField, candidate: ReadonlyMap<string, OutlineWindow>): boolean {
    const source = field.previousParent;
    if (!source || source === field.parent_id && field.previousParentRef === field.parent_ref) return true;
    const admitted = this.windows.get(source);
    if (!admitted || !admitted.rows.some(row => row.resource.ref === field.ref)) return true;
    const proof = candidate.get(source);
    // An atomic ancestor update can withdraw the entire admitted source window.
    if (!proof) return true;
    return proof.ref === field.previousParentRef && this.compatibleWindow(source, proof) && !!field.settledRevision &&
      BigInt(proof.data.store_revision) >= BigInt(field.settledRevision);
  }
  /** Target admission and its source proofs form one atomic window update.
   * Only dependencies join the batch; unrelated proposals retain their budget. */
  private placementWindows(parent_id: string, window: OutlineWindow): Map<string, OutlineWindow> | null {
    const selected = new Map([[parent_id, window]]);
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const field of this.pending.fields.values()) {
        const candidate = this.reachable(new Map([...this.windows, ...selected]));
        if (!field.relocating || !field.parent_id || !selected.has(field.parent_id) || !candidate.has(field.parent_id) || this.sourceConfirmed(field, candidate)) continue;
        const source = field.previousParent!, proof = this.proposals.get(source);
        if (selected.has(source) || !proof || proof.data.store_revision !== window.data.store_revision || !this.compatibleWindow(source, proof)) return null;
        selected.set(source, proof); expanded = true;
      }
      const reachable = this.reachable(new Map([...this.windows, ...selected]));
      if (reachable.get(parent_id) !== window) return null;
      for (const [id, part] of selected) if (reachable.get(id) !== part) {selected.delete(id); expanded = true;}
    }
    return selected;
  }
  /** Background reconciliation resumes deferred admission, never a failed request. */
  private resumeAdmission(parent_id: string, window: OutlineWindow): void {
    const request = this.requests.get(parent_id);
    if (!request || this.admissionFailures.get(parent_id)?.request === request) return;
    this.accept(parent_id, window);
  }
  accept(parent_id: string, window: OutlineWindow): void {
    this.refreshChildren(parent_id, window);
    if (this.proposals.get(parent_id) !== window) {this.proposals.set(parent_id, window); this.versions.set(parent_id, (this.versions.get(parent_id) ?? 0) + 1);}
    if (this.scheduled.has(parent_id)) return;
    this.scheduled.add(parent_id);
    this.notify();
    const version = this.versions.get(parent_id)!;
    const request = this.requests.get(parent_id);
    let released = false, failed = false, installed = false, topologyChanged = false;
    this.admission = this.admission.then(async () => {
      if (!this.active || this.versions.get(parent_id) !== version || !this.requests.has(parent_id) || !this.navigationValid(parent_id)) return;
      if (this.windows.size && this.view && (this.hasPendingWriting() || !this.handle?.canArrange())) return;
      const placements = [...this.pending.fields.values()].filter(field => field.relocating);
      if (placements.some(field => field.settledRevision === undefined)) return;
      const selected = this.placementWindows(parent_id, window); if (!selected) return;
      const accepted = [...selected].map(([id, part]) => ({id, window: part, request: this.requests.get(id), version: this.versions.get(id)}));
      const next = this.reachable(new Map([...this.windows, ...selected]));
      const valid = () => {
        if (!this.active || !accepted.every(part => this.requests.get(part.id) === part.request && this.versions.get(part.id) === part.version &&
          this.proposals.get(part.id) === part.window && this.compatibleWindow(part.id, part.window) && this.navigationValid(part.id))) return false;
        const actual = this.reachable(new Map([...this.windows, ...selected]));
        if (actual.size !== next.size || [...actual].some(([id, part]) => next.get(id) !== part)) {topologyChanged = true; return false;}
        return [...this.pending.fields.values()].filter(field => field.relocating).length === placements.length && placements.every(field => {
          const current = this.pending.fields.get(field.row_id);
          if (!current) return false;
          return current.relocating === field.relocating && current.receiptOwner === field.receiptOwner && current.settledRevision === field.settledRevision &&
            current.ref === field.ref && current.parent_id === field.parent_id && current.parent_ref === field.parent_ref &&
            current.previousParent === field.previousParent && current.previousParentRef === field.previousParentRef &&
            (!field.parent_id || !selected.has(field.parent_id) || actual.get(field.parent_id) !== selected.get(field.parent_id) || this.sourceConfirmed(current, actual));
        });
      };
      if (!valid()) return;
      while (this.slots(next) > MAX_REFS && this.history.releaseOldest()) {await this.history.settleRetired();}
      if (this.slots(next) > MAX_REFS) {this.denied(parent_id); return;}
      const refs = this.refs(next);
      const store = await this.runtime.store;
      const snapshot = await store.readSnapshot({refs: [...refs], link_ids: [], anchor_ids: [], source_refs: []});
      if (!valid() || snapshot.replica.store_revision !== window.data.store_revision) return;
      const baselineRefs = this.baselineRefs(next);
      const size = (ref: string, opened?: ReadonlyMap<string, Held>) => {
        const held = opened?.get(ref) ?? this.documents.get(ref);
        const document = held?.document ?? this.binding.capturedDocuments().find(document => document.ref === ref);
        if (document) return Y.encodeStateAsUpdate(document.doc).byteLength;
        const state = snapshot.states.resources.find(state => state.ref === ref);
        return state?.kind === "note" ? decodeBytes(state.body_state).byteLength : state?.kind === "page" ? decodeBytes(state.title_state).byteLength : 0;
      };
      const proposed = (opened?: ReadonlyMap<string, Held>) => new Map([...baselineRefs].map(([id, ref]) => [id, size(ref, opened)]));
      const charge = (opened?: ReadonlyMap<string, Held>) => [...this.refs(next)].reduce((bytes, ref) => bytes + size(ref, opened),
        this.history.retainedBytes() + this.capturedBytes() + (this.rootField ? this.rootAttachment?.handle.encodedBytes() ?? size(this.rootRef, opened) : 0) + this.binding.encodedBytes(proposed(opened), this.history.retainedOccurrences()));
      while (charge() > MAX_BYTES && this.history.releaseOldest()) {await this.history.settleRetired();}
      const newRefs = [...this.refs(next)].filter(ref => !this.documents.has(ref));
      const newBindings = [...baselineRefs.keys()].some(id => this.binding.document(id) === null);
      if ((newRefs.length || newBindings) && charge() > MAX_BYTES) {this.denied(parent_id); return;}
      const keep = this.refs(next), retired = [...this.documents].filter(([ref]) => !keep.has(ref));
      const activeRow = this.selectionRow ? this.rows.get(this.selectionRow) : null;
      if (this.view?.hasFocus() && activeRow?.ref && retired.some(([ref]) => ref === activeRow.ref)) return;
      this.reservedWindows = next;
      this.reservedBytes = newRefs.reduce((bytes, ref) => {const state = snapshot.states.resources.find(state => state.ref === ref); return bytes + (state?.kind === "note" ? decodeBytes(state.body_state).byteLength : state?.kind === "page" ? decodeBytes(state.title_state).byteLength : 0);}, 0);
      for (const [ref] of retired) this.settlingRefs.add(ref);
      for (const row of this.rows.values()) if (row.ref && retired.some(([ref]) => row.ref === ref)) this.blockedRows.add(row.row_id);
      for (const part of accepted) if (part.request?.navigation) for (const row of this.rows.values()) if (row.parent_id === part.id && !row.root) this.blockedRows.add(row.row_id);
      const retainedOccurrences = this.history.retainedOccurrences();
      for (const row of this.rows.values()) if (!row.root && !baselineRefs.has(row.row_id) && !retainedOccurrences.has(row.row_id)) this.blockedRows.add(row.row_id);
      this.syncReadOnly();
      try {await Promise.all(retired.map(([ref]) => this.captureDocument(ref)));}
      catch (error) {this.blockedRows.clear(); this.syncReadOnly(); throw error;}
      this.settlingRefs.clear();
      if (!valid() || this.view && this.windows.size > 0 && (this.hasPendingWriting() || !this.handle?.canArrange())) {this.blockedRows.clear(); this.syncReadOnly(); return;}
      const retainedFields = new Map<string, OutlineBindingField>();
      for (const row of this.rows.values()) if (!row.root && this.editableReady(row) && !this.blockedRows.has(row.row_id)) retainedFields.set(row.row_id, this.field(row.row_id));
      this.binding.update(retainedFields, this.history.retainedOccurrences());
      for (const [ref, held] of retired) if (held.captureBytes === 0) {held.release(); this.documents.delete(ref); this.historyLeases.get(ref)?.(); this.historyLeases.delete(ref);}
      released = retired.length > 0;
      const acquired: [string, Held][] = [];
      try {
        const editable = this.refs(next);
        for (const ref of editable) if (!this.documents.has(ref)) {
          if (this.slots(next) > MAX_REFS) {this.denied(parent_id); return;}
          const resource = snapshot.states.resources.find(resource => resource.ref === ref);
          const prelude = ref === this.rootRef ? this.prelude : [];
          const document = await (resource && resource.kind !== "highlight"
            ? this.runtime.openDocumentFromState(resource, snapshot.replica.store_revision, prelude)
            : this.runtime.openDocument(ref, prelude));
          acquired.push([ref, {document, captureBytes: 0, release: document.retain()}]);
        }
        if (!valid() || this.view && this.windows.size > 0 && (this.hasPendingWriting() || !this.handle?.canArrange())) return;
        if ((newRefs.length || newBindings) && (charge(new Map(acquired)) > MAX_BYTES || this.slots(next) > MAX_REFS)) {
          this.denied(parent_id); return;
        }
        for (const [ref, held] of acquired.splice(0)) this.documents.set(ref, held);
        this.configure(this.rootField);
        const initial = this.windows.size === 0;
        this.windows.clear(); for (const [id, part] of next) this.windows.set(id, part);
        for (const field of placements) if (!this.pending.rangeHeld(field.row_id) && field.parent_id && selected.has(field.parent_id) && next.get(field.parent_id) === selected.get(field.parent_id) && this.sourceConfirmed(field, next)) {
          const current = this.pending.fields.get(field.row_id)!;
          this.pending.fields.set(field.row_id, {...current, relocating: undefined, previousParent: undefined, previousParentRef: undefined});
        }
        for (const part of accepted) {
          if (part.request) part.request.foreground = false;
          if (part.request?.navigation) this.requests.set(part.id, {...part.request, navigation: undefined});
          if (this.proposals.get(part.id) === part.window) this.proposals.delete(part.id);
          this.attempted.delete(part.id);
        }
        for (const part of accepted) this.admissionFailures.delete(part.id);
        installed = true;
        this.blockedRows.clear(); this.error = null; this.changed(initial ? "initial" : "projection"); this.pending.resume();
      } finally {for (const [, held] of acquired) held.release(); this.blockedRows.clear(); if (this.active) this.rebuild(); this.syncReadOnly();}
    }).catch(error => {
      failed = true;
      if (this.active && request && this.requests.get(parent_id) === request && this.versions.get(parent_id) === version) {
        const previous = this.admissionFailures.get(parent_id);
        this.admissionFailures.set(parent_id, {request, error, occurrence: previous?.request === request ? previous.occurrence : {}});
        this.notify();
      }
    }).finally(() => {
      this.scheduled.delete(parent_id);
      if (this.active) this.notify();
      this.reservedWindows = null; this.reservedBytes = 0; this.settlingRefs.clear();
      const newer = this.proposals.get(parent_id);
      if (installed && this.active) for (const [id, proposal] of this.proposals) this.resumeAdmission(id, proposal);
      else if (topologyChanged && !failed && this.active && newer === window && this.versions.get(parent_id) === version) this.resumeAdmission(parent_id, window);
      else if (newer && newer !== window && this.active && !failed) this.resumeAdmission(parent_id, newer);
      else if (released && !failed && this.active && [...this.refs(this.windows)].some(ref => !this.documents.has(ref))) {
        const current = this.requests.get(parent_id);
        if (newer === window && current === request && this.handle?.canArrange() && !this.hasPendingWriting()) this.resumeAdmission(parent_id, window);
        else if (!newer && current === request?.navigation?.previous) {const retained = this.windows.get(parent_id); if (retained) this.resumeAdmission(parent_id, retained);}
      }
    });
  }
  private reachable(candidate: ReadonlyMap<string, OutlineWindow>, entered?: Set<string>): Map<string, OutlineWindow> {
    const result = new Map<string, OutlineWindow>();
    const visit = (parent: string) => {
      entered?.add(parent);
      const window = candidate.get(parent); if (!window || result.has(parent)) return;
      result.set(parent, window);
      for (const row of window.rows) {const id = this.id(parent, row.link!.link_id); if (this.opened.has(id) && classifyOutlineOccurrence({branch: window.branch, targetRef: row.resource.ref, edgeId: row.link!.link_id}).kind === "resource") visit(id); for (const [key, embed] of this.embedded) if (embed.projection !== null && embed.owner === id) visit(key);}
      for (const row of this.pending.fields.values()) if (row.parent_id === parent && !row.hidden && this.opened.has(row.row_id)) visit(row.row_id);
    };
    visit(this.pending.root_id); for (const [key, embed] of this.embedded) if (embed.projection !== null && embed.owner === this.pending.root_id) visit(key); return result;
  }
  private parent(id: string): string | null {
    const pending = this.pending.fields.get(id); if (pending) return pending.parent_id;
    return this.rows.get(id)?.parent_id ?? this.occurrences.get(id)?.parent_id ?? this.embedded.get(id)?.owner ?? null;
  }
  private syncReadOnly(): void {
    for (const element of this.view?.dom.querySelectorAll<HTMLElement>("[data-outline-field]") ?? []) {
      const row = this.rows.get(element.dataset.outlineField!);
      const unbound = row && row.kind !== "reference" && !row.tail && !this.pending.fields.get(row.row_id)?.pending && this.binding.document(row.row_id) !== this.documents.get(row.ref ?? "")?.document;
      if (this.blockRange !== null || this.blockedRows.has(element.dataset.outlineField!) || row && !this.editableReady(row) || unbound) element.contentEditable = "false";
      else if (element.getAttribute("contenteditable") === "false" && row?.kind !== "reference") element.removeAttribute("contenteditable");
    }
  }
  private editableReady(row: OutlineRow): boolean {return row.kind !== "reference" && (row.tail || this.pending.fields.get(row.row_id)?.pending === true || row.ref !== null && this.documents.has(row.ref));}
  private retireWithdrawnPlacements(): void {
    const entered = new Set<string>(), actual = this.reachable(this.windows, entered), protectedWriting = this.protectedRows(false);
    for (const [id, field] of this.pending.fields) {
      if (!field.relocating || this.pending.rangeHeld(id) || field.pending || !field.settledRevision || !field.parent_id || entered.has(field.parent_id) || protectedWriting.has(id) || !this.sourceConfirmed(field, actual)) continue;
      let ancestor = this.parent(field.parent_id);
      while (ancestor && !entered.has(ancestor)) ancestor = this.parent(ancestor);
      const proof = ancestor ? actual.get(ancestor) : null;
      // A visible parent with no first window proves nothing about its children.
      // An installed ancestor proof can retire projection intent, not membership.
      if (!ancestor || !proof || !this.compatibleWindow(ancestor, proof) || BigInt(proof.data.store_revision) < BigInt(field.settledRevision)) continue;
      this.pending.fields.set(id, {...field, relocating: undefined, previousParent: undefined, previousParentRef: undefined});
    }
  }
  private rebuild(reason: ProjectionReason = "projection"): void {
    this.retireWithdrawnPlacements();
    if (this.view && this.windows.size > 0 && reason === "projection" && (this.hasPendingWriting() || !this.handle?.canArrange())) {this.deferred = true; this.syncMetadata(); return;}
    this.deferred = false;
    for (const row of this.rows.values()) this.occurrences.set(row.row_id, row);
    const protectedRows = this.protectedRows(), previousRows = new Map(this.rows), historyOccurrences = this.history.retainedOccurrences();
    for (const [id, field] of this.pending.fields) if (!field.pending && !field.relocating && field.link) {
      const window = this.windows.get(field.parent_id!);
      const acknowledged = !!field.settledRevision && !!window && BigInt(window.data.store_revision) >= BigInt(field.settledRevision);
      const present = window?.rows.some(row => row.link?.link_id === field.link!.link_id) === true;
      const unused = field.settledRevision !== undefined && !previousRows.has(id) && !protectedRows.has(id) && !historyOccurrences.has(id);
      if (!this.pending.rangeHeld(id) && (unused || (field.hidden ? acknowledged : present))) this.pending.fields.delete(id);
    }
    this.rows.clear();
    const root = this.pending.root_id;
    if (this.rootField && (this.documents.has(this.rootRef) || this.pending.fields.get(root)?.pending)) this.rows.set(root, {row_id: root, ref: this.rootRef, link: null, parent_id: null, parent_ref: this.rootRef,
      depth: 0, branch: this.rootBranch, resource: this.windows.get(root)?.rootResource ?? null, kind: this.rootRef.startsWith("page:") ? "title" : "body", children: null, open: true, terminal: false, root: true, tail: false, origin: this.origin(root)});
    let tailSlots = Math.max(0, MAX_REFS - this.refs().size - this.pending.provisionalCount());
    const collect = (parent_id: string, ref: string, branch: OutlineBranch, depth: number) => {
      const window = this.windows.get(parent_id), parent = this.rows.get(parent_id);
      const siblings: OutlineRow[] = (window?.rows ?? []).flatMap<OutlineRow>(item => {
        const link = item.link!, moving = [...this.pending.fields.values()].find(row => row.relocating && row.parent_id === parent_id && row.ref === item.resource.ref);
        // Links are undirected: a window read through a request that excludes a former edge lists the parent's own entering edge. It is never a child.
        if (parent?.link?.link_id === link.link_id) return [];
        let id = moving?.row_id ?? this.id(parent_id, link.link_id);
        const terminal = classifyOutlineOccurrence({branch, targetRef: item.resource.ref, edgeId: link.link_id}).kind === "reference";
        const withdrawal = [...this.pending.fields.values()].find(row => row.relocating && row.previousParent === parent_id && row.previousParentRef === ref && row.ref === item.resource.ref && row.parent_id !== parent_id);
        if (withdrawal && !this.sourceConfirmed(withdrawal, this.windows)) return [];
        const override = this.pending.fields.get(id);
        if (override && override.parent_id !== parent_id) {id = crypto.randomUUID(); this.identities.set(`${parent_id}/${link.link_id}`, {id, origin: this.history.typingOrigin()});}
        if (moving) this.identities.set(`${parent_id}/${link.link_id}`, {id, origin: moving.origin});
        const row: OutlineRow = {row_id: id, ref: item.resource.ref, link, parent_id, parent_ref: ref, depth, branch, resource: item.resource,
          kind: terminal || item.resource.kind !== "note" && item.resource.kind !== "page" ? "reference" : item.resource.kind === "page" ? "title" : "body",
          children: null, open: this.opened.has(id), terminal, root: false, tail: false, origin: this.origin(id)};
        row.children = this.childProof(row, window);
        return row;
      });
      for (const pending of this.pending.fields.values()) if (pending.parent_id === parent_id) {
        const at = siblings.findIndex(row => row.row_id === pending.row_id);
        if (pending.hidden) {if (at >= 0) siblings.splice(at, 1); continue;}
        if (at >= 0 && !pending.relocating) continue;
        const existing = at >= 0 ? siblings.splice(at, 1)[0] : null;
        const after = pending.after_id === null ? siblings.length - 1 : siblings.findIndex(row => row.row_id === pending.after_id);
        const before = pending.before_id ? siblings.findIndex(row => row.row_id === pending.before_id) : -1;
        siblings.splice(before >= 0 ? before : after >= 0 ? after + 1 : siblings.length, 0, {row_id: pending.row_id, ref: pending.ref, link: pending.link, parent_id, parent_ref: pending.parent_ref, depth, branch,
          resource: pending.resource ?? existing?.resource ?? null, kind: pending.kind, children: existing?.children ?? null, open: this.opened.has(pending.row_id), terminal: existing?.terminal ?? false, root: false, tail: false, origin: pending.origin});
      }
      if ([...this.pending.fields.values()].some(row => row.parent_id === parent_id && row.relocating)) {
        const rank = new Map(this.pending.order.map((id, index) => [id, index]));
        siblings.sort((a, b) => (rank.get(a.row_id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.row_id) ?? Number.MAX_SAFE_INTEGER));
      }
      if (window?.beforeEdge) this.rows.set(`before:${parent_id}`, {row_id: `before:${parent_id}`, ref: null, link: null, parent_id, parent_ref: ref, depth, branch,
        resource: null, kind: "reference", children: null, open: false, terminal: false, root: false, tail: false, gap: "before", origin: null});
      for (const row of siblings) {
        if (this.filter.trim() && !this.bodyMatches(row) && !protectedRows.has(row.row_id)) continue;
        this.rows.set(row.row_id, row);
        for (const [id, embedded] of this.embedded) if (embedded.projection !== null && embedded.owner === row.row_id) collect(id, embedded.projection.ref, embedded.projection.branch, depth + 1);
        if (row.open && !row.terminal) {
          const entered = row.ref ? enterOutlineOccurrence({branch, ref: row.ref, target: {kind: "occurrence", key: row.row_id}, edgeIds: row.link ? [row.link.link_id] : []}) : branch;
          const existing = this.requests.get(row.row_id);
          if (!existing && row.resource && row.link && row.ref) {
            this.requests.set(row.row_id, {parent_id: row.row_id, ref: row.ref, branch: entered, cursor: null, anchor: null,
              limit: Math.max(1, Math.min(48, MAX_REFS - this.refs().size - 3))});
            this.attempted.add(row.row_id); this.notify();
          } else if (existing && row.link && !existing.branch.traversedEdgeIds.has(row.link.link_id)) {
            // A row open before its move keeps a request built on its former edge; the window must exclude the current one.
            this.request({...existing, navigation: undefined, branch: entered, cursor: null, anchor: null}); this.notify();
          }
          collect(row.row_id, row.ref ?? row.parent_ref, entered, depth + 1);
        }
      }
      if (window?.afterEdge) this.rows.set(`after:${parent_id}`, {row_id: `after:${parent_id}`, ref: null, link: null, parent_id, parent_ref: ref, depth, branch,
        resource: null, kind: "reference", children: null, open: false, terminal: false, root: false, tail: false, gap: "after", origin: null});
      else if (window && !this.filter.trim() && tailSlots > 0) {
        const id = this.tailId(parent_id);
        if (!this.pending.fields.has(id)) {tailSlots--; this.rows.set(id, {row_id: id, ref: null, link: null, parent_id, parent_ref: ref, depth, branch, resource: null,
          kind: "body", children: null, open: false, terminal: false, root: false, tail: true, origin: this.origin(id)});}
      }
      else if (window && !this.filter.trim()) this.rows.set(`tail:${parent_id}`, {row_id: `tail:${parent_id}`, ref: null, link: null, parent_id, parent_ref: ref, depth, branch,
        resource: null, kind: "reference", children: null, open: false, terminal: false, root: false, tail: false, gap: "tail", origin: null});
    };
    collect(root, this.rootRef, this.rootBranch, 0);
    for (const [id, embedded] of this.embedded) if (embedded.projection !== null && embedded.owner === root) collect(id, embedded.projection.ref, embedded.projection.branch, 1);
    if (reason === "projection" && [...protectedRows].some(id => previousRows.has(id) && !this.rows.has(id))) {
      this.rows.clear(); for (const [id, row] of previousRows) this.rows.set(id, row);
      this.deferred = true; return;
    }
    for (const row of this.rows.values()) {
      const descriptor = this.childDescriptor(row);
      if (row.children?.descriptor !== descriptor) row.children = null;
      const proof = (previousRows.get(row.row_id) ?? this.occurrences.get(row.row_id))?.children;
      if (proof && descriptor !== null) {
        const newer = !row.children || BigInt(proof.store_revision) > BigInt(row.children.store_revision);
        if (proof.descriptor === descriptor && (newer || row.children?.available === null && proof.store_revision === row.children.store_revision)) row.children = proof;
        // Relocation invalidates availability, but an older admitted window
        // must not resurrect a proof already superseded before relocation.
        else if (newer) row.children = {descriptor, store_revision: proof.store_revision, available: null};
      }
    }
    if (reason === "semantic" && this.blockRange) {
      const previous = this.blockRange, row_ids = previous.row_ids.filter(id => this.rows.has(id) && !this.pending.fields.get(id)?.hidden);
      if (row_ids.length) {
        this.blockRange = {anchor_id: row_ids.includes(previous.anchor_id) ? previous.anchor_id : row_ids[0]!,
          head_id: row_ids.includes(previous.head_id) ? previous.head_id : row_ids[row_ids.length - 1]!, row_ids};
        this.selectionRow = this.blockRange.head_id;
        if (row_ids.length !== previous.row_ids.length) this.announceSelection();
      } else {
        this.blockRange = null; this.selectionRow = null; this.announcement = ""; this.handle?.setInputMode("text");
      }
    }
    this.pending.order = [...this.rows.values()].filter(row => !row.root).map(row => row.row_id).concat(this.pending.order.filter(id => !this.rows.has(id) && this.pending.fields.get(id)?.pending));
    const fields = new Map<string, OutlineBindingField>();
    for (const row of this.rows.values()) if (!row.root && this.editableReady(row) && !this.blockedRows.has(row.row_id)) fields.set(row.row_id, this.field(row.row_id));
    this.binding.update(fields, historyOccurrences);
    const keepRows = new Set([...this.rows.keys(), ...this.opened, ...this.pending.fields.keys(), ...[...this.pending.fields.values()].flatMap(row => [row.parent_id, row.after_id, row.before_id].filter((id): id is string => id !== null && id !== undefined)),
      ...[...this.embedded.values()].filter(embed => embed.projection !== null).map(embed => embed.owner), ...this.binding.capturedRows(), ...this.history.retainedRows(), ...this.selected, ...(this.view?.hasFocus() && this.selectionRow ? [this.selectionRow] : [])]);
    for (const [id, ownerIds] of this.workOwners) {
      if (this.workGuard.hasWork({scopes: [], ownerIds})) keepRows.add(id);
      else if (!this.rows.has(id)) this.workOwners.delete(id);
    }
    for (const row of this.rows.values()) this.occurrences.set(row.row_id, row);
    for (const id of [...keepRows]) {let parent = this.parent(id); while (parent) {keepRows.add(parent); parent = this.parent(parent);}}
    for (const [key, row] of this.identities) if (!keepRows.has(row.id)) this.identities.delete(key);
    for (const [id, embedded] of this.embedded) if (embedded.projection === null && !keepRows.has(id)) this.embedded.delete(id);
    for (const id of this.occurrences.keys()) if (!keepRows.has(id)) this.occurrences.delete(id);
    for (const row of this.rows.values()) if (row.ref && this.documents.has(row.ref) && !this.historyLeases.has(row.ref))
      this.historyLeases.set(row.ref, this.history.editor(this.documents.get(row.ref)!.document).retain());
    this.incidence = new Map();
    const incident = (ref: string, link: string) => {const links = this.incidence.get(ref) ?? new Set<string>(); links.add(link); this.incidence.set(ref, links);};
    for (const window of this.windows.values()) for (const item of window.rows) if (item.link) incident(item.resource.ref, item.link.link_id);
    for (const field of this.pending.fields.values()) if (field.ref && !field.hidden) incident(field.ref, field.link?.link_id ?? field.row_id);
    const order = [...this.rows.keys()], previousOrder = [...previousRows.keys()];
    if (order.length !== previousOrder.length || order.some((id, at) => id !== previousOrder[at] || this.rows.get(id)!.depth !== previousRows.get(id)!.depth || this.rows.get(id)!.parent_id !== previousRows.get(id)!.parent_id)) this.epochCount++;
    this.project(reason); this.syncMetadata(); this.tryFocus();
    const placing = this.placing;
    if (placing && this.windows.has(placing.destination.parent_id)) {
      this.placing = null;
      const first = [...this.rows.values()].find(row => row.parent_id === placing.destination.parent_id && !row.tail && !row.gap);
      const plan = this.plan("place", {kind: "blocks", anchor_id: placing.rows[0]!, head_id: placing.rows[placing.rows.length - 1]!, row_ids: placing.rows}, {...placing.destination, before_id: first?.row_id ?? null});
      if (plan) this.submitRange(plan);
    } else if (placing && (this.epoch !== placing.epoch || !this.rows.get(placing.destination.parent_id)?.open)) this.placing = null;
  }
  private bodyMatches(row: OutlineRow): boolean {return [row.resource?.title, row.resource?.body_text, row.resource?.selection?.quote_exact].some(text => text?.toLocaleLowerCase().includes(this.filter.trim().toLocaleLowerCase()));}
  private doc(): PMNode {
    return outlineEditorSchema.topNodeType.create(null, [...this.rows.values()].filter(row => !row.root).map(row => {
      const attrs = {row_id: row.row_id, depth: row.depth};
      if (row.kind === "reference") return outlineEditorSchema.nodes.reference_row!.create(attrs);
      const preserve = this.blockedRows.has(row.row_id) || !this.pending.fields.get(row.row_id)?.pending && !row.tail && (!this.editableReady(row) || this.binding.document(row.row_id) === null);
      const displayed = preserve && this.view ? fieldById(this.view.state.doc, row.row_id) : null;
      const body = displayed ? displayed.kind === "body" ? canonicalBody(displayed) : bodyText(plainTitle(displayed)) : this.pending.fields.get(row.row_id)?.pending ? this.body(row.row_id) : this.binding.body(row.row_id);
      return row.kind === "title" ? outlineEditorSchema.nodes.title_row!.create(attrs, clipboardPlainText(noteBodySchema.nodeFromJSON(body.body_pm_json).content) ? outlineEditorSchema.text(clipboardPlainText(noteBodySchema.nodeFromJSON(body.body_pm_json).content)) : null)
        : outlineEditorSchema.nodes.note_row!.create(attrs, outlineEditorSchema.nodeFromJSON(body.body_pm_json));
    }));
  }
  /** The descendant host supplies its tail tab entry; item text is entered explicitly.
   * Changing this hidden selection never focuses or creates another host. */
  private setNativeEntry(tr: Transaction): boolean {
    const row = [...this.rows.values()].find(row => row.tail && row.parent_id === this.pending.root_id && this.editableReady(row));
    const field = row ? fieldById(tr.doc, row.row_id) : null;
    if (!field) return false;
    this.selectionRow = field.row_id; this.selection = {anchor: 1, head: 1};
    tr.setSelection(TextSelection.create(tr.doc, field.from));
    return true;
  }
  private restoreNativeEntry(): void {
    if (!this.view || this.selected.size || !this.handle?.canArrange()) return;
    const tr = this.view.state.tr.setMeta(outlineTransactionSource, "projection");
    if (this.setNativeEntry(tr)) {this.view.dispatch(tr); this.armNativeEntry();}
  }
  /** initial view population bypasses input admission without being an edit.
   * semantic commands have already reconciled input; refresh must wait. */
  private project(reason: ProjectionReason = "projection"): void {
    if (!this.view || reason === "projection" && !this.handle?.canArrange()) return;
    const next = this.doc();
    const start = this.view.state.doc.content.findDiffStart(next.content);
    if (start === null) return;
    const end = this.view.state.doc.content.findDiffEnd(next.content)!, overlap = Math.max(0, start - Math.min(end.a, end.b));
    // Isolating row wrappers belong to this projection. A partial cross-row
    // slice enters the input fitter and can duplicate a wrapper's occurrence.
    const first = this.view.state.doc.resolve(start), oldEnd = this.view.state.doc.resolve(end.a + overlap), newEnd = next.resolve(end.b + overlap);
    const from = first.depth ? first.before(1) : start;
    const to = oldEnd.depth ? oldEnd.after(1) : end.a + overlap;
    const contentEnd = newEnd.depth ? newEnd.after(1) : end.b + overlap;
    const active = this.selectionRow, selection = this.selection;
    const tr = this.view.state.tr.replaceWith(from, to, next.content.cut(from, contentEnd)).setMeta(outlineTransactionSource, reason === "semantic" ? "semantic" : "projection");
    const field = active ? fieldById(tr.doc, active) : null;
    if (active && this.selected.size) {
      tr.doc.forEach((node, at) => {if (node.attrs.row_id === active) tr.setSelection(NodeSelection.create(tr.doc, at));});
    } else if (field) tr.setSelection(TextSelection.create(tr.doc, field.from + Math.min(field.to - field.from, selection.anchor - 1), field.from + Math.min(field.to - field.from, selection.head - 1)));
    else if (active === null && !this.selected.size && this.view.state.doc.childCount === 0) this.setNativeEntry(tr);
    this.view.dispatch(tr);
  }
  private retainField(row: OutlineRow): void {
    const document = row.ref ? this.writing(row.ref) : null;
    if (!document) throw new Error("the displayed writing is not ready for this change");
    this.pending.freeze({...this.retained(row.row_id)!, body: this.binding.body(row.row_id), pending: true}, document);
  }
  private captureField(row: OutlineRow): DisplayedWriting {
    this.retainField(row);
    const displayed = this.binding.captureDisplayed(row.row_id);
    if (!displayed) throw new Error("the displayed identities are not ready for this change");
    return displayed;
  }
  onEdit = (row_id: string, edit: NoteEdit): void => {
    const row = this.rows.get(row_id); if (!row) throw new Error("edited occurrence is not owned by this outline");
    this.titleEdited = true;
    if (row.tail && !this.pending.fields.has(row_id)) {
      this.pending.create({row_id, parent_id: row.parent_id, parent_ref: row.parent_ref, after_id: null,
        ref: null, link: null, kind: "body", body: edit.after, hidden: false, pending: true, origin: row.origin});
      this.tailIds.delete(row.parent_id!);
      return;
    }
    if (this.pending.fields.get(row_id)?.pending) this.pending.edit(row_id, edit);
    else {
      const document = row.ref ? this.documents.get(row.ref)?.document : null;
      if (!document) throw new Error("edited note is not retained");
      this.history.editor(document, row.origin).record(edit, undefined, this.pending.bookmark(this.retained(row_id)!, edit.selectionAfter) ?? undefined);
    }
  };
  itemText = (row_id: string): boolean => {
    const row = this.rows.get(row_id);
    return !!row && !row.root && !row.tail && !row.gap && !row.terminal && row.kind !== "reference";
  };
  private editableItem(row: OutlineRow): boolean {
    return this.itemText(row.row_id) && !this.blockedRows.has(row.row_id) && !!this.handle?.canArrange() && this.editableReady(row) &&
      (this.pending.fields.get(row.row_id)?.pending === true || this.binding.document(row.row_id) === this.documents.get(row.ref ?? "")?.document);
  }
  keys = (row_id: string): StructuralKeys | null => {
    const row = this.rows.get(row_id); if (!row || row.root || row.gap || this.filter.trim() || this.blockedRows.has(row_id)) return null;
    const idle = () => this.pending.busy() ? this.pending.idle() : null;
    const arrangement: StructuralKeys = row.tail ? {idle} : {idle, indent: () => this.runRange("indent", row_id), outdent: () => this.runRange("outdent", row_id),
      move: direction => this.runRange(direction === "up" ? "move_up" : "move_down", row_id), selectBlock: () => this.selectPrepared(row_id),
      collapse: open => {if (this.hasChildren(row)) this.toggle(row_id, open);}, extendBlock: direction => this.extendBlock(row_id, direction)};
    if (row.kind === "reference") return arrangement;
    return {...arrangement, split: (left, right, displayed) => {
      if (!this.admitNew()) return;
      if (row.tail && !this.pending.fields.has(row_id)) return;
      const size = docFromBody(this.binding.body(row_id)).firstChild!.content.size;
      const from = displayed?.from ?? docFromBody(left).firstChild!.content.size, to = displayed?.to ?? size - docFromBody(right).firstChild!.content.size;
      // Flat order: the text keeps its identity. A caret at the start births an empty item above and stays; one at the end births after.
      if (from === 0 && to === 0 && size > 0) {this.born(row.parent_id!, row.parent_ref, null, row_id, true); return;}
      if (from === to && to === size) {void this.appendAfter(row); return;}
      const successor = this.pending.split(row_id, left, right, from, to, this.captureField(row));
      this.changed("semantic"); void this.focus(successor, {anchor: 1, head: 1});
    }, enter: () => {void this.appendAfter(row);}, emptyEnter: () => {
      if (row.parent_id === this.pending.root_id) return;
      this.runRange("outdent", row_id);
    },
      emptyDelete: direction => {this.removeEmpty(row_id, direction);}, join: direction => {this.join(row_id, direction);}};
  };
  private born(parent_id: string, parent_ref: string, after_id: string | null, before_id?: string, stays = false): string {
    const id = crypto.randomUUID();
    this.pending.create({row_id: id, parent_id, parent_ref, after_id, before_id, ref: null, link: null, kind: "body", body: emptyBody(), hidden: false, pending: true, origin: this.origin(id)}, this.capture(), stays);
    this.changed("semantic");
    return id;
  }
  /** Return at the end of an open loaded parent starts its first child; after_id null is last, so the first shown child anchors it. */
  private async appendAfter(row: OutlineRow): Promise<void> {
    if (!this.admitNew()) return;
    let id: string;
    if (row.open && this.windows.has(row.row_id)) {
      if (this.windows.get(row.row_id)!.beforeEdge) {this.refuse(rangeReasonMessage("gap")); return;}
      const first = [...this.rows.values()].find(child => child.parent_id === row.row_id && !child.gap && !child.tail);
      id = this.born(row.row_id, row.ref!, null, first?.row_id);
    } else id = this.born(row.parent_id!, row.parent_ref, row.row_id);
    await this.focus(id, {anchor: 1, head: 1});
  }
  /** Proven children: a window proof, shown rows in its window, or a pending field under it; an open request alone proves nothing. */
  private hasChildren(row: OutlineRow): boolean {
    return row.children?.available === true || (this.windows.get(row.row_id)?.rows.length ?? 0) > 0 || [...this.pending.fields.values()].some(field => field.parent_id === row.row_id && !field.hidden);
  }
  /** The row above in document order, past the tails; a gap row returns as itself for its refusal. */
  private previousVisible(row: OutlineRow): OutlineRow | null {
    const order = [...this.rows.values()];
    for (let at = order.indexOf(row) - 1; at >= 0; at--) {const candidate = order[at]!; if (!candidate.tail && !candidate.root) return candidate;}
    return null;
  }
  private peer(row: OutlineRow): OutlineRow | OutlineEdge | null {
    const siblings = [...this.rows.values()].filter(item => item.parent_id === row.parent_id && !item.gap && !item.tail && !item.root), at = siblings.findIndex(item => item.row_id === row.row_id);
    return siblings[at + 1] ?? this.windows.get(row.parent_id!)?.afterEdge ?? null;
  }
  /** The next sibling; one just past the window edge is shown first so a join can address it. */
  private following(row: OutlineRow): OutlineRow | null {
    const peer = this.peer(row); if (!peer) return null;
    if ("row_id" in peer) return peer;
    if (peer.resource.kind !== "note" || classifyOutlineOccurrence({branch: row.branch, targetRef: peer.resource.ref, edgeId: peer.link.link_id}).kind !== "resource") return null;
    const id = this.id(row.parent_id!, peer.link.link_id);
    this.pending.fields.set(id, {row_id: id, parent_id: row.parent_id, parent_ref: row.parent_ref, after_id: row.row_id,
      ref: peer.resource.ref, link: peer.link, kind: "body", body: emptyBody(), hidden: false, pending: false, origin: this.origin(id)});
    this.rebuild("semantic"); return this.rows.get(id) ?? null;
  }
  private join(row_id: string, direction: "backward" | "forward"): void {
    const row = this.rows.get(row_id); if (!row || row.kind !== "body") return;
    const peer = direction === "backward" ? this.previousVisible(row) : this.following(row);
    if (peer?.gap) {this.refuse(rangeReasonMessage("gap")); return;}
    if (!peer || peer.kind !== "body" || peer.terminal || peer.ref !== null && peer.ref === row.ref) return;
    const destination = direction === "backward" ? peer : row, source = direction === "backward" ? row : peer;
    if (this.hasChildren(source)) {this.refuse("join its children first"); return;}
    const displayed = {destination: this.captureField(destination), source: this.captureField(source)};
    const selection = this.pending.join(destination.row_id, source.row_id, this.capture(), displayed);
    this.changed("semantic"); void this.focus(destination.row_id, selection);
  }
  rangeSnapshot(): RangeSnapshot {
    const scope = (row: OutlineRow): string => {
      let parent = row.parent_id;
      while (parent !== null) {if (this.embedded.has(parent)) return parent; parent = this.parent(parent);}
      return this.pending.root_id;
    };
    const rows = [...this.rows.values()].map(row => ({row_id: row.row_id, ref: row.ref, link_id: row.link?.link_id ?? null,
      parent_id: row.parent_id, parent_ref: row.parent_ref, scope_id: scope(row), kind: row.kind, root: row.root, tail: row.tail,
      selectable: !row.root && !row.tail && !row.gap, eligible_parent: row.kind === "body" && !row.terminal && !row.gap,
      ready: !this.filter.trim() && !this.blockedRows.has(row.row_id) && (row.kind === "reference" || this.editableReady(row)), gap: row.gap === "before" || row.gap === "after"}));
    if (!this.rows.has(this.pending.root_id)) rows.push({row_id: this.pending.root_id, ref: this.rootRef, link_id: null, parent_id: null,
      parent_ref: this.rootRef, scope_id: this.pending.root_id, kind: "reference", root: true, tail: false, selectable: false, eligible_parent: false, ready: false, gap: false});
    for (const [id, embedded] of this.embedded) if (embedded.projection) rows.push({row_id: id, ref: embedded.projection.ref, link_id: null,
      parent_id: embedded.owner, parent_ref: embedded.projection.ref, scope_id: id, kind: "reference", root: true, tail: false, selectable: false, eligible_parent: false, ready: false, gap: false});
    return {rows};
  }
  select(row_id: string, extend = false): void {
    const input = this.activeInput();
    if (!input?.settleNativeInput() || !input.canArrange() || !this.handle?.canArrange()) return;
    this.selectPrepared(row_id, extend);
  }
  private activeInput(): TextEditorHandle | null {
    const active = document.activeElement;
    return [...this.mounts.values()].find(mount => mount.input && active !== null && mount.content.contains(active))?.input
      ?? (this.rootAttachment?.ownsFocus() ? this.rootAttachment.handle : this.handle);
  }
  private selectPrepared(row_id: string, extend = false): void {
    const snapshot = this.rangeSnapshot();
    const textRow = this.view?.hasFocus() && this.view.state.selection instanceof TextSelection ? fieldAt(this.view.state.doc, this.view.state.selection.anchor)?.row_id : null;
    const textAnchor = snapshot.rows.find(row => row.row_id === textRow && row.selectable)?.row_id;
    const anchor = extend ? this.blockRange?.anchor_id ?? textAnchor ?? row_id : row_id;
    const result = rangeSelection(snapshot, anchor, row_id);
    if (result.kind === "refusal") {this.handle?.refuse(rangeReasonMessage(result.reason)); return;}
    this.history.boundary(); this.setRange(result.selection);
  }
  private setRange(range: BlockRange, announce = true): void {
    this.blockRange = range; this.selectionRow = range.head_id; this.focused = true;
    this.handle?.setInputMode("blocks");
    if (this.view) {
      this.view.state.doc.forEach((node, at) => {if (node.attrs.row_id === range.head_id) this.view!.dispatch(this.view!.state.tr.setSelection(NodeSelection.create(this.view!.state.doc, at)));});
      this.view.dom.focus({preventScroll: true}); this.view.focus();
    }
    if (announce) this.announceSelection();
    this.syncMetadata(); this.notify();
  }
  private announce(message: string): void {this.announcement = message; this.announcementId++;}
  private announceSelection(): void {
    const count = this.blockRange?.row_ids.length ?? 0;
    this.announce(`${count} ${count === 1 ? "item" : "items"} selected`);
  }
  /** One spoken event per placement gesture; it replaces the selection count. */
  private placed(plan: RangePlan): string {
    const count = plan.changes.length, merged = plan.changes.filter(change => change.merged);
    if (plan.changes.some(change => change.mirror)) return count === 1 ? "linked here too" : `linked ${count} items here too`;
    if (!merged.length) return count === 1 ? "moved" : `moved ${count} items`;
    const into = this.rows.get(merged[0]!.after!.parent_id), parent = into && !into.root ? this.label(into) : "this outline";
    return count === 1 ? `moved; it was already under ${parent}` : `moved ${count} items; ${merged.length} already under ${parent}`;
  }
  private refuse(message: string): void {
    if (this.handle) this.handle.refuse(message); else {this.error = new OutlineActionRefusal({fact: "couldn’t change this outline.", reason: message}); this.notify();}
  }
  /** The adjacent selectable or gap row in the same scope. */
  private neighbour(row_id: string, direction: "up" | "down"): SelectionRow | undefined {
    const snapshot = this.rangeSnapshot(), scope = snapshot.rows.find(row => row.row_id === row_id)?.scope_id;
    const order = snapshot.rows.filter(row => row.scope_id === scope && (row.selectable || row.gap));
    return order[order.findIndex(row => row.row_id === row_id) + (direction === "up" ? -1 : 1)];
  }
  private extendBlock(row_id: string, direction: "up" | "down"): void {
    const next = this.neighbour(row_id, direction);
    if (next?.gap) {this.refuse(rangeReasonMessage("gap")); return;}
    this.selectPrepared(row_id);
    if (next) this.selectPrepared(next.row_id, true);
  }
  private selectAll(row_id: string): void {
    const snapshot = this.rangeSnapshot(), scope = snapshot.rows.find(row => row.row_id === row_id)?.scope_id;
    const shown = snapshot.rows.filter(row => row.scope_id === scope && row.selectable);
    if (!shown.length) return;
    this.history.boundary(); this.setRange({anchor_id: shown[0]!.row_id, head_id: shown[shown.length - 1]!.row_id, row_ids: shown.map(row => row.row_id)});
  }
  private clearSelection(row_id = this.blockRange?.head_id ?? this.selectionRow): void {
    // controls retain a read-only host: firefox cannot keep glyph focus inside
    // an editable host. native tab admission or explicit text entry restores it.
    if (this.view) {
      const tr = this.view.state.tr.setMeta(outlineTransactionSource, "projection");
      if (this.setNativeEntry(tr)) this.view.dispatch(tr);
    }
    this.announcement = "";
    this.blockRange = null; this.handle?.setInputMode("controls"); this.focused = false; this.syncMetadata(); this.notify();
    if (row_id) this.mounts.get(row_id)?.leading.querySelector<HTMLElement>("[data-outline-bullet]")?.focus({preventScroll: true});
    this.armNativeEntry();
  }
  private runRange(command: RangeCommand, row_id = this.selectionRow): void {
    if (!this.handle || !row_id) return;
    const selection = this.capture();
    const plan = this.plan(command, selection ?? {kind: "blocks" as const, anchor_id: row_id, head_id: row_id, row_ids: [row_id]});
    if (plan) this.submitRange(plan);
  }
  /** The shown rows plan the gesture; while an earlier gesture is still in flight they trail it, so a refusal then is
   * provisional and the pending layer plans against its reconstruction instead, refusing from there if it must.
   * A refusal here is spoken and returns null. */
  private plan(command: RangeCommand, input: InputBookmark, destination?: Destination): RangePlan | null {
    const result = planRange(command, this.rangeSnapshot(), input, destination);
    if (result.kind === "plan") return result.plan;
    if (this.pending.busy()) return {command, changes: [], selection_before: input, selection_after: input, ...(destination ? {destination} : {})};
    this.refuse(rangeReasonMessage(result.reason)); return null;
  }
  private removeEmpty(row_id: string, direction: "backward" | "forward"): void {
    const row = this.rows.get(row_id); if (!row?.ref || row.root || row.tail || row.gap) return;
    if (this.hasChildren(row)) {this.refuse("remove its children first"); return;}
    const above = this.previousVisible(row), previous = above && !above.gap ? above : null, following = this.following(row);
    const next = direction === "backward" ? previous ?? following : following ?? previous;
    const result = planRange("remove", this.rangeSnapshot(), {kind: "text", row_id, ref: row.ref, range: this.selection, resolve: null});
    if (result.kind === "refusal") {this.handle?.refuse(rangeReasonMessage(result.reason)); return;}
    const selection_after: InputBookmark = next?.ref ? next.kind === "reference"
      ? {kind: "blocks", anchor_id: next.row_id, head_id: next.row_id, row_ids: [next.row_id]}
      : {kind: "text", row_id: next.row_id, ref: next.ref, range: direction === "forward" && next === following ? {anchor: 1, head: 1} : "end", resolve: null}
      : result.plan.selection_after;
    this.removalKey = this.removalPress;
    this.submitRange({...result.plan, selection_after});
  }
  private submitRange(plan: RangePlan): void {
    if (plan.command === "remove" && this.removalBlocked(new Set(plan.changes.map(change => change.before.row_id)))) return;
    this.pending.range(plan, {refused: this.refused});
  }
  private refused = (reason: RangeReason): void => {if (this.active) this.handle?.refuse(rangeReasonMessage(reason));};
  private unlink(row_id: string): void {
    const row = this.rows.get(row_id);
    if (!row || row.root || row.tail || !row.link && !this.pending.fields.has(row_id)) return;
    if (this.removalBlocked(new Set([row_id]))) return;
    this.pending.unlink(row_id, this.refused);
  }
  private removalBlocked(roots: ReadonlySet<string>): boolean {
    const pairs = new Set([...roots].flatMap(id => {const row = this.retained(id); return row?.ref ? [[row.ref, row.parent_ref].sort().join("\n")] : [];}));
    const affected = new Set(roots);
    for (const row of [...this.occurrences.values(), ...this.rows.values()])
      if (row.ref && pairs.has([row.ref, row.parent_ref].sort().join("\n"))) affected.add(row.row_id);
    for (const field of this.pending.fields.values()) {
      if (!field.pending || field.hidden || affected.has(field.row_id)) continue;
      let parent = field.parent_id;
      while (parent) {
        if (affected.has(parent)) {this.handle?.refuse("finish the writing in this branch before removing it"); return true;}
        parent = this.parent(parent);
      }
    }
    const owners = new Set<string>();
    for (const [id, ids] of this.workOwners) {
      let row: string | null = id;
      while (row) {if (affected.has(row)) {for (const owner of ids) owners.add(owner); break;} row = this.parent(row);}
    }
    return !this.workGuard.confirmLoss({scopes: [], ownerIds: [...owners]});
  }
  arrange(row_id: string, command: "indent" | "outdent" | "move_up" | "move_down"): void {
    const input = this.activeInput();
    if (!input?.settleNativeInput() || !input.canArrange() || !this.handle?.canArrange()) return;
    this.runRange(command, row_id);
  }
  canArrange(): boolean {return this.handle?.canArrange() === true;}
  /** The drop entry. `rows` are the lifted rows; the planner keeps the topmost and lands them in order.
   * A closed or unloaded parent opens first: a leaf's rows land at once, any other parent's as its first child once its
   * window is shown (`placing`, settled in `rebuild`). An open the window cannot hold refuses and places nothing. */
  place(rows: readonly string[], destination: Destination): void {
    if (!rows.length || !this.canArrange()) return;
    const parent = this.rows.get(destination.parent_id);
    this.placing = null;
    if (parent?.ref && !parent.root && !(parent.open && this.windows.has(parent.row_id))) {
      this.toggle(parent.row_id, true);
      if (!this.opened.has(parent.row_id)) return;
      if (parent.children?.available !== false) {this.placing = {rows, destination, epoch: this.epoch}; return;}
    }
    const plan = this.plan("place", {kind: "blocks", anchor_id: rows[0]!, head_id: rows[rows.length - 1]!, row_ids: rows}, destination);
    if (plan) this.submitRange(plan);
  }
  toggle(row_id: string, force?: boolean): void {
    const row = this.rows.get(row_id); if (!row?.ref || row.terminal) return;
    const open = force ?? !this.opened.has(row_id);
    if (open === this.opened.has(row_id)) return;
    if (!open) {
      const lease = this.lease(), descendants = this.descendants(row_id);
      const kept = this.keepReason(descendants);
      if (kept !== null) {this.error = new OutlineActionRefusal({fact: "couldn’t close this branch.", reason: kept}); this.notify(); return;}
      this.admission = this.admission.then(async () => {
        if (!this.active || !lease() || this.keepReason(descendants) !== null || !this.handle?.canArrange()) return;
        for (const id of descendants) this.blockedRows.add(id);
        this.syncReadOnly(); this.notify();
        try {
          const refs = new Set([...descendants].flatMap(id => {const ref = this.rows.get(id)?.ref; return ref ? [ref] : [];}));
          await Promise.all([...refs].map(ref => this.captureDocument(ref)));
          if (!this.active || !lease() || this.keepReason(descendants) !== null || !this.handle?.canArrange()) return;
          this.opened.delete(row_id);
          for (const id of [row_id, ...descendants]) {this.requests.delete(id); this.windows.delete(id);}
          for (const [id, embed] of this.embedded) if (embed.projection !== null && descendants.has(embed.owner)) {this.requests.delete(id); this.windows.delete(id);}
          this.changed();
          const keep = this.refs(this.windows);
          for (const [ref, held] of this.documents) if (!keep.has(ref)) {held.release(); this.documents.delete(ref); this.historyLeases.get(ref)?.(); this.historyLeases.delete(ref);}
          this.changed();
        } finally {for (const id of descendants) this.blockedRows.delete(id); this.syncReadOnly(); this.notify();}
      }).catch(error => {if (this.active) {this.error = error; this.notify();}});
      return;
    }
    const capacity = MAX_REFS - this.refs().size - 3;
    if (capacity < 1) {this.error = new OutlineActionRefusal({fact: "couldn’t open this branch.", reason: AT_LIMIT}); this.notify(); return;}
    this.opened.add(row_id);
    this.attempted.add(row_id);
    const branch = enterOutlineOccurrence({branch: row.branch, ref: row.ref, target: {kind: "occurrence", key: row_id}, edgeIds: row.link ? [row.link.link_id] : []});
    this.requests.set(row_id, {parent_id: row_id, ref: row.ref, branch, cursor: null, anchor: null, limit: Math.min(48, capacity)});
    this.changed();
  }
  private descendants(row_id: string): Set<string> {
    const descendants = new Set<string>();
    for (const candidate of this.rows.values()) {let parent = candidate.parent_id; while (parent) {if (parent === row_id) {descendants.add(candidate.row_id); break;} parent = this.parent(parent);}}
    return descendants;
  }
  private protectedBeneath(descendants: ReadonlySet<string>): boolean {
    return [...descendants].some(id => this.pending.fields.get(id)?.pending || this.pending.fields.get(id)?.relocating || this.selected.has(id) || this.view?.hasFocus() && this.selectionRow === id);
  }
  /** The fold chord addresses the topmost selection: descendants travel with their root and leave the selection first,
   * silently; then every root with children folds, closing all or nothing. */
  private foldSelection(open: boolean): void {
    const range = this.blockRange; if (!range) return;
    const roots = this.roots(), row_ids = roots.map(row => row.row_id);
    if (row_ids.length !== range.row_ids.length) this.setRange({anchor_id: row_ids.includes(range.anchor_id) ? range.anchor_id : row_ids[0]!,
      head_id: row_ids.includes(range.head_id) ? range.head_id : row_ids[row_ids.length - 1]!, row_ids}, false);
    const folding = roots.filter(row => row.ref && !row.terminal && this.hasChildren(row) && row.open !== open);
    if (!open && folding.some(root => this.protectedBeneath(this.descendants(root.row_id)))) {this.refuse("finish the writing in this branch before closing it"); return;}
    for (const root of folding) this.toggle(root.row_id, open);
  }
  /** The selected rows no selected row contains, in document order. */
  private roots(): OutlineRow[] {
    const selected = this.selected;
    return [...this.rows.values()].filter(row => {
      if (!selected.has(row.row_id)) return false;
      for (let parent = row.parent_id; parent; parent = this.parent(parent)) if (selected.has(parent)) return false;
      return true;
    });
  }
  load(parent_id: string, direction: "before" | "after"): void {
    const request = this.requests.get(parent_id), window = this.windows.get(parent_id); if (!request || !window || !this.handle?.canArrange()) return;
    const anchor = direction === "before" ? window.beforeEdge?.link.link_id ?? null : null;
    this.request({...request, cursor: direction === "after" ? window.data.next_cursor : null, anchor}, true); this.notify();
  }
  private request(request: BranchRequest, navigation: boolean | (() => boolean) = false): void {
    if (navigation) {const previous = this.requests.get(request.parent_id)!; request = {...request, navigation: {lease: typeof navigation === "function" ? navigation : this.lease(), previous: previous.navigation?.previous ?? previous}};}
    request.foreground = true;
    this.requests.set(request.parent_id, request); this.attempted.add(request.parent_id); this.versions.set(request.parent_id, (this.versions.get(request.parent_id) ?? 0) + 1); this.proposals.delete(request.parent_id);
  }
  capture(): InputBookmark {
    if (this.blockRange) return {kind: "blocks", ...this.blockRange};
    if (this.selectionRow === this.pending.root_id && this.rootAttachment) return {kind: "text", root: true, row_id: this.pending.root_id, ref: this.rootRef, range: this.selection, resolve: this.rootAttachment.handle.captureSelection()};
    const row = this.selectionRow ? this.retained(this.selectionRow) : null;
    return row?.ref ? {kind: "text", row_id: row.row_id, ref: row.ref, range: this.selection, resolve: this.handle?.captureSelection() ?? null} : null;
  }

  focus(row_id: string, selection: FocusSelection | null | ((document: WritingDocument) => FocusSelection) = "end", lease = this.lease()): Promise<void> {
    this.waiting?.resolve(); return new Promise(resolve => {this.waiting = {row_id, selection, lease, resolve}; this.tryFocus();});
  }
  private tryFocus(): void {
    const request = this.waiting; if (!request || !this.view) return;
    if (!request.lease()) {this.waiting = null; request.resolve(); return;}
    const row = this.rows.get(request.row_id);
    if (request.row_id === this.pending.root_id && this.rootField) {
      const root = this.rootAttachment;
      if (!root?.visible || !this.rootDocument) {root?.reveal(); return;}
      this.waiting = null; this.selectionRow = request.row_id; this.blockRange = null; this.announcement = ""; this.handle?.setInputMode("text");
      root.handle.focus(request.selection ?? "end"); request.resolve(); this.notify(); return;
    }
    if (request.native) {
      const field = fieldById(this.view.state.doc, request.row_id);
      if (!row || !row.tail || row.ref !== request.native.ref || field?.kind !== request.native.kind) {
        this.waiting = null; request.resolve(); return;
      }
      if (!this.view.hasFocus() || !this.handle?.canArrange()) return;
    }
    if (!this.handle?.canArrange()) return;
    if (typeof request.selection === "function") {
      const document = row?.ref ? this.documents.get(row.ref)?.document : null;
      if (!document) return;
      request.selection = request.selection(document);
    }
    if (row && row.kind !== "reference" && (!this.editableReady(row) || !row.tail && !this.pending.fields.get(row.row_id)?.pending && this.binding.document(row.row_id) !== this.documents.get(row.ref ?? "")?.document)) return;
    if (request.selection === null || row?.kind === "reference") {
      let at: number | null = null;
      this.view.state.doc.forEach((node, offset) => {if (node.attrs.row_id === request.row_id) at = offset;});
      if (at === null) return;
      this.waiting = null; this.setRange({anchor_id: request.row_id, head_id: request.row_id, row_ids: [request.row_id]}); request.resolve(); return;
    }
    const field = fieldById(this.view.state.doc, request.row_id);
    if (!field) {
      const parent = [...this.tailIds].find(([, id]) => id === request.row_id)?.[0], window = parent ? this.windows.get(parent) : null;
      const branch = parent ? this.requests.get(parent) : null;
      if (branch && window?.afterEdge && window.tailEdge && branch.anchor !== window.tailEdge.link.link_id) {this.request({...branch, cursor: null, anchor: window.tailEdge.link.link_id}, request.lease); this.notify();}
      return;
    }
    if (!row || !this.editableReady(row)) return;
    this.blockRange = null; this.handle?.setInputMode("text"); this.syncReadOnly();
    const at = request.selection === "end" ? {anchor: field.to, head: field.to} : {anchor: field.from + request.selection.anchor - 1, head: field.from + request.selection.head - 1};
    this.waiting = null; this.selectionRow = request.row_id; this.selection = request.selection === "end" ? {anchor: field.to - field.from + 1, head: field.to - field.from + 1} : request.selection;
    this.view.dispatch(this.view.state.tr.setSelection(TextSelection.create(this.view.state.doc, Math.min(field.to, at.anchor), Math.min(field.to, at.head)))); this.view.focus(); request.resolve();
  }
  rootText(): string {
    if (!this.rootAttachment) throw new Error("the root editor is not bound");
    return this.rootAttachment.handle.readText();
  }
  revealRoot(): void {this.rootAttachment?.reveal();}
  async focusRoot(resolve?: (document: WritingDocument) => FocusSelection, mayFocus?: () => boolean): Promise<void> {
    const lease = this.lease();
    if (mayFocus && !mayFocus()) return;
    this.revealRoot(); await this.focus(this.pending.root_id, resolve ?? "end", () => lease() && (mayFocus?.() ?? true));
  }
  async append(parent_id = this.pending.root_id): Promise<void> {
    const window = this.windows.get(parent_id), request = this.requests.get(parent_id), lease = this.lease();
    if (!request) return;
    if (!window) {await this.focus(this.tailId(parent_id), {anchor: 1, head: 1}, lease); return;}
    if (window.afterEdge && window.tailEdge) {this.request({...request, cursor: null, anchor: window.tailEdge.link.link_id}, true); this.notify();}
    if (!this.rows.has(this.tailId(parent_id)) && !window.afterEdge) {if (!this.admitNew()) return; this.changed("semantic");}
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
    const registration: EmbeddedBranch = {owner, projection: {ref, branch}};
    this.embedded.set(id, registration);
    this.requests.set(id, {parent_id: id, ref, branch, cursor: null, anchor: null, limit: Math.max(1, Math.min(48, MAX_REFS - this.refs().size - 3))});
    this.notify();
    return () => {
      if (this.embedded.get(id) !== registration) return;
      registration.projection = null;
      this.requests.delete(id); this.windows.delete(id); this.proposals.delete(id); this.versions.set(id, (this.versions.get(id) ?? 0) + 1); this.changed();
      const retired = [...this.documents].filter(([ref]) => !this.refs(this.windows).has(ref));
      for (const [ref] of retired) this.settlingRefs.add(ref);
      this.admission = this.admission.then(async () => {
        try {
          await Promise.all(retired.map(([ref]) => this.captureDocument(ref)));
          const keep = this.refs(this.windows);
          for (const [ref, held] of retired) if (!keep.has(ref) && this.documents.get(ref) === held && held.captureBytes === 0) {held.release(); this.documents.delete(ref); this.historyLeases.get(ref)?.(); this.historyLeases.delete(ref);}
          if (this.active) this.changed();
        } finally {for (const [ref] of retired) this.settlingRefs.delete(ref);}
      }).catch(error => {if (this.active) {this.error = error; this.notify();}});
    };
  }
  private async beforeCollapseEmbedded(scope: string): Promise<boolean> {
    const id = `embed:${scope}`, branch = this.embedded.get(id), lease = this.lease();
    if (!branch?.projection) return true;
    const descendants = new Set<string>();
    for (const row of [...this.rows.values(), ...this.pending.fields.values()]) {
      let parent = row.parent_id;
      while (parent) {if (parent === id) {descendants.add(row.row_id); break;} parent = this.parent(parent);}
    }
    const kept = this.keepReason(descendants);
    if (kept !== null || !this.handle?.canArrange()) {this.error = new OutlineActionRefusal(kept !== null ? {fact: "couldn’t close this preview.", reason: kept} : {fact: "couldn’t close this preview."}); this.notify(); return false;}
    try {
      const refs = new Set([...descendants].flatMap(row => {const ref = this.rows.get(row)?.ref; return ref ? [ref] : [];}));
      await Promise.all([...refs].map(ref => this.captureDocument(ref)));
      return this.active && lease() && this.embedded.get(id) === branch && branch.projection !== null && this.keepReason(descendants) === null && !!this.handle?.canArrange();
    } catch (error) {if (this.active) {this.error = error; this.notify();} return false;}
  }
  commandState(command: OutlineCommand) {
    if (command === "undo" || command === "redo") {
      const handle = this.selectionRow === this.pending.root_id ? this.rootAttachment?.handle : this.handle;
      const local = handle?.localHistory(command); if (local) return {enabled: local.enabled, reason: null};
      return {enabled: !!handle?.canArrange() && (command === "undo" ? this.history.canUndo() : this.history.canRedo()), reason: null};
    }
    const row = this.selectionRow ? this.rows.get(this.selectionRow) : null;
    if (!row || !this.handle?.canArrange()) return {enabled: false, reason: "select one item to arrange"};
    const input = this.blockRange ? {kind: "blocks" as const, ...this.blockRange} : {kind: "text" as const, row_id: row.row_id, ref: row.ref ?? row.parent_ref, range: this.selection, resolve: null};
    const result = planRange(command, this.rangeSnapshot(), input);
    return {enabled: result.kind === "plan", reason: result.kind === "refusal" ? rangeReasonMessage(result.reason) : null};
  }
  publication() {return this.focused || this.selected.size ? {session: `outline:${this.pending.root_id}`, touchVisible: this.selected.size > 0 || !this.touchCommandsDismissed, commandState: (command: OutlineCommand) => this.commandState(command), executeCommand: (command: OutlineCommand) => {
    if (!this.commandState(command).enabled) return;
    if (command === "undo" || command === "redo") {const handle = this.selectionRow === this.pending.root_id ? this.rootAttachment?.handle : this.handle;
      if (!handle?.settleNativeInput()) return;
      const local = handle?.localHistory(command); if (local) local.execute(); else if (command === "undo") this.history.undo(); else this.history.redo();}
    else if (this.selectionRow) this.arrange(this.selectionRow, command); this.notify();
  }} : null;}
  chrome(): ReadonlyMap<string, OutlineRowChrome> {
    return new Map([...this.rows.values()].filter(row => !row.root && !row.tail && !row.gap).map(row => [row.row_id, {row_id: row.row_id, ref: row.ref, resource: row.resource, kind: row.kind === "body" ? "note" : row.kind,
      depth: row.depth, parent_id: row.parent_id, label: this.label(row), href: this.href(row), mirrors: this.mirrors(row),
      parentLabel: row.parent_id ? this.rows.has(row.parent_id) ? this.label(this.rows.get(row.parent_id)!) : this.windows.get(row.parent_id)?.rootResource ? localResourceLabel(this.windows.get(row.parent_id)!.rootResource!) : "this outline" : "this outline",
      childrenAvailable: row.children?.available === true || this.requests.has(row.row_id), read: this.branchRead(row.row_id), open: row.open, terminal: row.terminal, selected: this.selected.has(row.row_id),
      workOwners: owners => this.workOwners.set(row.row_id, owners),
      editorReady: editor => {const mount = this.mounts.get(row.row_id); if (mount) mount.input = editor;},
      toggle: () => {this.toggle(row.row_id); this.focused = false; this.notify();}, select: () => this.select(row.row_id),
      extend: this.blockRange ? () => this.select(row.row_id, true) : null, unlink: () => this.unlink(row.row_id), reveal: () => {
        if (row.ref) {const ancestor = row.branch.ancestors.get(row.ref); if (ancestor?.kind === "root" && this.rootField) void this.focusRoot();
          else if (ancestor?.kind === "occurrence" && this.rows.has(ancestor.key)) void this.focus(ancestor.key); else if (ancestor) this.revealExternal?.(ancestor);}
      }}]));
  }
  /** The bullet's route carries the entering link so the opened outline excludes it. */
  private href(row: OutlineRow): string | null {
    const base = row.resource ? localResourceHref(row.resource) : row.ref ? `/${row.kind === "title" ? "pages" : "notes"}/${row.ref.split(":")[1]}` : null;
    if (base === null || !row.link) return base;
    const [path, hash] = base.split("#");
    return `${path}${path!.includes("?") ? "&" : "?"}via=${row.link.link_id}${hash ? `#${hash}` : ""}`;
  }
  /** Visible links on the row's resource across the loaded windows and the pending fields; 1 when unknown. */
  private mirrors(row: OutlineRow): number {return row.ref ? Math.max(1, this.incidence.get(row.ref)?.size ?? 0) : 1;}
  private label(row: OutlineRow): string {
    if (row.kind !== "reference" && (this.documents.has(row.ref ?? "") || this.pending.fields.get(row.row_id)?.pending)) {
      const text = clipboardPlainText(noteBodySchema.nodeFromJSON(this.body(row.row_id).body_pm_json).content).split("\n")[0]?.trim();
      if (text) return text;
      return row.kind === "title" ? row.resource?.local_date ?? "untitled page" : "empty note";
    }
    return row.resource ? localResourceLabel(row.resource) : row.root ? this.rootField?.label ?? "outline" : "empty note";
  }
  private nodeView = (node: PMNode): NodeView => {
    const id = String(node.attrs.row_id), dom = document.createElement("div"), guides = document.createElement("div"), head = document.createElement("div"), leading = document.createElement("div"), disclose = document.createElement("div"), content = document.createElement("div"), trailing = document.createElement("div");
    dom.className = rowStyles.row; head.className = rowStyles.head; leading.className = rowStyles.leading; trailing.className = rowStyles.trailing; content.className = rowStyles.content;
    leading.contentEditable = "false"; disclose.contentEditable = "false"; trailing.contentEditable = "false"; guides.contentEditable = "false"; content.dataset.outlineField = id;
    disclose.dataset.outlineDisclose = "true"; guides.dataset.outlineGuides = "true";
    leading.append(disclose); head.append(leading, content, trailing); dom.append(guides, head);
    dom.addEventListener("pointerdown", event => {
      const target = event.target, row = this.rows.get(id);
      if (event.button !== 0 || !(target instanceof Element) || target.closest(".ProseMirror") !== this.view?.dom || target.closest("[data-outline-occurrence]") !== dom ||
        target.closest("a[href], button, input, textarea, select, [role='button'], .note-object-embed") || !row || row.gap) return;
      if (event.shiftKey) {
        if (row.tail) return;
        if (!this.blockRange && this.view?.hasFocus() && this.view.state.selection instanceof TextSelection && fieldAt(this.view.state.doc, this.view.state.selection.anchor)?.row_id === id) return;
        event.preventDefault(); event.stopPropagation(); this.select(id, true);
      } else if (this.view?.editable === false && (this.editableItem(row) || row.tail && !this.blockedRows.has(id) && this.editableReady(row))) {
        if (!this.handle?.settleNativeInput()) {event.preventDefault(); return;}
        this.blockRange = null; this.announcement = ""; this.handle.setInputMode("text"); this.selectionRow = id; this.syncMetadata(); this.notify();
      }
    }, true);
    head.addEventListener("keydown", event => {
      const target = event.target, row = this.rows.get(id);
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.altKey || event.ctrlKey || event.metaKey ||
        !(target instanceof Element) || target.closest("[data-outline-occurrence]") !== dom || content.contains(target) || !row || !this.handle?.canArrange()) return;
      if (event.key === "F2" && !event.shiftKey && this.editableItem(row)) {
        event.preventDefault(); event.stopPropagation();
        if (!event.repeat) {this.blockRange = null; this.handle?.setInputMode("text"); void this.focus(id, "end"); this.syncMetadata(); this.notify();}
      } else if (event.key === " " && !event.shiftKey && (target === leading || target.matches("[data-outline-bullet]"))) {
        event.preventDefault(); event.stopPropagation(); if (!event.repeat) this.select(id);
      } else if (event.key === "Escape" && !event.shiftKey && this.selected.size) {
        event.preventDefault(); event.stopPropagation(); this.clearSelection(id);
      } else if (event.key === "Tab" && !this.selected.size) this.restoreNativeEntry();
    }, true);
    const sync = () => {
      const row = this.rows.get(id); if (!row) return;
      dom.dataset.outlineRow = id; dom.dataset.outlineOccurrence = id; dom.dataset.outlineKind = row.kind === "body" ? "note" : row.kind;
      dom.dataset.depth = String(row.depth); dom.style.setProperty("--outline-depth", String(row.depth));
      leading.hidden = row.tail || !!row.gap;
      leading.tabIndex = -1;
      if (!leading.hidden) {
        leading.dataset.outlineTarget = "true"; leading.setAttribute("role", "group"); leading.setAttribute("aria-label", `outline item: ${this.label(row)}`);
      } else {delete leading.dataset.outlineTarget; leading.removeAttribute("role"); leading.removeAttribute("aria-label");}
      if (this.editableItem(row)) leading.setAttribute("aria-keyshortcuts", "F2"); else leading.removeAttribute("aria-keyshortcuts");
      // the chevron leaves with its children; its focus returns to the bullet before React unmounts it.
      if (!(row.children?.available === true || this.requests.has(row.row_id)) && document.activeElement && disclose.contains(document.activeElement))
        leading.querySelector<HTMLElement>("[data-outline-bullet]")?.focus({preventScroll: true});
      trailing.hidden = this.branchRead(id).error === null && this.mirrors(row) <= 1;
      if (row.ref) dom.dataset.resourceRef = row.ref; else delete dom.dataset.resourceRef;
      if (row.parent_id) dom.dataset.parentRow = row.parent_id;
      const ancestors: OutlineRow[] = [];
      for (let parent = row.parent_id ? this.rows.get(row.parent_id) : undefined; parent && !parent.root; parent = parent.parent_id ? this.rows.get(parent.parent_id) : undefined) ancestors.unshift(parent);
      // the return anchor is the occurrence's link path: unique when a parent shows twice, stable across a remount.
      if (row.link) dom.dataset.noteBlockId = [...ancestors.map(ancestor => ancestor.link?.link_id ?? ancestor.row_id), row.link.link_id].join("/"); else delete dom.dataset.noteBlockId;
      // one guide per ancestor at the ancestor's depth; a click closes that ancestor. none is accessible: the chevron is.
      const chain = ancestors.map(ancestor => ancestor.row_id).join("/");
      if (guides.dataset.chain !== chain) {
        guides.dataset.chain = chain;
        guides.replaceChildren(...ancestors.map(ancestor => {
          const guide = document.createElement("span");
          guide.dataset.outlineGuide = ancestor.row_id; guide.style.setProperty("--outline-guide-depth", String(ancestor.depth)); guide.setAttribute("aria-hidden", "true");
          guide.onclick = () => {this.toggle(ancestor.row_id, false); this.focused = false; this.notify();};
          return guide;
        }));
      }
      if (row.tail) {
        dom.dataset.outlineInput = "true"; dom.dataset.outlineTail = "true";
        content.dataset.empty = String(node.firstChild?.content.size === 0); content.dataset.placeholder = "write or @ to link";
      } else {delete dom.dataset.outlineInput; delete dom.dataset.outlineTail; delete content.dataset.empty; delete content.dataset.placeholder;}
      if (this.pending.fields.get(id)?.pending) dom.dataset.outlinePending = "true"; else delete dom.dataset.outlinePending;
      if (this.selected.has(id)) dom.dataset.selected = "true"; else delete dom.dataset.selected;
      if (this.focused && !this.blockRange && this.selectionRow === id) dom.dataset.outlineActive = "true"; else delete dom.dataset.outlineActive;
      if (row.gap && content.dataset.gap !== row.gap) {
        content.dataset.gap = row.gap;
        content.contentEditable = "false"; const button = document.createElement("button"); button.type = "button";
        button.className = rowStyles.control;
        button.textContent = row.gap === "before" ? "show earlier items" : row.gap === "after" ? "show more items" : "write at end";
        if (row.gap === "tail") button.onclick = () => {void this.append(row.parent_id!);};
        else {const direction = row.gap; button.onclick = () => this.load(row.parent_id!, direction);}
        if (row.gap === "after") {const append = document.createElement("button"); append.type = "button"; append.className = rowStyles.control; append.textContent = "write at end"; append.onclick = () => {void this.append(row.parent_id!);}; content.replaceChildren(button, append);}
        else content.replaceChildren(button);
      }
      else if (row.kind === "reference" && !row.gap) content.contentEditable = "false";
    };
    const mount: OutlineRowMount & {sync(): void} = {row_id: id, dom, leading, disclose, trailing, content, input: null, openMenu: null, sync};
    sync(); this.mounts.set(id, mount); this.notify();
    return {dom, ...(node.type.name !== "reference_row" ? {contentDOM: content} : {}), update: next => {if (next.type !== node.type || next.attrs.row_id !== id) return false; node = next; sync(); return true;},
      stopEvent: event => event.target instanceof Node && (leading.contains(event.target) || trailing.contains(event.target) || guides.contains(event.target) || this.rows.get(id)?.kind === "reference"),
      ignoreMutation: mutation => mutation.type !== "selection" && (!content.contains(mutation.target) || mutation.type === "attributes" && mutation.target === content || this.rows.get(id)?.kind === "reference"),
      destroy: () => {if (this.mounts.get(id) === mount) {this.mounts.delete(id); this.notify();}}};
  };
  inertInput(event: Event): boolean {
    if (!this.blockRange || !(event.target instanceof Element) || event.target.closest(".ProseMirror") !== this.view?.dom ||
      event.target.closest("button, a[href], input, textarea, select, .note-object-embed")) return false;
    if (event instanceof InputEvent) return event.inputType !== "historyUndo" && event.inputType !== "historyRedo";
    if (!(event instanceof KeyboardEvent)) return false;
    if (outlineHistoryCommand(event, this.platform) || outlineStructuralCommand(event, this.platform) || outlineFoldCommand(event, this.platform)) return false;
    if (event.shiftKey && ["Delete", "Backspace", "Escape", "F2"].includes(event.key)) return true;
    const active = this.selectionRow ? this.rows.get(this.selectionRow) : null;
    if (event.key === "F2" && (!active || !this.editableItem(active))) return true;
    if (["ArrowUp", "ArrowDown", "Delete", "Backspace", "Escape", "F2"].includes(event.key) && !event.metaKey && !event.ctrlKey && !event.altKey) return false;
    const primary = usesMeta(this.platform) ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
    if (primary && event.shiftKey && !event.altKey && ["ArrowLeft", "ArrowRight"].includes(event.key)) return false;
    if (!usesMeta(this.platform) && event.altKey && !event.metaKey && !event.ctrlKey && ["ArrowLeft", "ArrowRight", "Home"].includes(event.key)) return false;
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown", "Backspace", "Delete", "Enter"].includes(event.key)) return true;
    return !event.metaKey && !event.ctrlKey && !event.altKey || primary && !event.altKey && (event.shiftKey
      ? event.key.toLowerCase() === "s" : ["a", "b", "i", "u", "e", "c"].includes(event.key.toLowerCase()));
  }
  private releaseRemoval = (event?: Event): void => {
    if (!(event instanceof KeyboardEvent) || event.key === this.removalKey || event.key === this.removalPress) {this.removalKey = null; this.removalPress = null;}
  };
  private removalFence = (event: Event): void => {
    if (!this.removalKey || !(event.target instanceof Element) || !event.target.closest(`[data-outline-session="${this.pending.root_id}"]`)) return;
    if (event instanceof KeyboardEvent ? event.key === this.removalKey : event instanceof InputEvent && event.inputType.startsWith("delete")) {
      event.preventDefault(); event.stopImmediatePropagation();
    }
  };
  private blockInput = (event: Event): void => {
    if (!this.blockRange || !(event.target instanceof Element) || event.target.closest(".ProseMirror") !== this.view?.dom) return;
    if (event.target.closest("button, a[href], input, textarea, select, .note-object-embed")) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (event instanceof InputEvent && (event.inputType === "historyUndo" || event.inputType === "historyRedo")) {
      if (event.inputType === "historyUndo") this.history.undo(); else this.history.redo();
    }
  };
  /** With items selected the focused outline owns the clipboard wherever the browser aims its events; cancelling a
   * before-event is what lets chromium fire copy, cut and paste over read-only rows. */
  private blockClipboard = (event: Event): void => {
    const active = document.activeElement, view = this.view?.dom;
    if (!this.blockRange || !active || !view?.contains(active)) return;
    // a field or an embedded outline inside the view keeps its own clipboard; row chrome does not.
    const inner = active.closest("input, textarea, select, .note-object-embed");
    if (inner && view.contains(inner)) return;
    if (event.type.startsWith("before")) {event.preventDefault(); return;}
    if (!(event instanceof ClipboardEvent)) return;
    if (event.type === "paste") this.paste(event);
    else if (event.type === "copy") {const count = this.copy(event); if (count) {this.announce(count === 1 ? "copied" : `copied ${count} items`); this.notify();}}
    else {
      // a cut plans its remove before it writes, so a refused one leaves the clipboard as it was; the remove's receipt speaks for both.
      const cut = this.capture(), plan = this.plan("remove", cut);
      if (!plan || this.removalBlocked(new Set(plan.changes.map(change => change.before.row_id)))) event.preventDefault();
      else if (this.copy(event)) {this.cutting = cut; this.pending.range(plan, {refused: this.refused});}
    }
    event.stopImmediatePropagation();
  };
  private blockKey = (event: KeyboardEvent): void => {
    if (event.target instanceof Element && event.target.closest(".ProseMirror") === this.view?.dom &&
      !event.target.closest("button, a[href], input, textarea, select, .note-object-embed") &&
      !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && (event.key === "Delete" || event.key === "Backspace")) this.removalPress = event.key;
    if (!this.blockRange || !(event.target instanceof Element) || event.target.closest(".ProseMirror") !== this.view?.dom || event.target.closest("button, a[href], input, textarea, select, .note-object-embed")) return;
    const history = outlineHistoryCommand(event, this.platform), structural = outlineStructuralCommand(event, this.platform), fold = outlineFoldCommand(event, this.platform);
    const key = event.key.toLowerCase(), primary = usesMeta(this.platform) ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
    if (event.metaKey || event.ctrlKey || event.altKey) {
      if (!history && !structural && !fold && (!this.inertInput(event) || key === "c")) return;
    }
    if (["Shift", "Control", "Meta", "Alt", "AltGraph"].includes(event.key)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (event.isComposing || event.keyCode === 229) return;
    if (history) {if (!event.repeat) {if (history === "undo") this.history.undo(); else this.history.redo();} return;}
    if (structural) {if (!event.repeat && this.selectionRow) this.arrange(this.selectionRow, structural); return;}
    if (fold) {if (!event.repeat) this.foldSelection(fold === "expand"); return;}
    if (primary && !event.altKey && !event.shiftKey && key === "a") {if (!event.repeat) this.selectAll(this.blockRange.head_id); return;}
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey && event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    if (event.key === "Delete" || event.key === "Backspace") {
      if (!event.repeat) {this.removalKey = event.key; this.runRange("remove");}
      return;
    }
    if (event.key === "Escape") {this.clearSelection(); return;}
    if (event.key === "Enter") {
      const row = this.rows.get(this.blockRange.row_ids[0]!);
      if (!event.repeat && row && this.editableItem(row)) {this.announcement = ""; void this.focus(row.row_id, "end");}
      return;
    }
    if (event.key === "F2") {
      const row = this.selectionRow ? this.rows.get(this.selectionRow) : null;
      if (!event.repeat && row && this.editableItem(row)) {this.announcement = ""; void this.focus(row.row_id, "end");}
      return;
    }
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      const next = this.neighbour(this.blockRange.head_id, event.key === "ArrowUp" ? "up" : "down");
      if (next?.gap) this.refuse(rangeReasonMessage("gap")); else if (next) this.selectPrepared(next.row_id, event.shiftKey);
    }
  };
  private syncMetadata(): void {for (const mount of this.mounts.values()) mount.sync(); this.syncReadOnly();}
  readonly projection: NoteEditorProjection = {
    schema: outlineEditorSchema, doc: () => this.doc(), binding: this.binding,
    nodeViews: {note_row: this.nodeView, title_row: this.nodeView, reference_row: this.nodeView},
    plugins: [new Plugin({props: {handleDOMEvents: {
      paste: (_view, event) => this.paste(event),
    }}})], keys: this.keys, itemText: this.itemText, onFocus: () => {if (this.waiting?.native) this.tryFocus();},
    onEdit: this.onEdit, onSelectionChange: this.onSelectionChange, onViewReady: view => this.setView(view),
    context: row_id => {
      const row = this.rows.get(row_id), parent = row?.branch ?? this.rootBranch;
      const branch = row?.ref && !parent.ancestors.has(row.ref) ? enterOutlineOccurrence({branch: parent, ref: row.ref, target: {kind: "occurrence", key: row_id}, edgeIds: row.link ? [row.link.link_id] : []}) : parent;
      return {branch, occurrenceKey: row_id, containingNoteRef: row?.ref ?? null, beforeCollapse: scope => this.beforeCollapseEmbedded(scope)};
    },
    reference: row_id => {
      const row = this.rows.get(row_id); if (!row) return null;
      const parent_ref = row.root ? this.rootRef : row.parent_ref;
      return {source_ref: parent_ref, label: parent_ref, onSelected: (target, item) => {
        const bookmark = this.capture();
        const admitted = this.history.insertReference({placement: {parent_ref, parent: this.writing(parent_ref),
          after_ref: row.root || row.tail ? null : row.ref, before_ref: null}, target, label: item.label,
          change: {before: bookmark, after: bookmark}});
        void admitted.result.catch(error => {this.error = error; this.notify();});
      }};
    },
  };
  /** Writes the selection by reference with indented text for other apps; the count is of its topmost items. */
  private copy(event: ClipboardEvent): number {
    if (!this.selected.size || !event.clipboardData) return 0;
    const rows = [...this.rows.values()].filter(row => this.selected.has(row.row_id) && !row.tail && !row.gap && (row.kind === "body" || row.ref)), items: ClipItem[] = [];
    for (const row of rows) {
      const parent = rows.findIndex(candidate => candidate.row_id === row.parent_id);
      items.push(row.kind === "body" ? {kind: "note", ref: row.ref, body: this.pending.fields.get(row.row_id)?.pending ? this.body(row.row_id) : this.binding.body(row.row_id), parent: parent < 0 ? null : parent}
        : {kind: "resource", ref: row.ref!, label: row.resource ? localResourceLabel(row.resource) : row.ref!, parent: parent < 0 ? null : parent});
    }
    event.preventDefault(); writeOutlineClipboard(event.clipboardData, items); return items.filter(item => item.parent === null).length;
  }
  /** With items selected the clipboard lands after the last topmost one; in text only an empty item takes it, and one
   * foreign line stays prosemirror's paste. Own references link again; foreign lines are born. */
  private paste(event: ClipboardEvent): boolean {
    const view = this.view, data = event.clipboardData, block = this.blockRange !== null;
    // the paste rides the ⌘V keydown's native packet, so canArrange() is false here; the event itself is the gesture.
    if (!view || !data || this.filter.trim()) return false;
    let at = block ? this.roots().at(-1) : undefined;
    if (!block) {
      const selection = view.state.selection, field = selection.empty ? fieldAt(view.state.doc, selection.from) : null;
      const row = field?.kind === "body" && field.from === field.to ? this.rows.get(field.row_id) : undefined;
      if (row && !this.blockedRows.has(row.row_id) && this.editableReady(row) && (row.tail || this.itemText(row.row_id))) at = row;
    }
    if (!at?.parent_id) return false;
    let items: ClipItem[];
    try {items = readOutlineClipboard(data);}
    catch {event.preventDefault(); this.refuse("this clipboard content cannot be inserted here"); return true;}
    const lines = items.flatMap(item => item.kind === "note" && item.ref === null ? [item] : []);
    if (!items.length || !block && items.length === 1 && lines.length === 1) return false;
    event.preventDefault();
    const before = this.capture();
    if (lines.length === items.length) this.pasteLines(lines, at, block, before);
    else if (items.every(item => item.ref !== null)) void this.pasteLinks(items, at, block, before).catch(error => {if (this.active) {this.error = error; this.notify();}});
    else this.refuse("this clipboard content cannot be inserted here");
    return true;
  }
  /** Links the clipboard's roots under the destination's parent (descendants travel with their root's link) in one
   * command, after the last selected, above an empty item or at the write row's place. Pairs already here are skipped;
   * when every pair is, nothing changes. */
  private async pasteLinks(items: readonly ClipItem[], at: OutlineRow, block: boolean, before: InputBookmark): Promise<void> {
    const parent_ref = at.parent_ref, roots = items.flatMap(item => item.parent === null ? [item.ref!] : []);
    // the planner's rule: no root lands beneath itself.
    const above = [parent_ref];
    for (let row = this.rows.get(at.parent_id!); row?.parent_id; row = this.rows.get(row.parent_id)) above.push(row.parent_ref);
    if (roots.some(ref => above.includes(ref))) {this.refuse(rangeReasonMessage("invalid_parent")); return;}
    const store = await this.runtime.store, unique = [...new Set(roots)];
    const bindings = await Promise.all(unique.map(ref => {const [a, b] = [parent_ref, ref].sort(); return store.query({kind: "binding", key: {kind: "link", endpoint_a: a!, endpoint_b: b!}});}));
    const known = bindings.flatMap(binding => binding.binding_id === null ? [] : [binding.binding_id]);
    const here = new Set(known.length ? (await store.readStates({refs: [], link_ids: known, anchor_ids: [], source_refs: []})).links
      .filter(link => isVisible(link.add_vv, link.remove_vv)).map(link => link.link_id) : []);
    const fresh = unique.filter((_, index) => bindings[index]!.binding_id === null || !here.has(bindings[index]!.binding_id!));
    if (!this.active) return;
    const skipped = roots.length - fresh.length;
    if (!fresh.length) {this.refuse(skipped === 1 ? "already here" : `all ${skipped} already here`); return;}
    const first = block ? {after: at.ref, before: null} : {after: null, before: at.tail ? null : at.ref};
    const admitted = this.history.createMany({births: fresh.map((ref, index) => index ? {ref, parent: parent_ref, after: index - 1, before: null} : {ref, parent: parent_ref, ...first}),
      parents: [this.writing(parent_ref)], change: {before, after: () => before}});
    void admitted.committed.then(() => {
      if (!this.active) return;
      this.announce(`${fresh.length === 1 ? "linked" : `linked ${fresh.length} items`}${skipped ? `; ${skipped} already here` : ""}`); this.notify();
    }, () => {});
  }
  /** Births the lines at their indented depths in one command: a committed empty item takes line 1 and the rest follow
   * it, the write row's place takes them all, a selection puts them after its last topmost item. */
  private pasteLines(lines: readonly Extract<ClipItem, {kind: "note"}>[], at: OutlineRow, block: boolean, before: InputBookmark): void {
    const fill = !block && !at.tail ? this.writing(at.ref!)! : null;
    if (!this.admitNew(lines.length - (fill ? 1 : 0))) return;
    // line i is birth i, or i - 1 when the empty item takes line 0; a born line anchors by its birth index, the filled one by its ref.
    const birth = (index: number) => fill ? index - 1 : index, anchor = (index: number): string | number => fill && index === 0 ? at.ref! : birth(index);
    const rows = lines.map((_, index) => fill && index === 0 ? at.row_id : crypto.randomUUID());
    const previous = lines.map((line, index) => lines.findLastIndex((other, earlier) => earlier < index && other.parent === line.parent));
    const parentRow = (index: number) => {const parent = lines[index]!.parent; return parent === null ? at.parent_id! : rows[parent]!;};
    const born = [...lines.keys()].filter(index => !fill || index > 0);
    const births: Birth[] = born.map(index => {
      const line = lines[index]!, earlier = previous[index]!;
      return {body: line.body, parent: line.parent === null ? at.parent_ref : anchor(line.parent), after: earlier >= 0 ? anchor(earlier) : line.parent === null && block ? at.ref! : null, before: null};
    });
    const admitted = this.history.createMany({births, parents: [this.writing(at.parent_ref)], ...(fill ? {fill: {document: fill, body: lines[0]!.body}} : {}),
      change: {before, after: () => before, placements_after: (documents, links) => born.map(index => {
        const ref = documents[birth(index)]!.ref, parent = lines[index]!.parent, earlier = previous[index]!;
        return {row_id: rows[index]!, ref, link: links[birth(index)]!, placement: {row_id: rows[index]!, ref, parent_id: parentRow(index),
          parent_ref: parent === null ? at.parent_ref : fill && parent === 0 ? at.ref! : documents[birth(parent)]!.ref,
          after_id: earlier >= 0 ? rows[earlier]! : parent === null && block ? at.row_id : null, before_id: null}};
      })}});
    if (fill) this.publishWriting([fill], admitted.committed);
    for (const index of lines.keys()) if (lines.some(line => line.parent === index)) this.opened.add(rows[index]!);
    // the occurrences paint from their windows; their rows take the ids the history group retains.
    void Promise.all(admitted.links).then(links => {
      if (!this.active) return;
      for (const index of born) this.transfer(rows[index]!, parentRow(index), links[birth(index)]!.link_id, this.history.typingOrigin());
      this.announce(births.length === 1 ? "added" : `added ${births.length} items`);
      this.changed();
      if (!block) void this.focus(rows.at(-1)!, "end");
    }, () => {});
  }
  close(): void {
    this.setView(null); this.active = false; this.revoke(); this.disconnect?.(); this.unbindFocus?.(); this.view = null;
    this.workOwners.clear();
    for (const held of this.documents.values()) held.release(); this.documents.clear();
    for (const release of this.historyLeases.values()) release(); this.historyLeases.clear();
  }
}
