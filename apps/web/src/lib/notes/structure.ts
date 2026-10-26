/** Session-scoped outline chronology. Each gesture reserves its real documents,
 * Yjs inverse and graph command synchronously. Receipts extend only the groups
 * eligible at admission; graph inverses freeze that coverage at their own slot.
 * No clone survives a gesture and no receipt chooses which command to undo. */
import * as Y from "yjs";
import {applyBodyEdits, bodyInline, hydrateNote, readBody, sliceInline} from "@nexus/authored/documents";
import {parseBody, type NoteBody} from "@nexus/authored/body";
import {insertionPositions, type Intent} from "@nexus/authored/commands";
import {linkId} from "@nexus/authored/identity";
import {advanceCoverage} from "@nexus/authored/merge";
import type {LinkState, Vector} from "@nexus/authored/types";
import {endpointForResource, preparePosition, prepareLink, prepareTarget} from "@/lib/resourceGraph/links";
import {LocalCommitError, type LocalCommit, type WritingDocument, type WritingRuntime} from "./runtime";
import type {ClipItem} from "./clipboard";
import type {DisplayedSplit, FocusSelection, NoteEdit} from "./editorTypes";

export interface EditorHistory {
  origin: unknown;
  retain(): () => void;
  undo(): void;
  redo(): void;
  boundary(): void;
  record(edit?: Pick<NoteEdit, "selectionBefore" | "selectionAfter">, admission?: number, bookmark?: OutlineBookmark): void;
}
export interface OutlineBookmark {
  key: string; ref: string; selection: FocusSelection | null;
  resolve?: (document: WritingDocument) => FocusSelection;
  occurrence?: {parent_ref: string; link_id: string | null; parent_id?: string; link?: LinkState | Promise<LinkState>;
    after_id?: string | null; before_id?: string | null};
}
export interface OutlinePlacement {
  parent_ref: string; parent: WritingDocument | null;
  after_ref: string | null; before_ref: string | null;
}
export interface OutlineOccurrence {
  ref: string; parent_ref: string; document: WritingDocument | null; parent: WritingDocument | null;
  link: LinkState | Promise<LinkState>;
}
export interface OutlineChange {before: OutlineBookmark | null; after: OutlineBookmark | null}
export interface OutlineVisibility {show: readonly OutlineBookmark[]; hide: readonly OutlineBookmark[]}
export interface OutlineBirthChange {before: OutlineBookmark | null; after(document: WritingDocument): OutlineBookmark | null}
export interface DisplayedWriting {body_state: string; observed: Promise<Vector>}
export interface AdmittedStructure {result: Promise<LocalCommit>; committed: Promise<LocalCommit>}
export interface AdmittedLink extends AdmittedStructure {link: Promise<LinkState>}
export interface AdmittedNote extends AdmittedLink {document: WritingDocument}
export interface AdmittedJoin extends AdmittedStructure {selection: (document: WritingDocument) => FocusSelection}
export interface AdmittedPaste extends AdmittedStructure {refs: readonly string[]; documents: readonly WritingDocument[]}
interface Coverage {resources: Map<string, Vector>; links: Map<string, Vector>}
interface Settlement {store_revision: string; links: readonly LinkState[]}
interface Group {
  refs: string[]; documents: WritingDocument[]; metadata(): unknown;
  before: OutlineBookmark | null; after: OutlineBookmark | null; coverage: Coverage;
  added: readonly OutlineBookmark[]; removed: readonly OutlineBookmark[];
  settled: Promise<Settlement | null>; receipt: Settlement | null; released: boolean;
  apply(redo: boolean, lower: Promise<Settlement | null>): AdmittedStructure;
  cleanup(): void;
}
interface TextHistory {
  document: WritingDocument; manager: Y.UndoManager; origin: symbol;
  latest: object | null; latestGroup: Group | null; active: number; groups: number; captureBytes: number; unsubscribe(): void;
}
interface FocusOwner {
  capture(): OutlineBookmark | null;
  restore(bookmark: OutlineBookmark, mayFocus?: () => boolean): Promise<void>;
  lease(): () => boolean;
  prepare?(target: OutlineBookmark | null, source: OutlineBookmark | null, mayFocus: () => boolean, visibility: OutlineVisibility): (store_revision: string) => void;
  publish(documents: readonly WritingDocument[], target: OutlineBookmark | null, source: OutlineBookmark | null, mayFocus: () => boolean, committed: Promise<LocalCommit>): void;
}

export class OutlineHistory {
  private readonly past: Group[] = [];
  private readonly future: Group[] = [];
  private readonly texts = new Map<string, TextHistory>();
  private readonly TypingOrigin = class {};
  private focus: FocusOwner | null = null;
  private closed = false;
  constructor(readonly runtime: WritingRuntime, private readonly failure: (error: unknown) => void) {}
  typingOrigin(): unknown {return new this.TypingOrigin();}
  boundary(): void {for (const history of this.texts.values()) history.manager.stopCapturing();}
  retainedRefs(): ReadonlySet<string> {return new Set(this.groups().flatMap(group => group.refs));}
  retainedOccurrences(): ReadonlySet<string> {return new Set(this.groups().flatMap(group => [group.before, group.after, ...group.added, ...group.removed]
    .flatMap(row => row ? [row.key] : [])));}
  retainedRows(): ReadonlySet<string> {return new Set(this.groups().flatMap(group => [group.before, group.after, ...group.added, ...group.removed]
    .flatMap(row => [row?.key, row?.occurrence?.parent_id, row?.occurrence?.after_id, row?.occurrence?.before_id])
    .filter((key): key is string => typeof key === "string")));}
  retainedBytes(): number {return this.groups().reduce((bytes, group) => bytes + new TextEncoder().encode(JSON.stringify({
    refs: group.refs, before: group.before, after: group.after, added: group.added, removed: group.removed, receipt: group.receipt,
    resources: [...group.coverage.resources], links: [...group.coverage.links], metadata: group.metadata(),
  })).byteLength, [...this.texts.values()].reduce((bytes, history) => bytes + history.captureBytes, 0));}
  releaseOldest(): boolean {
    if (this.groups().some(group => group.released)) return false;
    const first = this.past.find(group => !group.released);
    if (first) {this.release(first); return true;}
    const future = this.future.filter(group => !group.released);
    if (!future.length) return false;
    for (const group of future) this.release(group);
    return true;
  }
  async settleRetired(): Promise<void> {
    await Promise.allSettled(this.groups().filter(group => group.released).map(group => group.settled));
  }
  bindFocus(owner: FocusOwner): () => void {this.focus = owner; return () => {if (this.focus === owner) this.focus = null;};}
  canUndo(): boolean {return this.past.some(group => !group.released);}
  canRedo(): boolean {return this.future.some(group => !group.released);}
  undo = (): void => {this.replay(false);};
  redo = (): void => {this.replay(true);};
  private groups(): Group[] {return [...this.past, ...this.future];}
  private reserve(change: OutlineChange): Group {
    if (this.closed) throw new Error("outline history is closed");
    for (const discarded of this.future) this.release(discarded);
    const group: Group = {refs: [], documents: [], metadata: () => null, before: change.before, after: change.after,
      coverage: {resources: new Map(), links: new Map()}, added: [], removed: [], settled: Promise.resolve(null), receipt: null, released: false,
      apply: () => {throw new Error("outline command has not finished admission");}, cleanup: () => {}};
    this.past.push(group);
    return group;
  }
  private hold(group: Group, documents: readonly (WritingDocument | null)[]): void {
    for (const document of documents) if (document && !group.documents.includes(document)) {
      const release = document.retain(), cleanup = group.cleanup;
      group.documents.push(document);
      if (!group.refs.includes(document.ref)) group.refs.push(document.ref);
      group.cleanup = () => {cleanup(); release();};
    }
  }
  private release(group: Group): void {
    if (group.released) return;
    group.released = true;
    for (const history of this.texts.values()) if (history.latestGroup === group) {
      history.manager.stopCapturing(); history.latest = null; history.latestGroup = null;
    }
    const finish = () => {
      group.cleanup();
      for (const stack of [this.past, this.future]) {
        const index = stack.indexOf(group); if (index >= 0) stack.splice(index, 1);
      }
      // Later receipt listeners can still hold this group as an eligible
      // recipient. Its last admitted inverse is now settled; retain no payload.
      group.refs = []; group.documents = []; group.before = null; group.after = null;
      group.added = []; group.removed = []; group.receipt = null;
      group.coverage.resources.clear(); group.coverage.links.clear();
      group.metadata = () => null; group.cleanup = () => {}; group.settled = Promise.resolve(null);
      group.apply = () => {throw new Error("outline command is retired");};
    };
    void group.settled.then(finish, finish).catch(this.failure);
  }
  private trim(): void {while ([...this.retainedRefs()].filter(ref => ref.startsWith("note_block:") || ref.startsWith("page:")).length > 64 || this.retainedBytes() > 16 * 1024 * 1024) if (!this.releaseOldest()) break;}
  private settle(result: Promise<LocalCommit>): Promise<LocalCommit> {
    return result.catch(error => {this.failure(error); if (error instanceof LocalCommitError) return error.completion; throw error;});
  }
  private track(group: Group, result: Promise<LocalCommit>, eligible: readonly Group[], install?: (receipt: LocalCommit) => void): Promise<LocalCommit> {
    const settled = this.settle(result).then(receipt => {install?.(receipt); this.cover(receipt, eligible); return receipt;});
    const barrier = settled.then(receipt => {
      const value = {store_revision: receipt.store_revision, links: receipt.change.links};
      if (group.settled === barrier) group.receipt = value;
      return value;
    });
    group.settled = barrier;
    void barrier.catch(() => {});
    void settled.catch(() => {});
    this.trim();
    return settled;
  }
  /** The lexical recipients survive an undo/new-edit branch change. Certificates
   * are folded one receipt at a time; maxima would erase same-replica holes. */
  private cover(receipt: LocalCommit, eligible: readonly Group[]): void {
    for (const group of eligible) {
      for (const patch of receipt.change.resources) {
        const covered = group.coverage.resources.get(patch.ref);
        if (!covered) continue;
        const before = receipt.before.resources.find(state => state.ref === patch.ref);
        group.coverage.resources.set(patch.ref, advanceCoverage(covered, before ? {touch: before.touch_vv, removed: before.delete_vv} : null, patch.touch_vv));
      }
      for (const patch of receipt.change.links) {
        const covered = group.coverage.links.get(patch.link_id);
        if (!covered) continue;
        const before = receipt.before.links.find(state => state.link_id === patch.link_id);
        group.coverage.links.set(patch.link_id, advanceCoverage(covered, before ? {touch: before.add_vv, removed: before.remove_vv} : null, patch.add_vv));
      }
    }
  }
  private replay(redo: boolean): void {
    if (this.closed) return;
    const from = redo ? this.future : this.past, to = redo ? this.past : this.future;
    const group = from.findLast(group => !group.released); if (!group) return;
    this.boundary();
    const owner = this.focus, mayFocus = owner?.lease() ?? (() => true);
    const target = redo ? group.after : group.before, source = redo ? group.before : group.after;
    const acknowledge = owner?.prepare?.(target, source, mayFocus, {show: redo ? group.added : group.removed, hide: redo ? group.removed : group.added});
    const lower = group.settled;
    try {
      const admission = group.apply(redo, lower);
      from.splice(from.indexOf(group), 1); to.push(group);
      owner?.publish(group.documents, target, source, mayFocus, admission.committed);
      const completion = group.settled;
      void completion.then(receipt => {if (receipt) acknowledge?.(receipt.store_revision);}).catch(() => {});
      void admission.result.catch(() => {});
    } catch (error) {this.failure(error);}
  }
  private participants(documents: readonly (WritingDocument | null)[], origin: unknown): {document: WritingDocument; origin: unknown}[] {
    return [...new Set(documents.filter((document): document is WritingDocument => document !== null))].map(document => ({document, origin}));
  }
  private async identity(parent_ref: string, ref: string): Promise<string> {
    const store = await this.runtime.store;
    const [a, b] = parent_ref < ref ? [parent_ref, ref] : [ref, parent_ref];
    const binding = await store.query({kind: "binding", key: {kind: "link", endpoint_a: a!, endpoint_b: b!}});
    return binding.binding_id ?? linkId((await store.readReplica()).account_id, parent_ref, ref);
  }
  private async placement(placement: OutlinePlacement): Promise<{after: string | null; before: string | null}> {
    return {after: placement.after_ref === null ? null : await this.identity(placement.parent_ref, placement.after_ref),
      before: placement.before_ref === null ? null : await this.identity(placement.parent_ref, placement.before_ref)};
  }
  private relationship(bookmark: OutlineBookmark | null, link: LinkState | Promise<LinkState>): OutlineBookmark | null {
    return bookmark?.occurrence ? {...bookmark, occurrence: {...bookmark.occurrence, link, link_id: "link_id" in link ? link.link_id : null}} : bookmark;
  }
  private createdLink(completion: Promise<LocalCommit>, id: () => string): Promise<LinkState> {
    const result = completion.then(receipt => {
      const link = receipt.change.links.find(link => link.link_id === id());
      if (!link) throw new Error("outline creation receipt has no relationship");
      return link;
    });
    void result.catch(() => {});
    return result;
  }

  editor(document: WritingDocument, suppliedOrigin?: unknown): EditorHistory {
    if (this.closed) return {origin: suppliedOrigin ?? Symbol("closed outline typing"), retain: () => () => {}, undo: () => {}, redo: () => {}, boundary: () => {}, record: () => {}};
    let entry = this.texts.get(document.ref);
    if (!entry) {
      const origin = Symbol("outline typing");
      const manager = new Y.UndoManager(scope(document), {trackedOrigins: new Set<unknown>([origin, this.TypingOrigin]), captureTimeout: 500});
      let lastOrigin: unknown = null;
      const separate = (transaction: Y.Transaction) => {
        const source = transaction.origin;
        if (source !== origin && !(source instanceof this.TypingOrigin) && source !== manager) return;
        if (lastOrigin !== source) manager.stopCapturing();
        lastOrigin = source;
      };
      document.doc.on("beforeTransaction", separate);
      entry = {document, origin, manager, latest: null, latestGroup: null, active: 0, groups: 0, captureBytes: 0, unsubscribe: () => {document.doc.off("beforeTransaction", separate);}};
      this.texts.set(document.ref, entry);
    }
    if (entry.document !== document) throw new Error("outline history needs its retained canonical document");
    const history = entry, origin = suppliedOrigin ?? history.origin;
    return {origin, retain: () => {history.active++; return () => {history.active--; this.pruneText(history);};},
      undo: this.undo, redo: this.redo, boundary: () => history.manager.stopCapturing(),
      record: (edit, _admission, bookmark) => {
        const current = bookmark ?? this.focus?.capture() ?? null;
        // A resolver captured after an edit cannot describe its numeric before.
        const raw = current ? {key: current.key, ref: current.ref, selection: current.selection, ...(current.occurrence ? {occurrence: current.occurrence} : {})} : null;
        const after = raw && edit ? {...raw, selection: edit.selectionAfter} : raw;
        const item = history.manager.undoStack.at(-1); if (!item) return;
        let group = history.latest === item ? history.latestGroup : null;
        if (!group) {
          group = this.reserve({before: raw && edit ? {...raw, selection: edit.selectionBefore} : raw, after});
          this.hold(group, [document]); history.groups++;
          let owned = item;
          const cleanup = group.cleanup;
          group.cleanup = () => {
            const undo = history.manager.undoStack.filter(item => item !== owned), redo = history.manager.redoStack.filter(item => item !== owned);
            history.manager.undoStack = history.manager.undoStack.filter(item => item === owned);
            history.manager.redoStack = history.manager.redoStack.filter(item => item === owned);
            history.manager.clear(); history.manager.undoStack = undo; history.manager.redoStack = redo;
            if (history.latestGroup === group) {history.latest = null; history.latestGroup = null;}
            history.groups--; cleanup(); this.pruneText(history);
          };
          group.apply = (redo, lower) => {
            const eligible = this.groups(), target = group!;
            const admitted = this.runtime.admitWriting({existing: [{document, origin: history.manager}], notes: [],
              mutate: () => {
                // Yjs skips exhausted items. Isolate this exact group's item so
                // remote deletion cannot make undo consume an older command.
                const undo = history.manager.undoStack.filter(item => item !== owned), future = history.manager.redoStack.filter(item => item !== owned);
                history.manager.undoStack = redo ? [] : [owned]; history.manager.redoStack = redo ? [owned] : [];
                if (redo) history.manager.redo(); else history.manager.undo();
                const next = (redo ? history.manager.undoStack : history.manager.redoStack).at(-1);
                owned = next ?? owned;
                history.manager.undoStack = [...undo, ...(redo && next ? [next] : [])];
                history.manager.redoStack = [...future, ...(!redo && next ? [next] : [])];
                history.latest = null; history.latestGroup = null;
              }, prepare: async () => {await lower; return [];}});
            return {result: admitted.result, committed: this.track(target, admitted.result, eligible)};
          };
          history.latest = item; history.latestGroup = group;
        } else group.after = after;
        const eligible = this.groups();
        const stop = document.onCommitted((receipt, source) => {if (source === origin) this.cover(receipt, eligible);});
        // Capture now, before any later undo reserves a slot. Its frontier is not
        // ownership: only the receipts observed above may extend group coverage.
        const bytes = Y.encodeStateAsUpdate(document.doc).byteLength;
        history.captureBytes += bytes;
        const barrier = document.capture().then(() => undefined).finally(() => {history.captureBytes -= bytes; this.pruneText(history);});
        const previous = group.settled;
        group.settled = Promise.all([previous, barrier]).then(([receipt]) => receipt);
        void barrier.then(stop, stop); void group.settled.catch(this.failure);
        this.trim();
      }};
  }
  private pruneText(history: TextHistory): void {
    if (history.active || history.groups || history.captureBytes || this.texts.get(history.document.ref) !== history) return;
    history.unsubscribe(); history.manager.clear(); history.manager.destroy(); this.texts.delete(history.document.ref);
  }

  create(args: {placement: OutlinePlacement; body: NoteBody; change: OutlineBirthChange}): AdmittedNote {
    return this.birth(args.placement, args.body, args.change, null);
  }
  split(args: {source: WritingDocument; displayed: DisplayedSplit; placement: OutlinePlacement; change: OutlineBirthChange}): AdmittedNote {
    const clone = hydrateNote(args.displayed.body_state);
    try {
      const inline = bodyInline(clone), {from, to} = args.displayed;
      const suffix = parseBody({type: "body", attrs: readBody(clone).body_pm_json.attrs, content: sliceInline(clone, to, inline.length)});
      const vector = Y.encodeStateVector(clone);
      applyBodyEdits(clone, [{kind: "replace", from, to: inline.length, content: []}]);
      return this.birth(args.placement, suffix, args.change, {document: args.source, update: Y.encodeStateAsUpdate(clone, vector)});
    } finally {clone.destroy();}
  }
  private birth(placement: OutlinePlacement, body: NoteBody, change: OutlineBirthChange, source: {document: WritingDocument; update: Uint8Array} | null): AdmittedNote {
    this.boundary();
    const group = this.reserve({before: change.before, after: null}), origin = Symbol("outline birth");
    const manager = source ? new Y.UndoManager(scope(source.document), {trackedOrigins: new Set([origin]), captureTimeout: 0}) : null;
    group.cleanup = () => {manager?.clear(); manager?.destroy();};
    this.hold(group, [placement.parent, source?.document ?? null]);
    let relationship = "";
    const eligible = this.groups();
    const admitted = this.runtime.admitWriting({existing: this.participants(group.documents, origin), notes: [{body, origin}],
      mutate: () => {if (source) Y.applyUpdate(source.document.doc, source.update, origin);},
      prepare: async refs => {
        const position = await this.placement(placement);
        const prepared = await prepareLink(this.runtime, {source_ref: placement.parent_ref, target_ref: refs[0]!, source_label: null, target_label: null, ...position});
        relationship = prepared.link_id; group.coverage.links.set(relationship, {});
        return prepared.intents;
      }});
    const document = admitted.created[0]!;
    this.hold(group, [document]); group.coverage.resources.set(document.ref, {});
    group.after = change.after(document);
    group.apply = (redo, lower) => {
      const eligible = this.groups();
      const inverse = this.runtime.admitWriting({existing: this.participants(group.documents, manager ?? origin), notes: [],
        mutate: () => {if (redo) manager?.redo(); else manager?.undo();},
        prepare: async () => {
          await lower;
          return redo ? [{kind: "restore_resource", ref: document.ref}, {kind: "restore_link", link_id: relationship}]
            : [{kind: "delete_resource", ref: document.ref, observed_touch: {...group.coverage.resources.get(document.ref)!}},
              {kind: "unlink", link_id: relationship, observed_add: {...group.coverage.links.get(relationship)!}}];
        }});
      return {result: inverse.result, committed: this.track(group, inverse.result, eligible)};
    };
    const completion = this.track(group, admitted.result, eligible), link = this.createdLink(completion, () => relationship);
    group.after = this.relationship(group.after, link);
    group.added = group.after ? [group.after] : [];
    return {document, result: admitted.result, committed: completion, link};
  }
  join(args: {source: WritingDocument; destination: WritingDocument; displayed: {source: DisplayedWriting; destination: DisplayedWriting}; sourceOccurrence: OutlineBookmark; change: OutlineChange}): AdmittedJoin {
    const {source: sourceDocument, destination: destinationDocument, change, sourceOccurrence} = args;
    const sourceObserved = args.displayed.source.observed, destinationObserved = args.displayed.destination.observed;
    if (sourceDocument === destinationDocument) throw new Error("a note cannot be joined to itself");
    const destination = hydrateNote(args.displayed.destination.body_state), source = hydrateNote(args.displayed.source.body_state);
    let update: Uint8Array, seam: Y.RelativePosition;
    try {
      const inline = bodyInline(destination), index = inline.length, content = sliceInline(source, 0, bodyInline(source).length);
      const vector = Y.encodeStateVector(destination);
      applyBodyEdits(destination, [{kind: "replace", from: index, to: index, content}]);
      // The first copied item's identity survives an unseen destination insertion
      // before the seam. An empty source instead anchors the observed left item.
      seam = Y.createRelativePositionFromTypeIndex(inline, index, content.length ? 0 : -1);
      update = Y.encodeStateAsUpdate(destination, vector);
    } finally {destination.destroy(); source.destroy();}
    const selection = (document: WritingDocument): FocusSelection => {
      const at = Y.createAbsolutePositionFromRelativePosition(seam, document.doc);
      const index = at?.index ?? bodyInline(document.doc).length;
      return {anchor: index + 1, head: index + 1};
    };
    this.boundary();
    const group = this.reserve({...change, after: change.after ? {...change.after, resolve: selection} : null});
    group.removed = [sourceOccurrence];
    const origin = Symbol("outline join"), manager = new Y.UndoManager(scope(destinationDocument), {trackedOrigins: new Set([origin]), captureTimeout: 0});
    group.cleanup = () => {manager.clear(); manager.destroy();}; this.hold(group, [sourceDocument, destinationDocument]);
    const proof = Promise.all([sourceObserved, destinationObserved]);
    void proof.catch(() => {});
    const eligible = this.groups();
    const admitted = this.runtime.admitWriting({existing: this.participants(group.documents, origin), notes: [],
      mutate: () => {Y.applyUpdate(destinationDocument.doc, update, origin);},
      prepare: async () => {
        const [observed_touch] = await proof;
        group.coverage.resources.set(sourceDocument.ref, observed_touch);
        return [{kind: "delete_resource", ref: sourceDocument.ref, observed_touch}];
      }});
    group.apply = (redo, lower) => {
      const eligible = this.groups();
      const inverse = this.runtime.admitWriting({existing: this.participants(group.documents, manager), notes: [],
        mutate: () => {if (redo) manager.redo(); else manager.undo();},
        prepare: async () => {await lower; return [redo
          ? {kind: "delete_resource", ref: sourceDocument.ref, observed_touch: {...group.coverage.resources.get(sourceDocument.ref)!}}
          : {kind: "restore_resource", ref: sourceDocument.ref}];}});
      return {result: inverse.result, committed: this.track(group, inverse.result, eligible)};
    };
    const committed = this.track(group, admitted.result, eligible);
    return {result: admitted.result, committed, selection};
  }
  unlinkMany(args: {occurrences: readonly OutlineOccurrence[]; change: OutlineChange & {rows: readonly OutlineBookmark[]}}): AdmittedStructure {
    this.boundary();
    const group = this.reserve(args.change), origin = Symbol("outline unlink");
    group.removed = args.change.rows.map(row => {
      const occurrence = args.occurrences.find(occurrence => occurrence.ref === row.ref && occurrence.parent_ref === row.occurrence?.parent_ref);
      return occurrence ? this.relationship(row, occurrence.link)! : row;
    });
    if (args.occurrences.length === 1) group.before = this.relationship(group.before, args.occurrences[0]!.link);
    this.hold(group, args.occurrences.flatMap(occurrence => [occurrence.document, occurrence.parent]));
    for (const occurrence of args.occurrences) for (const ref of [occurrence.ref, occurrence.parent_ref]) if (!group.refs.includes(ref)) group.refs.push(ref);
    const links = Promise.all(args.occurrences.map(occurrence => occurrence.link));
    void links.catch(() => {});
    const eligible = this.groups();
    const admitted = this.runtime.admitWriting({existing: this.participants(group.documents, origin), notes: [], mutate: () => {},
      prepare: async () => (await links).map(link => {
        group.coverage.links.set(link.link_id, link.add_vv);
        return {kind: "unlink", link_id: link.link_id, observed_add: link.add_vv};
      })});
    group.apply = (redo, lower) => {
      const eligible = this.groups();
      const inverse = this.runtime.admitWriting({existing: this.participants(group.documents, origin), notes: [], mutate: () => {},
        prepare: async () => {await lower; return [...group.coverage.links].map(([link_id, observed_add]) => redo
          ? {kind: "unlink", link_id, observed_add: {...observed_add}} : {kind: "restore_link", link_id});}});
      return {result: inverse.result, committed: this.track(group, inverse.result, eligible)};
    };
    return {result: admitted.result, committed: this.track(group, admitted.result, eligible)};
  }
  relink(args: {occurrence: OutlineOccurrence; placement: OutlinePlacement; change: OutlineChange}): AdmittedLink {
    this.boundary();
    const group = this.reserve(args.change), origin = Symbol("outline reparent");
    this.hold(group, [args.occurrence.document, args.occurrence.parent, args.placement.parent]);
    group.refs = [...new Set([...group.refs, args.occurrence.ref, args.occurrence.parent_ref, args.placement.parent_ref])];
    const previous = Promise.resolve(args.occurrence.link);
    group.before = this.relationship(group.before, args.occurrence.link);
    let destination = "", added = false, existing: LinkState | null = null, observed: LinkState | null = null;
    group.metadata = () => ({observed, existing});
    const eligible = this.groups();
    const admitted = this.runtime.admitWriting({existing: this.participants(group.documents, origin), notes: [], mutate: () => {},
      prepare: async () => {
        const link = await previous, position = await this.placement(args.placement);
        observed = link;
        const prepared = await prepareLink(this.runtime, {source_ref: args.placement.parent_ref, target_ref: args.occurrence.ref, source_label: null, target_label: null, ...position});
        destination = prepared.link_id;
        if (destination === link.link_id) throw new Error("reparenting needs a different parent");
        added = prepared.intents.some(intent => intent.kind === "add_link");
        group.coverage.links.set(link.link_id, link.add_vv);
        if (added) group.coverage.links.set(destination, {});
        else existing = (await (await this.runtime.store).readStates({refs: [], link_ids: [destination], anchor_ids: [], source_refs: []})).links[0] ?? null;
        return [{kind: "unlink", link_id: link.link_id, observed_add: link.add_vv}, ...prepared.intents];
      }});
    group.apply = (redo, lower) => {
      const eligible = this.groups();
      const inverse = this.runtime.admitWriting({existing: this.participants(group.documents, origin), notes: [], mutate: () => {},
        prepare: async () => {
          await lower;
          const link = await previous;
          return redo
            ? [{kind: "unlink", link_id: link.link_id, observed_add: {...group.coverage.links.get(link.link_id)!}}, ...(added ? [{kind: "restore_link" as const, link_id: destination}] : [])]
            : [{kind: "restore_link", link_id: link.link_id}, ...(added ? [{kind: "unlink" as const, link_id: destination, observed_add: {...group.coverage.links.get(destination)!}}] : [])];
        }});
      return {result: inverse.result, committed: this.track(group, inverse.result, eligible)};
    };
    const completion = this.track(group, admitted.result, eligible, receipt => {
      added = receipt.change.links.some(link => link.link_id === destination && Object.keys(link.add_vv).length > 0);
      if (!added) group.coverage.links.delete(destination);
    });
    const link = completion.then(async receipt => {
      let current = receipt.change.links.find(link => link.link_id === destination) ?? existing;
      if (!current) {
        const state = (await (await this.runtime.store).readStates({refs: [], link_ids: [destination], anchor_ids: [], source_refs: []})).links[0];
        // An independent add won after preparation. Its placement identifies the
        // shown occurrence; its unobserved membership is not ours to remove.
        if (state) current = {...state, add_vv: {}, remove_vv: {}};
      }
      if (!current) throw new Error("reparent receipt has no relationship");
      return current;
    });
    group.after = this.relationship(group.after, link);
    void link.catch(() => {}); return {result: admitted.result, committed: completion, link};
  }
  move(args: {occurrence: OutlineOccurrence; placement: OutlinePlacement; change: OutlineChange}): AdmittedLink {
    this.boundary();
    const group = this.reserve(args.change), origin = Symbol("outline move");
    this.hold(group, [args.occurrence.document, args.occurrence.parent, args.placement.parent]);
    if (!group.refs.includes(args.placement.parent_ref)) group.refs.push(args.placement.parent_ref);
    const previous = new Map<string, LinkState>(), source = Promise.resolve(args.occurrence.link), endpoint = args.placement.parent_ref;
    group.before = this.relationship(group.before, args.occurrence.link);
    group.metadata = () => [...previous];
    const eligible = this.groups();
    const admitted = this.runtime.admitWriting({existing: this.participants(group.documents, origin), notes: [], mutate: () => {},
      prepare: async () => {
        const link = await source, position = await this.placement(args.placement);
        const prepared = await preparePosition(this.runtime, endpoint, link.link_id, position.after, position.before);
        const current = (await (await this.runtime.store).readStates({refs: [], link_ids: [link.link_id], anchor_ids: [], source_refs: []})).links[0];
        if (!current) throw new Error("the moved relationship is unavailable");
        for (const state of [...prepared.previous, current]) previous.set(state.link_id, state);
        return [...prepared.moves, {kind: "move_link", link_id: link.link_id, endpoint_ref: endpoint, position: prepared.value}];
      }});
    const completion = this.track(group, admitted.result, eligible), forward = completion.then(receipt => receipt.change.links);
    void forward.catch(() => {});
    group.apply = (redo, lower) => {
      const eligible = this.groups();
      const inverse = this.runtime.admitWriting({existing: this.participants(group.documents, origin), notes: [], mutate: () => {},
        prepare: async () => {
          const [current, first] = await Promise.all([lower, forward]);
          if (!current) throw new Error("move inverse has no predecessor receipt");
          return restorePositions(current, redo ? new Map(first.map(link => [link.link_id, link])) : previous, endpoint);
        }});
      return {result: inverse.result, committed: this.track(group, inverse.result, eligible)};
    };
    const link = completion.then(async receipt => {
      const observed = await source, moved = receipt.change.links.find(link => link.link_id === observed.link_id);
      if (!moved) throw new Error("move receipt has no relationship");
      return {...observed, position_a: moved.position_a ?? observed.position_a, position_b: moved.position_b ?? observed.position_b};
    });
    group.after = this.relationship(group.after, link);
    void link.catch(() => {}); return {result: admitted.result, committed: completion, link};
  }

  paste(args: {placement: OutlinePlacement; items: readonly ClipItem[]; change: {before: OutlineBookmark | null; after(refs: readonly string[]): OutlineBookmark | null}}): AdmittedPaste {
    this.boundary();
    const group = this.reserve({before: args.change.before, after: null}), origin = Symbol("outline paste");
    this.hold(group, [args.placement.parent]);
    const items = args.items, additions: string[] = [], previous = new Map<string, {link: LinkState; endpoint: string}>();
    group.metadata = () => [...previous];
    let refs: string[] = [];
    const eligible = this.groups();
    const admitted = this.runtime.admitWriting({existing: this.participants(group.documents, origin),
      notes: items.flatMap(item => item.kind === "note" ? [{body: item.body, origin}] : []),
      mutate: created => {
        let index = 0;
        refs = items.map(item => item.kind === "note" ? created[index++]!.ref : item.ref);
      },
      prepare: async () => {
        const account = (await (await this.runtime.store).readReplica()).account_id;
        const positions = new Map<string, {last: string; upper: string | null}>(), intents: Intent[] = [];
        const rootPosition = await this.placement(args.placement);
        for (const [index, item] of items.entries()) {
          const parent = item.parent === null ? args.placement.parent_ref : refs[item.parent]!;
          if (item.parent !== null && items[item.parent]!.kind !== "note" && endpointForResource(parent)?.kind !== "resource") throw new Error("only copied notes can hold copied children");
          const ref = refs[index]!, id = linkId(account, parent, ref), preceding = positions.get(parent);
          let placement: {value: string; moves: Intent[]};
          if (preceding) {
            const neighbors = [{link_id: "left", position: preceding.last}, ...(preceding.upper === null ? [] : [{link_id: "right", position: preceding.upper}])];
            placement = {value: insertionPositions(neighbors, 1, id)[0]!.position, moves: []};
          } else {
            const prepared = await preparePosition(this.runtime, parent, id, parent === args.placement.parent_ref ? rootPosition.after : null, parent === args.placement.parent_ref ? rootPosition.before : null);
            placement = prepared;
            const upper = prepared.previous.map(link => positionAt(link, parent)?.value).filter((key): key is string => key !== undefined && key > prepared.value).sort()[0] ?? null;
            positions.set(parent, {last: prepared.value, upper});
            for (const move of prepared.moves) if (move.kind === "move_link") {
              const link = prepared.previous.find(link => link.link_id === move.link_id)!;
              previous.set(parent + "/" + link.link_id, {link, endpoint: parent});
            }
          }
          positions.get(parent)!.last = placement.value;
          const prepared = await prepareLink(this.runtime, {source_ref: parent, target_ref: ref, source_label: null, target_label: item.kind === "resource" ? item.label : null, after: null}, placement);
          if (!prepared.intents.some(intent => intent.kind === "add_link")) throw new Error("a copied resource is already linked here");
          group.coverage.links.set(prepared.link_id, {});
          intents.push(...prepared.intents); additions.push(prepared.link_id);
        }
        return intents;
      }});
    const documents = admitted.created;
    this.hold(group, documents);
    group.refs = [...new Set([...group.refs, ...refs])];
    for (const document of documents) group.coverage.resources.set(document.ref, {});
    group.after = args.change.after(refs);
    const completion = this.track(group, admitted.result, eligible, receipt => {
      for (let index = additions.length - 1; index >= 0; index--) if (!receipt.change.links.some(link => link.link_id === additions[index] && Object.keys(link.add_vv).length > 0)) {
        group.coverage.links.delete(additions[index]!); additions.splice(index, 1);
      }
    }), forward = completion.then(receipt => receipt.change.links);
    void forward.catch(() => {});
    group.apply = (redo, lower) => {
      const eligible = this.groups();
      const inverse = this.runtime.admitWriting({existing: this.participants(group.documents, origin), notes: [], mutate: () => {},
        prepare: async () => {
          const [current, first] = await Promise.all([lower, forward]);
          if (!current) throw new Error("paste inverse has no predecessor receipt");
          const positions: Intent[] = [];
          for (const {link, endpoint} of previous.values()) {
            const actual = current.links.find(item => item.link_id === link.link_id);
            const desired = redo ? first.find(item => item.link_id === link.link_id) : link;
            const expected = actual ? positionAt(actual, endpoint) : null, position = desired ? positionAt(desired, endpoint) : null;
            if (expected && position) positions.push({kind: "restore_position", link_id: link.link_id, endpoint_ref: endpoint, expected: expected.stamp, position: position.value});
          }
          return [...documents.map(document => redo ? {kind: "restore_resource" as const, ref: document.ref}
            : {kind: "delete_resource" as const, ref: document.ref, observed_touch: {...group.coverage.resources.get(document.ref)!}}),
          ...additions.map(link_id => redo ? {kind: "restore_link" as const, link_id} : {kind: "unlink" as const, link_id, observed_add: {...group.coverage.links.get(link_id)!}}), ...positions];
        }});
      return {result: inverse.result, committed: this.track(group, inverse.result, eligible)};
    };
    return {refs, documents, result: admitted.result, committed: completion};
  }
  insertReference(args: {placement: OutlinePlacement; target: import("@/lib/resourceGraph/links").LinkTarget; label: string; change: OutlineChange}): AdmittedStructure {
    this.boundary();
    const group = this.reserve(args.change), origin = Symbol("outline reference");
    this.hold(group, [args.placement.parent]);
    let relationship = "", added = false;
    const eligible = this.groups();
    const admitted = this.runtime.admitWriting({existing: this.participants(group.documents, origin), notes: [], mutate: () => {},
      prepare: async () => {
        const endpoint = await prepareTarget(this.runtime, args.target), position = await this.placement(args.placement);
        if (!group.refs.includes(endpoint.ref)) group.refs.push(endpoint.ref);
        const prepared = await prepareLink(this.runtime, {source_ref: args.placement.parent_ref, target_ref: endpoint.ref, source_label: null, target_label: args.label, ...position});
        relationship = prepared.link_id; added = prepared.intents.some(intent => intent.kind === "add_link");
        if (added) group.coverage.links.set(relationship, {});
        return [...endpoint.intents, ...prepared.intents];
      }});
    group.apply = (redo, lower) => {
      const eligible = this.groups();
      const inverse = this.runtime.admitWriting({existing: this.participants(group.documents, origin), notes: [], mutate: () => {},
        prepare: async () => {await lower; return added ? [redo ? {kind: "restore_link", link_id: relationship}
          : {kind: "unlink", link_id: relationship, observed_add: {...group.coverage.links.get(relationship)!}}] : [];}});
      return {result: inverse.result, committed: this.track(group, inverse.result, eligible)};
    };
    const committed = this.track(group, admitted.result, eligible, receipt => {
      added = receipt.change.links.some(link => link.link_id === relationship && Object.keys(link.add_vv).length > 0);
      if (!added) group.coverage.links.delete(relationship);
    }); return {result: admitted.result, committed};
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const group of this.groups()) this.release(group);
    for (const history of this.texts.values()) this.pruneText(history);
    this.focus = null;
  }
}
function scope(document: WritingDocument) {return document.ref.startsWith("page:") ? document.doc.getText("title") : [document.doc.getXmlFragment("body"), bodyInline(document.doc)];}
function positionAt(link: LinkState, endpoint: string) {return link.endpoint_a === endpoint ? link.position_a : link.position_b;}
function restorePositions(current: Settlement, desired: ReadonlyMap<string, LinkState>, endpoint: string): Intent[] {
  return current.links.flatMap(link => {
    const expected = positionAt(link, endpoint), previous = desired.get(link.link_id), position = previous ? positionAt(previous, endpoint) : null;
    return expected && position ? [{kind: "restore_position" as const, link_id: link.link_id, endpoint_ref: endpoint, expected: expected.stamp, position: position.value}] : [];
  });
}
