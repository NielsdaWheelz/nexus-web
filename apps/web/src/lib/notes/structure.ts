/** Session-scoped outline history. Structural edits copy the displayed content,
 * delete only observed character ids, and compose text/graph inverses into one
 * local command. A joined source can revive; links never redirect or cascade. */
import * as Y from "yjs";
import { applyBodyEdits, bodyInline, encodeBytes, hydrateNote, readBody, sliceInline } from "@nexus/authored/documents";
import { emptyBody, parseBody } from "@nexus/authored/body";
import { insertionPositions, type Intent } from "@nexus/authored/commands";
import { linkId } from "@nexus/authored/identity";
import {advanceCoverage} from "@nexus/authored/merge";
import type { ClipItem } from "./clipboard";
import type { FocusSelection, NoteEdit } from "./editorTypes";
import type { LinkState, Vector } from "@nexus/authored/types";
import { endpointForResource, preparePosition, prepareLink } from "@/lib/resourceGraph/links";
import { LocalCommitError, type LocalCommit, type WritingDocument, type WritingRuntime } from "./runtime";
export interface EditorHistory {
  origin: unknown;
  retain(): () => void;
  undo(): void;
  redo(): void;
  boundary(): void;
  record(edit?: Pick<NoteEdit, "selectionBefore" | "selectionAfter">, admission?: number, bookmark?: OutlineBookmark): void;
}
export interface OutlineBookmark { key: string; ref: string; selection: FocusSelection | null; resolve?: (document: WritingDocument) => FocusSelection;
  occurrence?: {parent_ref: string; link_id: string; parent_id?: string} }
export interface CreatedOutlineNote { ref: string; link_id: string; store_revision: string; body_state: string; observed_touch: Vector; observed_add: Vector; input_offset: number; source_before?: {touch: Vector; removed: Vector} | null }
interface Coverage { resources: Map<string, Vector>; links: Map<string, Vector> }
interface Group { kind: "text" | "structure"; admission: number; coverage?: Coverage; refs: string[]; bytes: number; before?: OutlineBookmark | null; after?: OutlineBookmark | null; undo(): Promise<void>; redo(): Promise<void>; release(): void }
interface TextHistory { document: WritingDocument; manager: Y.UndoManager; origin: symbol; latest: object | null; latestGroup: Group | null; active: number; groups: number; unsubscribe(): void }
interface FocusOwner {
  capture(): OutlineBookmark | null;
  restore(bookmark: OutlineBookmark, mayFocus?: () => boolean): Promise<void>;
  lease(): () => boolean;
  prepare?(target: OutlineBookmark | null, source: OutlineBookmark | null, mayFocus: () => boolean): (store_revision: string) => void;
}
export class OutlineHistory {
  private readonly past: Group[] = [];
  private readonly future: Group[] = [];
  private readonly texts = new Map<string, TextHistory>();
  private tail: Promise<void> = Promise.resolve();
  private closed = false;
  private sequence = 0;
  private revision = "0";
  private readonly TypingOrigin = class {};
  typingOrigin(): unknown {return new this.TypingOrigin();}
  retainedRefs(): ReadonlySet<string> { return new Set([...this.past, ...this.future].flatMap(group => group.refs)); }
  retainedRows(): ReadonlySet<string> {return new Set([...this.past, ...this.future].flatMap(group => [group.before?.key, group.after?.key, group.before?.occurrence?.parent_id, group.after?.occurrence?.parent_id].filter((key): key is string => key !== undefined)));}
  retainedBytes(): number { return [...this.past, ...this.future].reduce((bytes, group) => bytes + group.bytes, 0); }
  /** Evict an undo prefix atomically. A redo branch cannot lose a dependency. */
  releaseOldest(): boolean {
    const oldest = this.past.shift();
    if (oldest) {oldest.release(); return true;}
    if (!this.future.length) return false;
    for (const group of this.future.splice(0)) group.release();
    return true;
  }
  admit(): number { return ++this.sequence; }
  boundary(): void { this.stopTyping(); }
  private focus: FocusOwner | null = null;
  bindFocus(owner: FocusOwner): () => void {
    this.focus = owner;
    return () => { if (this.focus === owner) this.focus = null; };
  }
  /** Reserve structural chronology at admission. Later typing remains later,
   * and undo waits for the complete operation and its selection bookmark. */
  withFocus<T>(before: OutlineBookmark | null, work: () => Promise<T>, after: (value: T) => OutlineBookmark | null, admission = this.admit()): Promise<T> {
    this.stopTyping();
    const operation = this.tail.then(async () => {
      const existing = new Set(this.past);
      const value = await work();
      const entry = this.past.find(group => group.kind === "structure" && !existing.has(group));
      if (entry) {
        entry.before = before; entry.after = after(value); entry.admission = admission;
        // Typing admitted while a reparent prepares belongs to that same
        // occurrence at its new key, even if its commit finished first.
        if (before && entry.after && before.ref === entry.after.ref && before.key !== entry.after.key)
          for (const later of this.past) if (later.kind === "text" && later.admission > admission)
            for (const field of ["before", "after"] as const) if (later[field]?.key === before.key && later[field]?.ref === before.ref) later[field] = {...later[field]!, key: entry.after.key};
        this.past.sort((a, b) => a.admission - b.admission);
      }
      return value;
    });
    // The caller owns this operation's error; subsequent history remains usable.
    this.tail = operation.then(() => undefined, () => undefined);
    return operation;
  }
  constructor(readonly runtime: WritingRuntime, private readonly failure: (error: unknown) => void) {}
  editor(document: WritingDocument, suppliedOrigin?: unknown): EditorHistory {
    // Retained input may finish after its mounted undo session has ended.
    if (this.closed) return {origin: suppliedOrigin ?? Symbol("finished outline typing"), retain: () => () => {}, undo: () => {}, redo: () => {}, boundary: () => {}, record: () => {}};
    let entry = this.texts.get(document.ref);
    if (!entry || entry.document !== document) {
      entry?.unsubscribe(); entry?.manager.destroy();
      const origin = Symbol("outline typing");
      const manager = new Y.UndoManager(document.ref.startsWith("page:") ? document.doc.getText("title") : [document.doc.getXmlFragment("body"), bodyInline(document.doc)], { trackedOrigins: new Set<unknown>([origin, this.TypingOrigin]), captureTimeout: 500 });
      let lastOrigin: unknown = null;
      const boundary = (transaction: Y.Transaction) => {
        const source = transaction.origin;
        if (source !== origin && !(source instanceof this.TypingOrigin) && source !== manager) return;
        if (lastOrigin !== source) manager.stopCapturing();
        lastOrigin = source;
      };
      document.doc.on("beforeTransaction", boundary);
      const stopCommitted = document.onCommitted((receipt, source) => { if (source === origin || source instanceof this.TypingOrigin || source === manager) this.cover(receipt); });
      entry = { document, origin, manager, latest: null, latestGroup: null,active:0,groups:0, unsubscribe: () => {document.doc.off("beforeTransaction", boundary); stopCommitted();} };
      this.texts.set(document.ref, entry);
    }
    const history = entry;
    return {
      origin: suppliedOrigin ?? history.origin,
      retain:()=>{history.active++;return()=>{history.active--;this.pruneText(history);};},
      undo: () => this.undo(), redo: () => this.redo(), boundary: () => history.manager.stopCapturing(),
      record: (edit, admission, bookmark) => {
        const current = bookmark ?? this.focus?.capture() ?? null;
        // An edit's numeric before/after positions are distinct from a resolver
        // captured after that edit. Do not attach that resolver to its before.
        const raw = current ? {key: current.key, ref: current.ref, selection: current.selection, ...(current.occurrence ? {occurrence: current.occurrence} : {})} : null;
        const after = raw && edit ? { ...raw, selection: edit.selectionAfter } : raw;
        const item = history.manager.undoStack.at(-1) ?? null;
        if (!item) return;
        if (history.latest === item) { if (history.latestGroup) history.latestGroup.after = after; return; }
        history.latest = item;
        let ownedItem=item;
        const unpin = document.retain();
        history.groups++;
        const release=()=>{
          unpin();history.groups--;history.manager.stopCapturing();
          const undo=history.manager.undoStack.filter(item=>item!==ownedItem);
          const redo=history.manager.redoStack.filter(item=>item!==ownedItem);
          history.manager.undoStack=history.manager.undoStack.filter(item=>item===ownedItem);
          history.manager.redoStack=history.manager.redoStack.filter(item=>item===ownedItem);
          history.manager.clear();
          history.manager.undoStack=undo;history.manager.redoStack=redo;
          if(history.latest===item){history.latest=null;history.latestGroup=null;}
          this.pruneText(history);
        };
        history.latestGroup = this.push({ kind: "text", refs: [document.ref], bytes: new TextEncoder().encode(JSON.stringify({before: raw, after})).byteLength,
          before: raw && edit ? { ...raw, selection: edit.selectionBefore } : raw, after,
          undo: async () => { history.manager.undo(); ownedItem=history.manager.redoStack.at(-1)??ownedItem; history.latest = null; await document.capture(); },
          redo: async () => { history.manager.redo(); ownedItem=history.manager.undoStack.at(-1)??ownedItem; history.latest = history.manager.undoStack.at(-1) ?? null; await document.capture(); }, release }, admission);
      },
    };
  }
  private pruneText(history:TextHistory):void {
    if(history.active===0 && history.groups===0 && this.texts.get(history.document.ref)===history){history.unsubscribe();history.manager.clear();history.manager.destroy();this.texts.delete(history.document.ref);}
  }
  private async commit(intent: Intent): Promise<LocalCommit> {
    let receipt: LocalCommit;
    try { receipt = await this.runtime.run(intent); }
    catch (error) { if (!(error instanceof LocalCommitError)) throw error; this.failure(error); receipt = await error.completion; }
    this.cover(receipt); return receipt;
  }
  /** Extend only identities already owned by a group, using this session's own
   * receipt dots. A remote addition/touch remains outside its inverse. */
  private cover(receipt: LocalCommit): void {
    if (BigInt(receipt.store_revision) > BigInt(this.revision)) this.revision = receipt.store_revision;
    for (const group of [...this.past, ...this.future]) {
      const coverage = group.coverage;
      if (!coverage) continue;
      for (const patch of receipt.change.resources) {
        const observed = coverage.resources.get(patch.ref), before = receipt.before.resources.find(state => state.ref === patch.ref);
        if (observed) coverage.resources.set(patch.ref, advanceCoverage(observed, before ? {touch: before.touch_vv, removed: before.delete_vv} : null, patch.touch_vv));
      }
      for (const patch of receipt.change.links) {
        const observed = coverage.links.get(patch.link_id), before = receipt.before.links.find(state => state.link_id === patch.link_id);
        if (observed) coverage.links.set(patch.link_id, advanceCoverage(observed, before ? {touch: before.add_vv, removed: before.remove_vv} : null, patch.add_vv));
      }
    }
  }
  private push(value: Omit<Group, "admission">, admission = this.admit()): Group | null {
    const group = {...value, admission};
    if (this.closed) { group.release(); return null; }
    for (const discarded of this.future.splice(0)) discarded.release();
    if (group.before === undefined) group.before = this.focus?.capture() ?? null;
    if (group.after === undefined) group.after = group.before;
    this.past.push(group);
    this.past.sort((a, b) => a.admission - b.admission);
    while (this.retainedRefs().size > 64 || this.retainedBytes() > 16 * 1024 * 1024) if (!this.releaseOldest()) break;
    return group;
  }
  private enqueue(work: () => Promise<void>): void {
    this.tail = this.tail.then(async () => { if (!this.closed) await work(); }).catch(this.failure);
  }
  undo = (): void => { const mayFocus = this.focus?.lease(); this.enqueue(async () => {
    const group = this.past.at(-1);
    if (!group) return;
    const settled = this.focus?.prepare?.(group.before ?? null, group.after ?? null, mayFocus ?? (() => true));
    const completion=group.undo();
    this.past.pop();this.future.push(group);
    await completion;
    settled?.(this.revision);
    if (group.before && (!mayFocus || mayFocus()) && !(group.before.key === group.after?.key && this.focus?.capture()?.key === group.before.key)) await this.focus?.restore(group.before, mayFocus);
  }); };
  redo = (): void => { const mayFocus = this.focus?.lease(); this.enqueue(async () => {
    const group = this.future.at(-1);
    if (!group) return;
    const settled = this.focus?.prepare?.(group.after ?? null, group.before ?? null, mayFocus ?? (() => true));
    const completion=group.redo();
    this.future.pop();this.past.push(group);
    await completion;
    settled?.(this.revision);
    if (group.after && (!mayFocus || mayFocus()) && !(group.after.key === group.before?.key && this.focus?.capture()?.key === group.after.key)) await this.focus?.restore(group.after, mayFocus);
  }); };
  private stopTyping(): void { for (const history of this.texts.values()) history.manager.stopCapturing(); }
  async create(parent_ref: string, after: string | null = null, body = emptyBody(), prelude: readonly Intent[] = []): Promise<CreatedOutlineNote> {
    this.stopTyping();
    const ref = `note_block:${crypto.randomUUID()}`;
    const placement = await prepareLink(this.runtime, { source_ref: parent_ref, target_ref: ref, source_label: null, target_label: null, after });
    const saved = await this.commit({ kind: "batch", intents: [...prelude, { kind: "create_note", ref, body }, ...placement.intents] });
    const created = saved.change.resources.find(resource => resource.ref === ref);
    if (created?.kind !== "note" || created.body_update === null) throw new Error("created note receipt has no body");
    const creation = created.touch_vv;
    const addition = saved.change.links.find(link => link.link_id === placement.link_id)!.add_vv;
    const coverage = causalCoverage([[ref, creation]], [[placement.link_id, addition]]);
    this.push({ kind: "structure", coverage, refs: [ref], bytes: new TextEncoder().encode(JSON.stringify({creation,addition})).byteLength,
      undo: async () => { await this.commit({kind:"batch",intents:[{kind:"delete_resource",ref,observed_touch:coverage.resources.get(ref)!},{kind:"unlink",link_id:placement.link_id,observed_add:coverage.links.get(placement.link_id)!}]}); },
      redo: async () => { await this.commit({kind:"batch",intents:[{kind:"restore_resource",ref},{kind:"restore_link",link_id:placement.link_id}]}); }, release:()=>{},
    });
    return { ref, link_id: placement.link_id, store_revision: saved.store_revision, body_state: created.body_update, observed_touch: creation, observed_add: addition, input_offset: 0 };
  }
  async paste(parent_ref:string,after:string|null,items:readonly ClipItem[],prelude:readonly Intent[]=[]):Promise<string[]> {
    this.stopTyping();
    const accountId=(await (await this.runtime.store).readReplica()).account_id;
    const refs=items.map(item=>item.kind==="note"?`note_block:${crypto.randomUUID()}`:item.ref);
    const positions=new Map<string,{last:string;upper:string|null}>();
    const moved=new Map<string,{link:LinkState;endpoint:string}>();
    const intents:Intent[]=[...prelude];
    const additions:string[]=[];
    for(const [index,item] of items.entries()){
      const parent=item.parent===null?parent_ref:refs[item.parent]!;
      if(item.parent!==null&&items[item.parent]!.kind!=="note"&&endpointForResource(parent)?.kind!=="resource")throw new Error("Only copied notes can hold copied children");
      const ref=refs[index]!;
      if(item.kind==="note")intents.push({kind:"create_note",ref,body:item.body});
      const id=linkId(accountId,parent,ref);
      const previous=positions.get(parent);
      let placement:{value:string;moves:Intent[]};
      if(previous){
        const neighbors=[{link_id:"left",position:previous.last},...previous.upper===null?[]:[{link_id:"right",position:previous.upper}]];
        placement={value:insertionPositions(neighbors,1,id)[0]!.position,moves:[]};
      }else{
        const prepared=await preparePosition(this.runtime,parent,id,parent===parent_ref?after:null,null);
        placement=prepared;
        const upper=prepared.previous.map(link=>(link.endpoint_a===parent?link.position_a:link.position_b)!.value).filter(key=>key>prepared.value).sort()[0]??null;
        positions.set(parent,{last:prepared.value,upper});
        for(const move of prepared.moves)if(move.kind==="move_link"){
          const link=prepared.previous.find(link=>link.link_id===move.link_id)!;
          moved.set(`${parent}/${link.link_id}`,{link,endpoint:parent});
        }
      }
      positions.get(parent)!.last=placement.value;
      const prepared=await prepareLink(this.runtime,{source_ref:parent,target_ref:ref,source_label:null,target_label:item.kind==="resource"?item.label:null,after:null},placement);
      if(!prepared.intents.some(intent=>intent.kind==="add_link"))throw new Error("A copied resource is already linked here");
      intents.push(...prepared.intents);additions.push(prepared.link_id);
    }
    if(!items.length)return [];
    const saved=await this.commit({kind:"batch",intents});
    const resources=saved.change.resources.map(({ref,touch_vv})=>({ref,touch_vv}));
    const links=saved.change.links;
    let current=links;
    const coverage = causalCoverage(resources.map(resource => [resource.ref, resource.touch_vv]), additions.map(id => [id, links.find(link => link.link_id === id)!.add_vv]));
    const reorder=(redo:boolean):Intent[]=>[...moved.values()].flatMap(({link,endpoint})=>{
      const expected=current.find(item=>item.link_id===link.link_id);
      const register=expected?.endpoint_a===endpoint?expected.position_a:expected?.position_b;
      const desired=redo?links.find(item=>item.link_id===link.link_id):link;
      const position=desired?.endpoint_a===endpoint?desired.position_a:desired?.position_b;
      return register&&position?[{kind:"restore_position" as const,link_id:link.link_id,endpoint_ref:endpoint,expected:register.stamp,position:position.value}]:[];
    });
    this.push({kind: "structure", coverage, refs,bytes:2*new TextEncoder().encode(JSON.stringify({resources,links,moved:[...moved.values()]})).byteLength,
      undo:async()=>{current=(await this.commit({kind:"batch",intents:[...resources.map(resource=>({kind:"delete_resource" as const,ref:resource.ref,observed_touch:coverage.resources.get(resource.ref)!})),...additions.map(link_id=>({kind:"unlink" as const,link_id,observed_add:coverage.links.get(link_id)!})),...reorder(false)]})).change.links;},
      redo:async()=>{current=(await this.commit({kind:"batch",intents:[...resources.map(resource=>({kind:"restore_resource" as const,ref:resource.ref})),...additions.map(link_id=>({kind:"restore_link" as const,link_id})),...reorder(true)]})).change.links;},release:()=>{},
    });
    return refs;
  }
  async split(source_ref: string, displayed: import("./editorTypes").DisplayedSplit, parent_ref: string, occurrence_link: string | null): Promise<CreatedOutlineNote> {
    this.stopTyping();
    const source = await this.runtime.openDocument(source_ref);
    await source.capture();
    const clone = hydrateNote(displayed.body_state);
    const origin = Symbol("split source");
    const manager = new Y.UndoManager(bodyInline(clone), { trackedOrigins: new Set([origin]), captureTimeout: 0 });
    let retained=false;
    try {
    const inline = bodyInline(clone), offset = displayed.from;
    const suffix = parseBody({ type: "body", attrs: readBody(clone).body_pm_json.attrs, content: sliceInline(clone, displayed.to, inline.length) });
    const baseline = Y.encodeStateVector(clone);
    applyBodyEdits(clone, [{ kind: "replace", from: offset, to: inline.length, content: [] }], origin);
    const update = encodeBytes(Y.encodeStateAsUpdate(clone, baseline));
    const new_ref = `note_block:${crypto.randomUUID()}`;
    const placement = await prepareLink(this.runtime, { source_ref: parent_ref, target_ref: new_ref, source_label: null, target_label: null, after: occurrence_link });
    const saved = await this.commit({ kind: "batch", intents: [{ kind: "edit_body", ref: source_ref, body_update: update }, { kind: "create_note", ref: new_ref, body: suffix }, ...placement.intents] });
    const created = saved.change.resources.find(resource => resource.ref === new_ref);
    if (created?.kind !== "note" || created.body_update === null) throw new Error("split note receipt has no body");
    const creation = created.touch_vv;
    const addition = saved.change.links.find(link => link.link_id === placement.link_id)!.add_vv;
    const release = source.retain();
    const textInverse = async (redo: boolean): Promise<Intent> => {
      Y.applyUpdate(clone, Y.encodeStateAsUpdate(source.doc));
      const vector = Y.encodeStateVector(clone);
      if (redo) manager.redo(); else manager.undo();
      return { kind: "edit_body", ref: source_ref, body_update: encodeBytes(Y.encodeStateAsUpdate(clone, vector)) };
    };
    const coverage = causalCoverage([[new_ref, creation]], [[placement.link_id, addition]]);
    this.push({ kind: "structure", coverage, refs: [source_ref, new_ref], bytes: Y.encodeStateAsUpdate(clone).byteLength+new TextEncoder().encode(JSON.stringify({creation,addition})).byteLength,
      undo: async () => { await this.commit({ kind: "batch", intents: [await textInverse(false), { kind: "delete_resource", ref: new_ref, observed_touch: coverage.resources.get(new_ref)! }, { kind: "unlink", link_id: placement.link_id, observed_add: coverage.links.get(placement.link_id)! }] }); },
      redo: async () => { await this.commit({ kind: "batch", intents: [await textInverse(true), { kind: "restore_resource", ref: new_ref }, { kind: "restore_link", link_id: placement.link_id }] }); },
      release: () => { release(); manager.clear(); manager.destroy(); clone.destroy(); },
    });
    retained=true;
    const sourceBefore = saved.before.resources.find(state => state.ref === source_ref);
    return { ref: new_ref, link_id: placement.link_id, store_revision: saved.store_revision, body_state: created.body_update, observed_touch: creation, observed_add: addition, input_offset: 0,
      source_before: sourceBefore ? {touch: sourceBefore.touch_vv, removed: sourceBefore.delete_vv} : null };
    } finally { if(!retained){manager.clear();manager.destroy();clone.destroy();} }
  }
  async join(destination_ref: string, source_ref: string, displayed: {source?:import("./runtime").WritingSnapshot;destination?:import("./runtime").WritingSnapshot} = {}): Promise<{ref: string; store_revision: string; body_state: string; observed_touch: Vector; input_offset: number}> {
    if (destination_ref === source_ref) throw new Error("A note cannot be joined to itself");
    this.stopTyping();
    const destination = await this.runtime.openDocument(destination_ref), source = await this.runtime.openDocument(source_ref);
    const [shownDestination, shownSource] = await Promise.all([displayed.destination??destination.capture(), displayed.source??source.capture()]);
    const clone = hydrateNote(shownDestination.body_state), sourceClone = hydrateNote(shownSource.body_state);
    const sourceTouch=shownSource.observed_touch;
    const seam = bodyInline(clone).length;
    const origin = Symbol("join destination");
    const manager = new Y.UndoManager(bodyInline(clone), { trackedOrigins: new Set([origin]), captureTimeout: 0 });
    let retained=false;
    try {
    const before = Y.encodeStateVector(clone);
    applyBodyEdits(clone, [{ kind: "replace", from: bodyInline(clone).length, to: bodyInline(clone).length, content: sliceInline(sourceClone, 0, bodyInline(sourceClone).length) }], origin);
    sourceClone.destroy();
    const saved = await this.commit({ kind: "batch", intents: [{ kind: "edit_body", ref: destination_ref, body_update: encodeBytes(Y.encodeStateAsUpdate(clone, before)) }, { kind: "delete_resource", ref: source_ref, observed_touch: shownSource.observed_touch }] });
    const release = destination.retain();
    const inverse = async (redo: boolean): Promise<Intent> => {
      Y.applyUpdate(clone, Y.encodeStateAsUpdate(destination.doc));
      const vector = Y.encodeStateVector(clone);
      if (redo) manager.redo(); else manager.undo();
      return { kind: "edit_body", ref: destination_ref, body_update: encodeBytes(Y.encodeStateAsUpdate(clone, vector)) };
    };
    const coverage = causalCoverage([[source_ref, sourceTouch]], []);
    this.push({ kind: "structure", coverage, refs: [destination_ref, source_ref], bytes: Y.encodeStateAsUpdate(clone).byteLength+new TextEncoder().encode(JSON.stringify(sourceTouch)).byteLength,
      undo: async () => { await this.commit({ kind: "batch", intents: [await inverse(false), { kind: "restore_resource", ref: source_ref }] }); },
      redo: async () => { await this.commit({ kind: "batch", intents: [await inverse(true), { kind: "delete_resource", ref: source_ref, observed_touch: coverage.resources.get(source_ref)! }] }); },
      release: () => { release(); manager.clear(); manager.destroy(); clone.destroy(); },
    });
    retained=true;
    const destinationBefore = saved.before.resources.find(state => state.ref === destination_ref);
    return {ref: destination_ref, store_revision: saved.store_revision, body_state: encodeBytes(Y.encodeStateAsUpdate(clone)), observed_touch: advanceCoverage(shownDestination.observed_touch,
      destinationBefore ? {touch: destinationBefore.touch_vv, removed: destinationBefore.delete_vv} : null,
      saved.change.resources.find(resource => resource.ref === destination_ref)!.touch_vv), input_offset: seam};
    } finally { sourceClone.destroy();if(!retained){manager.clear();manager.destroy();clone.destroy();} }
  }

  canUndo():boolean {return this.past.length>0;}
  canRedo():boolean {return this.future.length>0;}
  async unlink(link:LinkState):Promise<string> {return this.unlinkMany([link]);}
  async unlinkMany(links:readonly LinkState[]):Promise<string> {
    this.stopTyping();
    const saved = await this.commit({kind:"batch",intents:links.map(link=>({kind:"unlink",link_id:link.link_id,observed_add:link.add_vv}))});
    const coverage = causalCoverage([], links.map(link => [link.link_id, link.add_vv]));
    this.push({kind: "structure", coverage, refs:links.flatMap(link=>[link.endpoint_a,link.endpoint_b]),bytes:2*new TextEncoder().encode(JSON.stringify(links)).byteLength,
      undo:async()=>{await this.commit({kind:"batch",intents:links.map(link=>({kind:"restore_link",link_id:link.link_id}))});},
      redo:async()=>{await this.commit({kind:"batch",intents:links.map(link=>({kind:"unlink",link_id:link.link_id,observed_add:coverage.links.get(link.link_id)!}))});},release:()=>{},
    });
    return saved.store_revision;
  }
  async move(link: LinkState, endpoint_ref: string, siblings: readonly LinkState[], index: number): Promise<{store_revision: string; link: LinkState}> {
    this.stopTyping();
    const remaining = siblings.filter(sibling => sibling.link_id !== link.link_id);
    const anchor = remaining[index]?.link_id ?? null;
    const placement = await preparePosition(this.runtime, endpoint_ref, link.link_id, anchor===null?remaining.at(-1)?.link_id??null:null, anchor);
    const intents: Intent[] = [...placement.moves, {kind:"move_link",link_id:link.link_id,endpoint_ref,position:placement.value}];
    const saved = await this.commit({ kind: "batch", intents });
    let current = saved;
    const previous = new Map([...placement.previous,link].map(sibling => [sibling.link_id, (sibling.endpoint_a === endpoint_ref ? sibling.position_a : sibling.position_b)!]));
    const undoMove = async (redo: boolean) => {
      const inverse: Intent[] = [];
      for (const changed of current.change.links) {
        const register = changed.endpoint_a === endpoint_ref ? changed.position_a : changed.position_b;
        const desired = redo ? saved.change.links.find(l=>l.link_id===changed.link_id) : null;
        const position = redo ? (desired?.endpoint_a===endpoint_ref?desired.position_a:desired?.position_b)?.value : previous.get(changed.link_id)?.value;
        if(register && position!==undefined) inverse.push({kind:"restore_position",link_id:changed.link_id,endpoint_ref,expected:register.stamp,position});
      }
      current=await this.commit({kind:"batch",intents:inverse});
    };
    this.push({kind: "structure", refs:[endpoint_ref],bytes:2*new TextEncoder().encode(JSON.stringify({links:saved.change.links,previous:[...previous]})).byteLength,undo:()=>undoMove(false),redo:()=>undoMove(true),release:()=>{}});
    const moved = saved.change.links.find(current => current.link_id === link.link_id);
    if (!moved) throw new Error("move receipt has no relationship");
    return {store_revision: saved.store_revision, link: {...link, position_a: moved.position_a ?? link.position_a, position_b: moved.position_b ?? link.position_b}};
  }

  async relink(link: LinkState, from_ref: string, destination_ref: string, after: string | null = null, placed?: (link: LinkState, receipt: LocalCommit) => void): Promise<string> {
    const target_ref = link.endpoint_a === from_ref ? link.endpoint_b : link.endpoint_a;
    const placement = await prepareLink(this.runtime, { source_ref: destination_ref, target_ref, source_label: null, target_label: null, after });
    const existing = placed && !placement.intents.some(intent => intent.kind === "add_link") ? (await (await this.runtime.store).readStates({refs: [], link_ids: [placement.link_id], anchor_ids: [], source_refs: []})).links[0] : null;
    const saved=await this.commit({ kind: "batch", intents: [{ kind: "unlink", link_id: link.link_id, observed_add: link.add_vv }, ...placement.intents] });
    const addition=saved.change.links.find(l=>l.link_id===placement.link_id);
    if (placed) {const current = addition ?? existing; if (!current) throw new Error("reparent receipt has no relationship"); placed(current, saved);}
    const coverage = causalCoverage([], addition ? [[link.link_id, link.add_vv], [placement.link_id, addition.add_vv]] : [[link.link_id, link.add_vv]]);
    this.push({kind: "structure", coverage, refs:[from_ref,destination_ref,target_ref],bytes:2*new TextEncoder().encode(JSON.stringify({link,addition})).byteLength,
      undo:async()=>{await this.commit({kind:"batch",intents:[{kind:"restore_link",link_id:link.link_id},...addition?[{kind:"unlink" as const,link_id:placement.link_id,observed_add:coverage.links.get(placement.link_id)!}]:[]]});},
      redo:async()=>{await this.commit({kind:"batch",intents:[{kind:"unlink",link_id:link.link_id,observed_add:coverage.links.get(link.link_id)!},...addition?[{kind:"restore_link" as const,link_id:placement.link_id}]:[]]});},release:()=>{},
    });
    return placement.link_id;
  }

  close(): void {
    this.closed = true;
    for (const group of [...this.past, ...this.future]) group.release();
    for (const history of this.texts.values()) {history.unsubscribe();history.manager.clear();history.manager.destroy();}
    this.past.length = 0; this.future.length = 0; this.texts.clear();
  }
}
function causalCoverage(resources: [string, Vector][], links: [string, Vector][]): Coverage {
  return {resources: new Map(resources), links: new Map(links)};
}
