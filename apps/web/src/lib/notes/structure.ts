/** Session-scoped outline history. Structural edits copy the displayed content,
 * delete only observed character ids, and compose text/graph inverses into one
 * local command. A joined source can revive; links never redirect or cascade. */
import * as Y from "yjs";
import { applyBodyEdits, bodyInline, encodeBytes, hydrateNote, readBody, sliceInline } from "@nexus/authored/documents";
import { emptyBody, parseBody } from "@nexus/authored/body";
import { insertionPositions, type Intent } from "@nexus/authored/commands";
import { linkId } from "@nexus/authored/identity";
import type { ClipItem } from "./clipboard";
import type { LinkState, Vector } from "@nexus/authored/types";
import { endpointForResource, preparePosition, prepareLink } from "@/lib/resourceGraph/links";
import { LocalCommitError, type LocalCommit, type WritingDocument, type WritingRuntime } from "./runtime";
export interface EditorHistory {
  origin: unknown;
  retain(): () => void;
  undo(): void;
  redo(): void;
  boundary(): void;
  record(): void;
}
interface Group { refs: string[]; bytes: number; undo(): Promise<void>; redo(): Promise<void>; release(): void }
interface TextHistory { document: WritingDocument; manager: Y.UndoManager; origin: symbol; latest: object | null; active: number; groups: number }
export class OutlineHistory {
  private readonly past: Group[] = [];
  private readonly future: Group[] = [];
  private readonly texts = new Map<string, TextHistory>();
  private tail: Promise<void> = Promise.resolve();
  private closed = false;
  constructor(readonly runtime: WritingRuntime, private readonly failure: (error: unknown) => void) {}
  editor(document: WritingDocument): EditorHistory {
    let entry = this.texts.get(document.ref);
    if (!entry || entry.document !== document) {
      entry?.manager.destroy();
      const origin = Symbol("outline typing");
      entry = { document, origin, manager: new Y.UndoManager([document.doc.getXmlFragment("body"), bodyInline(document.doc)], { trackedOrigins: new Set([origin]), captureTimeout: 500 }), latest: null,active:0,groups:0 };
      this.texts.set(document.ref, entry);
    }
    const history = entry;
    return {
      origin: history.origin,
      retain:()=>{history.active++;return()=>{history.active--;this.pruneText(history);};},
      undo: () => this.undo(), redo: () => this.redo(), boundary: () => history.manager.stopCapturing(),
      record: () => {
        const item = history.manager.undoStack.at(-1) ?? null;
        if (!item || history.latest === item) return;
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
          if(history.latest===item)history.latest=null;
          this.pruneText(history);
        };
        this.push({ refs: [document.ref], bytes: Y.encodeStateAsUpdate(document.doc).byteLength,
          undo: async () => { history.manager.undo(); ownedItem=history.manager.redoStack.at(-1)??ownedItem; history.latest = null; await document.capture(); },
          redo: async () => { history.manager.redo(); ownedItem=history.manager.undoStack.at(-1)??ownedItem; history.latest = history.manager.undoStack.at(-1) ?? null; await document.capture(); }, release });
      },
    };
  }
  private pruneText(history:TextHistory):void {
    if(history.active===0 && history.groups===0 && this.texts.get(history.document.ref)===history){history.manager.clear();history.manager.destroy();this.texts.delete(history.document.ref);}
  }
  private async commit(intent: Intent): Promise<LocalCommit> {
    try { return await this.runtime.run(intent); }
    catch (error) { if (error instanceof LocalCommitError) { this.failure(error); return error.completion; } throw error; }
  }
  private push(group: Group): void {
    if (this.closed) { group.release(); return; }
    for (const discarded of this.future.splice(0)) discarded.release();
    this.past.push(group);
    while (this.past.length > 0 && (new Set(this.past.flatMap(group => group.refs)).size > 64 || this.past.reduce((n, group) => n + group.bytes, 0) > 16 * 1024 * 1024)) this.past.shift()!.release();
  }
  private enqueue(work: () => Promise<void>): void {
    this.tail = this.tail.then(async () => { if (!this.closed) await work(); }).catch(this.failure);
  }
  undo = (): void => this.enqueue(async () => {
    const group = this.past.at(-1);
    if (!group) return;
    const completion=group.undo();
    this.past.pop();this.future.push(group);
    await completion;
  });
  redo = (): void => this.enqueue(async () => {
    const group = this.future.at(-1);
    if (!group) return;
    const completion=group.redo();
    this.future.pop();this.past.push(group);
    await completion;
  });
  private stopTyping(): void { for (const history of this.texts.values()) history.manager.stopCapturing(); }
  async create(parent_ref: string, after: string | null = null, body = emptyBody(), prelude: readonly Intent[] = []): Promise<string> {
    this.stopTyping();
    const ref = `note_block:${crypto.randomUUID()}`;
    const placement = await prepareLink(this.runtime, { source_ref: parent_ref, target_ref: ref, source_label: null, target_label: null, after });
    const saved = await this.commit({ kind: "batch", intents: [...prelude, { kind: "create_note", ref, body }, ...placement.intents] });
    const creation = saved.change.resources.find(resource => resource.ref === ref)!;
    const addition = saved.change.links.find(link => link.link_id === placement.link_id)!;
    let restored: LocalCommit | null = null;
    this.push({ refs: [ref], bytes: 0,
      undo: async () => { await this.commit({kind:"batch",intents:[{kind:"delete_resource",ref,observed_touch:mergeDots(creation.touch_vv,restored?.change.resources.find(r=>r.ref===ref)?.touch_vv??{})},{kind:"unlink",link_id:placement.link_id,observed_add:mergeDots(addition.add_vv,restored?.change.links.find(l=>l.link_id===placement.link_id)?.add_vv??{})}]}); },
      redo: async () => { restored=await this.commit({kind:"batch",intents:[{kind:"restore_resource",ref},...addition?[{kind:"restore_link" as const,link_id:placement.link_id}]:[]]}); }, release:()=>{},
    });
    return ref;
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
    let current=saved,restored:LocalCommit|null=null;
    const reorder=(redo:boolean):Intent[]=>[...moved.values()].flatMap(({link,endpoint})=>{
      const expected=current.change.links.find(item=>item.link_id===link.link_id);
      const register=expected?.endpoint_a===endpoint?expected.position_a:expected?.position_b;
      const desired=redo?saved.change.links.find(item=>item.link_id===link.link_id):link;
      const position=desired?.endpoint_a===endpoint?desired.position_a:desired?.position_b;
      return register&&position?[{kind:"restore_position" as const,link_id:link.link_id,endpoint_ref:endpoint,expected:register.stamp,position:position.value}]:[];
    });
    this.push({refs,bytes:items.reduce((n,item)=>n+(item.kind==="note"?JSON.stringify(item.body).length:0),0),
      undo:async()=>{current=await this.commit({kind:"batch",intents:[...saved.change.resources.map(resource=>({kind:"delete_resource" as const,ref:resource.ref,observed_touch:mergeDots(resource.touch_vv,restored?.change.resources.find(item=>item.ref===resource.ref)?.touch_vv??{})})),...additions.map(link_id=>({kind:"unlink" as const,link_id,observed_add:mergeDots(saved.change.links.find(link=>link.link_id===link_id)!.add_vv,restored?.change.links.find(link=>link.link_id===link_id)?.add_vv??{})})),...reorder(false)]});},
      redo:async()=>{restored=current=await this.commit({kind:"batch",intents:[...saved.change.resources.map(resource=>({kind:"restore_resource" as const,ref:resource.ref})),...additions.map(link_id=>({kind:"restore_link" as const,link_id})),...reorder(true)]});},release:()=>{},
    });
    return refs;
  }
  async split(source_ref: string, displayed: import("./editorTypes").DisplayedSplit, parent_ref: string, occurrence_link: string | null): Promise<string> {
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
    const creation = saved.change.resources.find(resource => resource.ref === new_ref)!;
    const addition = saved.change.links.find(link => link.link_id === placement.link_id)!;
    const release = source.retain();
    const textInverse = async (redo: boolean): Promise<Intent> => {
      Y.applyUpdate(clone, Y.encodeStateAsUpdate(source.doc));
      const vector = Y.encodeStateVector(clone);
      if (redo) manager.redo(); else manager.undo();
      return { kind: "edit_body", ref: source_ref, body_update: encodeBytes(Y.encodeStateAsUpdate(clone, vector)) };
    };
    let restored: LocalCommit | null = null;
    this.push({ refs: [source_ref, new_ref], bytes: Y.encodeStateAsUpdate(clone).byteLength,
      undo: async () => { await this.commit({ kind: "batch", intents: [await textInverse(false), { kind: "delete_resource", ref: new_ref, observed_touch: mergeDots(creation.touch_vv, restored?.change.resources.find(r => r.ref === new_ref)?.touch_vv ?? {}) }, { kind: "unlink", link_id: placement.link_id, observed_add: mergeDots(addition.add_vv, restored?.change.links.find(l => l.link_id === placement.link_id)?.add_vv ?? {}) }] }); },
      redo: async () => { restored = await this.commit({ kind: "batch", intents: [await textInverse(true), { kind: "restore_resource", ref: new_ref }, { kind: "restore_link", link_id: placement.link_id }] }); },
      release: () => { release(); manager.clear(); manager.destroy(); clone.destroy(); },
    });
    retained=true;
    return new_ref;
    } finally { if(!retained){manager.clear();manager.destroy();clone.destroy();} }
  }
  async join(destination_ref: string, source_ref: string, displayed: {source?:import("./runtime").WritingSnapshot;destination?:import("./runtime").WritingSnapshot} = {}): Promise<void> {
    if (destination_ref === source_ref) throw new Error("A note cannot be joined to itself");
    this.stopTyping();
    const destination = await this.runtime.openDocument(destination_ref), source = await this.runtime.openDocument(source_ref);
    const [shownDestination, shownSource] = await Promise.all([displayed.destination??destination.capture(), displayed.source??source.capture()]);
    const clone = hydrateNote(shownDestination.body_state), sourceClone = hydrateNote(shownSource.body_state);
    const origin = Symbol("join destination");
    const manager = new Y.UndoManager(bodyInline(clone), { trackedOrigins: new Set([origin]), captureTimeout: 0 });
    let retained=false;
    try {
    const before = Y.encodeStateVector(clone);
    applyBodyEdits(clone, [{ kind: "replace", from: bodyInline(clone).length, to: bodyInline(clone).length, content: sliceInline(sourceClone, 0, bodyInline(sourceClone).length) }], origin);
    sourceClone.destroy();
    await this.commit({ kind: "batch", intents: [{ kind: "edit_body", ref: destination_ref, body_update: encodeBytes(Y.encodeStateAsUpdate(clone, before)) }, { kind: "delete_resource", ref: source_ref, observed_touch: shownSource.observed_touch }] });
    const release = destination.retain();
    const inverse = async (redo: boolean): Promise<Intent> => {
      Y.applyUpdate(clone, Y.encodeStateAsUpdate(destination.doc));
      const vector = Y.encodeStateVector(clone);
      if (redo) manager.redo(); else manager.undo();
      return { kind: "edit_body", ref: destination_ref, body_update: encodeBytes(Y.encodeStateAsUpdate(clone, vector)) };
    };
    let restored: LocalCommit | null = null;
    this.push({ refs: [destination_ref, source_ref], bytes: Y.encodeStateAsUpdate(clone).byteLength,
      undo: async () => { restored = await this.commit({ kind: "batch", intents: [await inverse(false), { kind: "restore_resource", ref: source_ref }] }); },
      redo: async () => { await this.commit({ kind: "batch", intents: [await inverse(true), { kind: "delete_resource", ref: source_ref, observed_touch: mergeDots(shownSource.observed_touch, restored?.change.resources.find(r => r.ref === source_ref)?.touch_vv ?? {}) }] }); },
      release: () => { release(); manager.clear(); manager.destroy(); clone.destroy(); },
    });
    retained=true;
    } finally { sourceClone.destroy();if(!retained){manager.clear();manager.destroy();clone.destroy();} }
  }

  canUndo():boolean {return this.past.length>0;}
  canRedo():boolean {return this.future.length>0;}
  async unlink(link:LinkState):Promise<void> {return this.unlinkMany([link]);}
  async unlinkMany(links:readonly LinkState[]):Promise<void> {
    this.stopTyping();
    await this.commit({kind:"batch",intents:links.map(link=>({kind:"unlink",link_id:link.link_id,observed_add:link.add_vv}))});
    let restored:LocalCommit|null=null;
    this.push({refs:links.flatMap(link=>[link.endpoint_a,link.endpoint_b]),bytes:0,
      undo:async()=>{restored=await this.commit({kind:"batch",intents:links.map(link=>({kind:"restore_link",link_id:link.link_id}))});},
      redo:async()=>{await this.commit({kind:"batch",intents:links.map(link=>({kind:"unlink",link_id:link.link_id,observed_add:mergeDots(link.add_vv,restored?.change.links.find(item=>item.link_id===link.link_id)?.add_vv??{})}))});},release:()=>{},
    });
  }
  async moveAdjacent(link:LinkState, endpoint_ref:string, direction:"before"|"after"):Promise<void> {
    const neighbors=(await (await this.runtime.store).query({kind:"positions",ref:endpoint_ref,exclude_link_id:null,at:{kind:"neighbors",link_id:link.link_id,side:direction}})).positions;
    const neighbor=neighbors.find(item=>item.link_id!==link.link_id);
    if(!neighbor)return;
    await this.move(link,endpoint_ref,direction==="before"?[neighbor,link]:[link,neighbor],direction==="before"?0:1);
  }
  async move(link: LinkState, endpoint_ref: string, siblings: readonly LinkState[], index: number): Promise<void> {
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
    this.push({refs:[endpoint_ref],bytes:0,undo:()=>undoMove(false),redo:()=>undoMove(true),release:()=>{}});
  }

  async relink(link: LinkState, from_ref: string, destination_ref: string): Promise<void> {
    const target_ref = link.endpoint_a === from_ref ? link.endpoint_b : link.endpoint_a;
    const placement = await prepareLink(this.runtime, { source_ref: destination_ref, target_ref, source_label: null, target_label: null, after: null });
    const saved=await this.commit({ kind: "batch", intents: [{ kind: "unlink", link_id: link.link_id, observed_add: link.add_vv }, ...placement.intents] });
    const addition=saved.change.links.find(l=>l.link_id===placement.link_id);
    let restored:LocalCommit|null=null;
    this.push({refs:[from_ref,destination_ref,target_ref],bytes:0,
      undo:async()=>{restored=await this.commit({kind:"batch",intents:[{kind:"restore_link",link_id:link.link_id},...addition?[{kind:"unlink" as const,link_id:placement.link_id,observed_add:mergeDots(addition.add_vv,restored?.change.links.find(l=>l.link_id===placement.link_id)?.add_vv??{})}]:[]]});},
      redo:async()=>{restored=await this.commit({kind:"batch",intents:[{kind:"unlink",link_id:link.link_id,observed_add:mergeDots(link.add_vv,restored?.change.links.find(l=>l.link_id===link.link_id)?.add_vv??{})},...addition?[{kind:"restore_link" as const,link_id:placement.link_id}]:[]]});},release:()=>{},
    });
  }

  close(): void {
    this.closed = true;
    for (const group of [...this.past, ...this.future]) group.release();
    for (const history of this.texts.values()) {history.manager.clear();history.manager.destroy();}
    this.past.length = 0; this.future.length = 0; this.texts.clear();
  }
}
function mergeDots(a: Vector, b: Vector): Vector {
  const result = { ...a };
  for (const [replica, sequence] of Object.entries(b)) if (BigInt(sequence) > BigInt(result[replica] ?? "0")) result[replica] = sequence;
  return result;
}
