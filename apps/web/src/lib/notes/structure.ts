/** Session-scoped outline chronology. Each gesture reserves its real documents,
 * Yjs inverse and graph command synchronously. Receipts extend only the groups
 * eligible at admission; graph inverses freeze that coverage at their own slot.
 * No clone survives a gesture and no receipt chooses which command to undo. */
import * as Y from "yjs";
import {applyBodyEdits, bodyInline, hydrateNote, readBody, sliceInline} from "@nexus/authored/documents";
import {parseBody, type NoteBody} from "@nexus/authored/body";
import {type Intent} from "@nexus/authored/commands";
import {linkId} from "@nexus/authored/identity";
import {advanceCoverage, isVisible, mergeVector} from "@nexus/authored/merge";
import type {LinkState, MergeResult, Vector} from "@nexus/authored/types";
import {preparePosition, preparePositions, prepareLink, prepareTarget} from "@/lib/resourceGraph/links";
import {lowerGraph, LocalCommitError, type GraphIntent, type LocalCommit, type LocalGraphCommit, type WritingDocument, type WritingRuntime} from "./runtime";
import type {DisplayedSplit, FocusSelection, NoteEdit} from "./editorTypes";
import type {InputBookmark, Placement, RangePlan, RangeReason, RangeSnapshot} from "./outlineSelection";

export interface EditorHistory {
  origin: unknown;
  retain(): () => void;
  undo(): void;
  redo(): void;
  boundary(): void;
  record(edit?: Pick<NoteEdit, "selectionBefore" | "selectionAfter">, admission?: number, bookmark?: InputBookmark): void;
}
export interface OccurrenceBookmark {
  row_id: string; ref: string; placement: Placement | null; link: LinkState | Promise<LinkState> | null;
}
export interface OutlinePlacement {
  parent_ref: string; parent: WritingDocument | null;
  after_ref: string | null; before_ref: string | null;
}
export interface OutlineOccurrence {
  ref: string; parent_ref: string; document: WritingDocument | null; parent: WritingDocument | null;
  link: LinkState | Promise<LinkState>;
}
export interface OutlineChange {before: InputBookmark; after: InputBookmark; placements_before?: readonly OccurrenceBookmark[]; placements_after?: readonly OccurrenceBookmark[]}
export interface OutlineVisibility {show: readonly OccurrenceBookmark[]; hide: readonly OccurrenceBookmark[]}
export interface OutlineBirthChange {before: InputBookmark; after(document: WritingDocument): InputBookmark; placements_before?: readonly OccurrenceBookmark[]; placements_after?(document: WritingDocument): readonly OccurrenceBookmark[]}
export interface DisplayedWriting {body_state: string; observed: Promise<Vector>}
export interface RangeRestoration {plan: RangePlan; members: readonly Placement[]}
export interface RangePublication {
  snapshot: RangeSnapshot;
  accepted(plan: RangePlan, links: ReadonlyMap<string, Promise<LinkState>>, committed: Promise<LocalCommit>, mayFocus: () => boolean, members: readonly Placement[], confirmed: Promise<RangeRestoration>): void;
  refused(): void;
}
export interface AdmittedStructure {result: Promise<LocalCommit>; committed: Promise<LocalCommit>}
export interface AdmittedLink extends AdmittedStructure {link: Promise<LinkState>}
export interface AdmittedNote extends AdmittedLink {document: WritingDocument}
export interface AdmittedJoin extends AdmittedStructure {selection: (document: WritingDocument) => FocusSelection}
/** Extend only the membership this occurrence already observed. A command may
 * carry several patches for one pair; every extension uses its actual prestate. */
export function advanceRelationship(link: LinkState, receipt: LocalCommit): LinkState {
  const before = receipt.before.links.find(state => state.link_id === link.link_id);
  let covered = link.add_vv;
  for (const patch of receipt.change.links) if (patch.link_id === link.link_id)
    covered = advanceCoverage(covered, before ? {touch: before.add_vv, removed: before.remove_vv} : null, patch.add_vv);
  return {...link, add_vv: covered};
}
interface Coverage {resources: Map<string, Vector>; links: Map<string, Vector>}
interface Settlement {store_revision: string; links: readonly LinkState[]}
interface Group {
  refs: string[]; documents: WritingDocument[]; metadata(): unknown;
  before: InputBookmark; after: InputBookmark; placements_before: readonly OccurrenceBookmark[]; placements_after: readonly OccurrenceBookmark[]; coverage: Coverage;
  suspended: number; range: {replay(redo: boolean, lower: Promise<Settlement | null>, mayFocus: () => boolean): boolean} | null;
  added: readonly OccurrenceBookmark[]; removed: readonly OccurrenceBookmark[];
  settled: Promise<Settlement | null>; receipt: Settlement | null; released: boolean;
  apply(redo: boolean, lower: Promise<Settlement | null>): AdmittedStructure;
  cleanup(): void;
}
interface TextHistory {
  document: WritingDocument; manager: Y.UndoManager; origin: symbol;
  latest: object | null; latestGroup: Group | null; active: number; groups: number; captureBytes: number; unsubscribe(): void;
}
interface FocusOwner {
  capture(): InputBookmark;
  lease(): () => boolean;
  prepare?(target: readonly OccurrenceBookmark[], source: readonly OccurrenceBookmark[], mayFocus: () => boolean, visibility: OutlineVisibility): (committed: Promise<LocalCommit>) => void;
  publish(documents: readonly WritingDocument[], target: InputBookmark, source: InputBookmark, mayFocus: () => boolean, committed: Promise<LocalCommit>): void;
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
  retainedOccurrences(): ReadonlySet<string> {return new Set(this.groups().flatMap(group => [...inputRows(group.before), ...inputRows(group.after), ...group.added.map(row => row.row_id), ...group.removed.map(row => row.row_id)]));}
  retainedRows(): ReadonlySet<string> {return new Set(this.groups().flatMap(group => [...inputRows(group.before), ...inputRows(group.after), ...[...group.placements_before, ...group.placements_after, ...group.added, ...group.removed]
    .flatMap(row => [row.row_id, row.placement?.parent_id, row.placement?.after_id, row.placement?.before_id]).filter((key): key is string => typeof key === "string")]));}
  retainedBytes(): number {return this.groups().reduce((bytes, group) => bytes + new TextEncoder().encode(JSON.stringify({
    refs: group.refs, before: group.before, after: group.after, placements_before: group.placements_before, placements_after: group.placements_after, added: group.added, removed: group.removed, receipt: group.receipt,
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
  canUndo(): boolean {return this.past.some(group => !group.released && group.suspended === 0);}
  canRedo(): boolean {return this.future.some(group => !group.released && group.suspended === 0);}
  undo = (): void => {this.replay(false);};
  redo = (): void => {this.replay(true);};
  private groups(): Group[] {return [...this.past, ...this.future];}
  private reserve(change: OutlineChange, provisional = false): Group {
    if (this.closed) throw new Error("outline history is closed");
    if (!provisional) for (const discarded of this.future) this.release(discarded);
    const group: Group = {refs: [], documents: [], metadata: () => null, before: change.before, after: change.after, placements_before: change.placements_before ?? [], placements_after: change.placements_after ?? [], suspended: 0, range: null,
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
      group.added = []; group.removed = []; group.placements_before = []; group.placements_after = []; group.range = null; group.receipt = null;
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
    const group = from.findLast(group => !group.released && group.suspended === 0); if (!group) return;
    this.boundary();
    const owner = this.focus, mayFocus = owner?.lease() ?? (() => true);
    const target = redo ? group.after : group.before, source = redo ? group.before : group.after;
    if (group.range) {
      const lower = group.settled;
      if (!group.range.replay(redo, lower, mayFocus)) return;
      from.splice(from.indexOf(group), 1); to.push(group);
      return;
    }
    const acknowledge = owner?.prepare?.(redo ? group.placements_after : group.placements_before, redo ? group.placements_before : group.placements_after, mayFocus, {show: redo ? group.added : group.removed, hide: redo ? group.removed : group.added});
    const lower = group.settled;
    try {
      const admission = group.apply(redo, lower);
      from.splice(from.indexOf(group), 1); to.push(group);
      acknowledge?.(admission.committed);
      owner?.publish(group.documents, target, source, mayFocus, admission.committed);
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
  private relationship(rows: readonly OccurrenceBookmark[], link: LinkState | Promise<LinkState>): readonly OccurrenceBookmark[] {
    return rows.map(row => ({...row, link}));
  }
  private createdLink(completion: Promise<LocalCommit>, id: () => string): Promise<LinkState> {
    const result = completion.then(receipt => {
      const link = receipt.change.links.find(link => link.link_id === id());
      if (!link) throw new Error("outline creation receipt has no relationship");
      return advanceRelationship({...link, add_vv: {}}, receipt);
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
        const raw: InputBookmark = current?.kind === "text" ? {kind: "text", row_id: current.row_id, ref: current.ref,
          range: current.range, resolve: null, ...(current.root ? {root: current.root} : {})} : current;
        const after = raw?.kind === "text" && edit ? {...raw, range: edit.selectionAfter,
          resolve: current?.kind === "text" && current.root ? current.resolve : null} : raw;
        const item = history.manager.undoStack.at(-1); if (!item) return;
        let group = history.latest === item ? history.latestGroup : null;
        if (!group) {
          group = this.reserve({before: raw?.kind === "text" && edit ? {...raw, range: edit.selectionBefore,
            resolve: current?.kind === "text" ? current.resolveBefore ?? null : null} : raw, after});
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
    const group = this.reserve({before: change.before, after: null, placements_before: change.placements_before}), origin = Symbol("outline birth");
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
    group.after = change.after(document); group.placements_after = change.placements_after?.(document) ?? [];
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
    group.placements_after = this.relationship(group.placements_after, link);
    group.added = group.placements_after;
    return {document, result: admitted.result, committed: completion, link};
  }
  join(args: {source: WritingDocument; destination: WritingDocument; displayed: {source: DisplayedWriting; destination: DisplayedWriting}; sourceOccurrence: OccurrenceBookmark; change: OutlineChange}): AdmittedJoin {
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
    const group = this.reserve({...change, after: change.after?.kind === "text" ? {...change.after, resolve: selection} : change.after});
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
  range(args: {
    plan: RangePlan; documents: readonly WritingDocument[]; snapshot: RangeSnapshot; metadata(): unknown; canRetain(): boolean;
    prepare(): Promise<{kind: "plan"; plan: RangePlan; snapshot: RangeSnapshot; occurrences: readonly OccurrenceBookmark[]} | {kind: "refusal"; reason: RangeReason}>;
    active(): boolean;
    publication: RangePublication; reserve(action: "undo" | "redo"): RangePublication;
    refused(reason: RangeReason): void;
  }): void {
    this.boundary();
    const redo = this.future.filter(group => !group.released);
    for (const group of redo) group.suspended++;
    const group = this.reserve({before: args.plan.selection_before, after: args.plan.selection_after}, true);
    this.hold(group, args.documents);
    let refused = false, accepted = false;
    let plan = args.plan, sourceSnapshot = args.snapshot;
    const physical = new Map<string, {before: Placement; after: Placement | null; source: LinkState; destination: LinkState | null}>();
    const byOccurrence = new Map<string, LinkState>();
    const previous = new Map<string, {link: LinkState; endpoint: string}>();
    group.metadata = () => ({snapshot: args.snapshot, source_snapshot: sourceSnapshot === args.snapshot ? null : sourceSnapshot, pending: args.metadata(), plan, physical: [...physical], occurrences: [...byOccurrence], previous: [...previous]});
    const releaseRedo = (retire: boolean) => {for (const target of redo) {target.suspended--; if (retire) this.release(target);}};
    const track = (admission: ReturnType<WritingRuntime["admitGraph"]>, eligible: readonly Group[]) => {
      const barrier = admission.committed.then(receipt => {
        if (!receipt) return null;
        this.cover(receipt, eligible);
        const settlement = {store_revision: receipt.store_revision, links: receipt.change.links};
        if (group.settled === barrier) group.receipt = settlement;
        return settlement;
      });
      group.settled = barrier;
      void barrier.catch(this.failure);
      void admission.result.catch(this.failure);
    };
    const relationship = (placement: Placement, committed: Promise<LocalGraphCommit>): Promise<LinkState> => {
      const observed = byOccurrence.get(placement.row_id)!, destination = physical.get(observed.link_id)?.destination;
      const basis = destination && ((placement.ref === destination.endpoint_a && placement.parent_ref === destination.endpoint_b) ||
        (placement.ref === destination.endpoint_b && placement.parent_ref === destination.endpoint_a)) ? destination : observed;
      const future = committed.then(receipt => {
        const positioned = receipt.states.links.find(link => link.link_id === basis.link_id)!;
        return advanceRelationship({...positioned, add_vv: basis.add_vv}, receipt);
      });
      void future.catch(() => {}); return future;
    };
    const install = (value: RangePlan, completion: Promise<LocalGraphCommit | null>, mayFocus: () => boolean, publication: RangePublication, states: MergeResult) => {
      const graph = completion.then(receipt => {if (!receipt) throw new Error("accepted range has no receipt"); return receipt;});
      const committed = graph.then(({states: _states, ...receipt}) => receipt);
      const restored = reconcileRange(value, sourceSnapshot, publication.snapshot, states, byOccurrence, physical);
      const links = new Map<string, Promise<LinkState>>();
      for (const placement of [...value.changes.flatMap(change => change.after ? [change.after] : []), ...restored.members])
        if (byOccurrence.has(placement.row_id)) links.set(placement.row_id, relationship(placement, graph));
      const confirmed = graph.then(receipt => reconcileRange(value, sourceSnapshot, publication.snapshot, receipt.states, byOccurrence, physical));
      publication.accepted(restored.plan, links, committed, mayFocus, restored.members, confirmed);
    };
    const replay = (redo: boolean, lower: Promise<Settlement | null>, mayFocus: () => boolean) => {
      const eligible = this.groups(), publication = args.reserve(redo ? "redo" : "undo");
      if (!args.canRetain()) {publication.refused(); args.refused("capacity"); return false;}
      let published = false;
      const admission = this.runtime.admitGraph<RangeReason>({active: () => !this.closed && !refused, retired: "retired", changed: "changed", capacity: null,
        prepare: async () => {
          const current = await lower;
          if (refused || !accepted || !current) return {kind: "refusal", reason: "retired"};
          const value: RangePlan = redo ? plan : {...plan,
            changes: plan.changes.map(change => ({before: change.after ?? change.before, after: change.before})),
            selection_before: plan.selection_after, selection_after: plan.selection_before};
          const intents: GraphIntent[] = [];
          for (const item of physical.values()) {
            intents.push(redo ? {kind: "unlink", link_id: item.source.link_id, observed_add: {...group.coverage.links.get(item.source.link_id)!}}
              : {kind: "restore_link", link_id: item.source.link_id});
            if (item.destination) intents.push(redo ? {kind: "restore_link", link_id: item.destination.link_id}
              : {kind: "unlink", link_id: item.destination.link_id, observed_add: {...group.coverage.links.get(item.destination.link_id)!}});
          }
          const first = await forward;
          for (const {link, endpoint} of previous.values()) {
            const actual = current.links.findLast(item => item.link_id === link.link_id && positionAt(item, endpoint) !== null);
            const desired = redo ? first.findLast(item => item.link_id === link.link_id && positionAt(item, endpoint) !== null) : link;
            const expected = actual ? positionAt(actual, endpoint) : null, position = desired ? positionAt(desired, endpoint) : null;
            if (expected && position) intents.push({kind: "restore_position", link_id: link.link_id, endpoint_ref: endpoint, expected: expected.stamp, position: position.value});
          }
          return {kind: "ready", intents, preflight_revision: null, selection: {
            refs: [...new Set([...sourceSnapshot.rows, ...publication.snapshot.rows].flatMap(row => row.ref ? [row.ref] : []))],
            link_ids: [...new Set([...sourceSnapshot.rows, ...publication.snapshot.rows].flatMap(row => row.link_id ? [row.link_id] : []).concat(
              [...physical.values()].flatMap(item => [item.source.link_id, ...(item.destination ? [item.destination.link_id] : [])]), [...previous.values()].map(item => item.link.link_id)))],
          }, accepted: states => {published = true; install(value, admission.committed, mayFocus, publication, states);}};
        }});
      track(admission, eligible);
      void admission.result.then(result => {if (result.kind === "refusal") publication.refused();}).catch(() => {if (!published) publication.refused();});
      return true;
    };
    group.range = {replay};
    const mayFocus = this.focus?.lease() ?? (() => false), eligible = this.groups();
    const admission = this.runtime.admitGraph<RangeReason>({active: () => !this.closed && args.active(), retired: "retired", changed: "changed", capacity: "capacity",
      prepare: async () => {
        const prepared = await args.prepare();
        if (prepared.kind === "refusal") return prepared;
        plan = prepared.plan; sourceSnapshot = prepared.snapshot; group.before = plan.selection_before; group.after = plan.selection_after;
        const rows = new Map(prepared.occurrences.map(row => [row.row_id, row]));
        for (const id of inputRows(plan.selection_before)) {
          const link = await rows.get(id)?.link;
          if (link) byOccurrence.set(id, link);
        }
        const intents: GraphIntent[] = [], destinations = new Set<string>();
        const store = await this.runtime.store, replica = await store.readReplica();
        for (const change of plan.changes) {
          const occurrence = rows.get(change.before.row_id), source = await occurrence?.link;
          if (!source || occurrence?.ref !== change.before.ref || (source.endpoint_a === change.before.ref ? source.endpoint_b : source.endpoint_a) !== change.before.parent_ref)
            return {kind: "refusal", reason: "changed"};
          const resourceRefs = [change.before.ref, change.before.parent_ref, ...(change.after ? [change.after.parent_ref] : [])];
          const current = await store.readStates({refs: resourceRefs, link_ids: [source.link_id], anchor_ids: [], source_refs: []});
          const known = current.links[0];
          if (!known || !isVisible(known.add_vv, known.remove_vv) || resourceRefs.some(ref => {
            if (!/^(note_block|page|highlight):/u.test(ref)) return false;
            const resource = current.resources.find(resource => resource.ref === ref);
            return !resource || !isVisible(resource.touch_vv, resource.delete_vv);
          })) return {kind: "refusal", reason: "changed"};
          byOccurrence.set(change.before.row_id, source);
          const existing = physical.get(source.link_id);
          if (existing) {
            const anchorRef = (id: string | null | undefined) => id ? rows.get(id)?.ref : null;
            if ((existing.after !== null || change.after !== null) && (existing.before.ref !== change.before.ref || existing.before.parent_ref !== change.before.parent_ref ||
              existing.after?.parent_ref !== change.after?.parent_ref || anchorRef(existing.after?.after_id) !== anchorRef(change.after?.after_id) ||
              anchorRef(existing.after?.before_id) !== anchorRef(change.after?.before_id))) return {kind: "refusal", reason: "shared_edge"};
            existing.source = {...existing.source, add_vv: mergeVector(existing.source.add_vv, source.add_vv)};
            group.coverage.links.set(source.link_id, existing.source.add_vv);
            continue;
          }
          let destination: LinkState | null = null;
          if (change.after) {
            const id = await this.identity(change.after.parent_ref, change.after.ref);
            if (destinations.has(id)) return {kind: "refusal", reason: "collision"};
            destinations.add(id);
            const known = (await store.readStates({refs: [], link_ids: [id], anchor_ids: [], source_refs: []})).links[0];
            if (known && isVisible(known.add_vv, known.remove_vv)) return {kind: "refusal", reason: "collision"};
            const [a, b] = change.after.parent_ref < change.after.ref ? [change.after.parent_ref, change.after.ref] : [change.after.ref, change.after.parent_ref];
            destination = {link_id: id, endpoint_a: a, endpoint_b: b, add_vv: {}, remove_vv: {}, position_a: null, position_b: null};
          }
          physical.set(source.link_id, {before: change.before, after: change.after, source, destination});
          group.coverage.links.set(source.link_id, source.add_vv);
          if (destination) group.coverage.links.set(destination.link_id, {});
        }
        const endpointInsertions = new Map<string, {link_id: string; after: string | null; before: string | null}[]>();
        const addInsertion = (endpoint: string, insertion: {link_id: string; after: string | null; before: string | null}) => {
          const items = endpointInsertions.get(endpoint) ?? []; items.push(insertion); endpointInsertions.set(endpoint, items);
        };
        for (const item of physical.values()) if (item.after && item.destination) {
          const anchor = async (id: string | null): Promise<string | null> => {
            if (id === null) return null;
            const planned = [...physical.values()].find(planned => planned.after?.row_id === id && planned.after.parent_ref === item.after!.parent_ref);
            if (planned?.destination) return planned.destination.link_id;
            const row = rows.get(id); return row ? this.identity(item.after!.parent_ref, row.ref) : null;
          };
          addInsertion(item.after.parent_ref, {link_id: item.destination.link_id, after: await anchor(item.after.after_id), before: await anchor(item.after.before_id)});
          addInsertion(item.after.ref, {link_id: item.destination.link_id, after: null, before: null});
        }
        const positions = new Map<string, ReadonlyMap<string, string>>();
        for (const [endpoint, insertions] of endpointInsertions) {
          const prepared = await preparePositions(this.runtime, endpoint, insertions);
          if (prepared.kind === "refusal") return {kind: "refusal", reason: prepared.reason === "capacity" ? "capacity" : "changed"};
          positions.set(endpoint, prepared.values); intents.push(...prepared.moves);
          for (const move of prepared.moves) if (move.kind === "move_link") {
            const link = prepared.previous.find(link => link.link_id === move.link_id)!;
            previous.set(endpoint + "/" + link.link_id, {link, endpoint});
          }
        }
        for (const item of physical.values()) {
          intents.push({kind: "unlink", link_id: item.source.link_id, observed_add: item.source.add_vv});
          if (item.destination) {
            const link = item.destination;
            intents.push({kind: "add_link", link_id: link.link_id, endpoint_a: link.endpoint_a, endpoint_b: link.endpoint_b,
              position_a: positions.get(link.endpoint_a)!.get(link.link_id)!, position_b: positions.get(link.endpoint_b)!.get(link.link_id)!});
          }
        }
        // A history group is admitted only when both replay directions fit,
        // including the one lane owned receipts can extend and longer old keys.
        const maximum = "9223372036854775807";
        const forwardContext = {replica_id: replica.replica_id, command_seq: "9223372036854775805", lamport: "9223372036854775805"};
        const backwardContext = {replica_id: replica.replica_id, command_seq: "9223372036854775806", lamport: "9223372036854775806"};
        const replayContext = {replica_id: replica.replica_id, command_seq: maximum, lamport: maximum};
        const membership = (observed: Vector): Vector => ({...observed, [replica.replica_id]: maximum});
        const witnessStates = await store.readStates({refs: [], link_ids: [...new Set([...physical.values()].flatMap(item => [item.source.link_id,
          ...(item.destination ? [item.destination.link_id] : [])]).concat([...previous.values()].map(item => item.link.link_id)))], anchor_ids: [], source_refs: []});
        // Witness-only stamps force every positional guard to emit its full
        // payload, even when an independent live stamp would suppress replay.
        const baseline = {lamport: "9223372036854775804", replica_id: replica.replica_id};
        witnessStates.links = witnessStates.links.map(link => ({...link,
          position_a: link.position_a ? {...link.position_a, stamp: baseline} : null,
          position_b: link.position_b ? {...link.position_b, stamp: baseline} : null}));
        const forward = lowerGraph(forwardContext, intents.map(intent => intent.kind === "unlink" ? {...intent, observed_add: membership(intent.observed_add)} : intent), witnessStates);
        if (!forward) return {kind: "refusal", reason: "capacity"};
        const inverse: GraphIntent[] = [], replay: GraphIntent[] = [];
        for (const item of physical.values()) {
          inverse.push({kind: "restore_link", link_id: item.source.link_id});
          replay.push({kind: "unlink", link_id: item.source.link_id, observed_add: membership(item.source.add_vv)});
          if (item.destination) {
            inverse.push({kind: "unlink", link_id: item.destination.link_id, observed_add: {[replica.replica_id]: maximum}});
            replay.push({kind: "restore_link", link_id: item.destination.link_id});
          }
        }
        for (const {link, endpoint} of previous.values()) {
          const position = positionAt(link, endpoint)!, desired = positionAt(forward.states.links.find(item => item.link_id === link.link_id)!, endpoint)!;
          inverse.push({kind: "restore_position", link_id: link.link_id, endpoint_ref: endpoint, expected: desired.stamp, position: position.value});
          replay.push({kind: "restore_position", link_id: link.link_id, endpoint_ref: endpoint, expected: {lamport: backwardContext.lamport, replica_id: replica.replica_id}, position: desired.value});
        }
        const backward = lowerGraph(backwardContext, inverse, forward.states);
        if (!backward || !lowerGraph(replayContext, replay, backward.states)) return {kind: "refusal", reason: "capacity"};
        group.placements_before = [...physical.values()].map(item => ({row_id: item.before.row_id, ref: item.before.ref, placement: item.before, link: item.source}));
        group.placements_after = [...physical.values()].flatMap(item => item.after ? [{row_id: item.after.row_id, ref: item.after.ref, placement: item.after, link: item.destination}] : []);
        group.refs = [...new Set([...group.refs, ...plan.changes.flatMap(change => [change.before.ref, change.before.parent_ref, ...(change.after ? [change.after.parent_ref] : [])])])];
        if (!args.canRetain())
          return {kind: "refusal", reason: "capacity"};
        if ((await store.readReplica()).store_revision !== replica.store_revision) return {kind: "refusal", reason: "changed"};
        return {kind: "ready", intents, preflight_revision: replica.store_revision, selection: {refs: [...rows.values()].map(row => row.ref),
          link_ids: [...new Set([...rows.values()].flatMap(row => row.link && "link_id" in row.link ? [row.link.link_id] : []).concat([...physical.values()].flatMap(item => item.destination ? [item.destination.link_id] : [])))]}, accepted: states => {
          accepted = true; releaseRedo(true);
          install(plan, admission.committed, mayFocus, args.publication, states);
        }};
      }});
    const forward = admission.committed.then(receipt => receipt?.change.links ?? []);
    track(admission, eligible);
    void admission.result.then(result => {
      if (result.kind !== "refusal") return;
      refused = true; releaseRedo(false); this.release(group); args.publication.refused(); args.refused(result.reason);
    }).catch(() => {
      if (!accepted) {refused = true; releaseRedo(false); this.release(group); args.publication.refused();}
    });
  }
  move(args: {occurrence: OutlineOccurrence; placement: OutlinePlacement; change: OutlineChange}): AdmittedLink {
    this.boundary();
    const group = this.reserve(args.change), origin = Symbol("outline move");
    this.hold(group, [args.occurrence.document, args.occurrence.parent, args.placement.parent]);
    if (!group.refs.includes(args.placement.parent_ref)) group.refs.push(args.placement.parent_ref);
    const previous = new Map<string, LinkState>(), source = Promise.resolve(args.occurrence.link), endpoint = args.placement.parent_ref;
    group.placements_before = this.relationship(group.placements_before, args.occurrence.link);
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
    group.placements_after = this.relationship(group.placements_after, link);
    void link.catch(() => {}); return {result: admitted.result, committed: completion, link};
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

function inputRows(bookmark: InputBookmark): readonly string[] {return bookmark?.kind === "blocks" ? bookmark.row_ids : bookmark?.kind === "text" ? [bookmark.row_id] : [];}

/** Reconcile presentation from the already lowered canonical graph. Receipt
 * coverage still belongs to the frozen per-occurrence proofs above. */
function reconcileRange(plan: RangePlan, original: RangeSnapshot, displayed: RangeSnapshot, states: MergeResult,
  observed: ReadonlyMap<string, LinkState>, physical: ReadonlyMap<string, {source: LinkState; destination: LinkState | null}>,
): RangeRestoration {
  const links = new Map(states.links.map(link => [link.link_id, link])), resources = new Map(states.projections.map(resource => [resource.ref, resource]));
  const rows = new Map(original.rows.map(row => [row.row_id, {...row}]));
  for (const row of displayed.rows) {
    const link = row.link_id ? links.get(row.link_id) : null;
    if (!rows.has(row.row_id) || !row.selectable || link && isVisible(link.add_vv, link.remove_vv)) rows.set(row.row_id, {...row});
  }
  const live = (ref: string | null) => ref === null || !/^(note_block|page|highlight):/u.test(ref) || resources.get(ref)?.visible === true;
  for (const change of plan.changes) {
    const row = rows.get(change.before.row_id); if (!row) continue;
    if (!change.after) {
      const source = observed.get(row.row_id), link = source ? links.get(source.link_id) : null;
      if (!link || !isVisible(link.add_vv, link.remove_vv)) rows.delete(row.row_id);
      else rows.set(row.row_id, {...row, ref: change.before.ref, parent_id: change.before.parent_id,
        parent_ref: change.before.parent_ref, link_id: link.link_id});
      continue;
    }
    const source = observed.get(row.row_id)!, item = physical.get(source.link_id)!, destination = item.destination;
    const target = destination && (destination.endpoint_a === change.after.ref ? destination.endpoint_b : destination.endpoint_a) === change.after.parent_ref ? destination : source;
    rows.set(row.row_id, {...row, ref: change.after.ref, parent_id: change.after.parent_id, parent_ref: change.after.parent_ref, link_id: target.link_id});
  }
  const visible = (id: string): boolean => {
    const visited = new Set<string>(); let row = rows.get(id);
    while (row) {
      if (visited.has(row.row_id) || !live(row.ref) || !live(row.parent_ref)) return false;
      visited.add(row.row_id);
      if (row.selectable) {const link = row.link_id ? links.get(row.link_id) : null; if (!link || !isVisible(link.add_vv, link.remove_vv)) return false;}
      if (row.parent_id === null) return true;
      row = rows.get(row.parent_id);
    }
    return false;
  };
  const placement = (row_id: string): Placement | null => {
    const row = rows.get(row_id);
    if (!row?.ref || !row.parent_id || !visible(row_id)) return null;
    const siblings = [...rows.values()].filter(peer => peer.parent_id === row.parent_id && peer.selectable && visible(peer.row_id));
    siblings.sort((a, b) => {
      const left = links.get(a.link_id!)!, right = links.get(b.link_id!)!, x = positionAt(left, row.parent_ref)!.value, y = positionAt(right, row.parent_ref)!.value;
      return x < y ? -1 : x > y ? 1 : left.link_id < right.link_id ? -1 : left.link_id > right.link_id ? 1 : 0;
    });
    const at = siblings.findIndex(peer => peer.row_id === row_id);
    return {row_id, ref: row.ref, parent_id: row.parent_id, parent_ref: row.parent_ref, after_id: siblings[at - 1]?.row_id ?? null, before_id: siblings[at + 1]?.row_id ?? null};
  };
  const changes = plan.changes.map(change => ({...change, after: placement(change.before.row_id)}));
  let selection_after = plan.selection_after;
  if (selection_after?.kind === "blocks") {
    const row_ids = selection_after.row_ids.filter(visible);
    selection_after = row_ids.length ? {...selection_after, row_ids, anchor_id: row_ids.includes(selection_after.anchor_id) ? selection_after.anchor_id : row_ids[0]!,
      head_id: row_ids.includes(selection_after.head_id) ? selection_after.head_id : row_ids[row_ids.length - 1]!} : null;
  } else if (selection_after && !visible(selection_after.row_id)) selection_after = null;
  const members = selection_after?.kind === "blocks" ? selection_after.row_ids.flatMap(id => {const row = placement(id); return row ? [row] : [];}) : [];
  return {plan: {...plan, changes, selection_after}, members};
}
