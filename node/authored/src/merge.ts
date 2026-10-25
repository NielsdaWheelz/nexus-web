/** Causal observed-delete graph plus Yjs text. Applying identical changes is
 * idempotent. Merging never invents a touch, repairs text, or removes neighbors. */
import type { Change, Corpus, HighlightPatch, LinkState, MergeResult, PassageState, Register, ResourcePatch, ResourceProjection, ResourceState, SourceStub, Vector } from "./types.ts";
import { validateChange } from "./validate.ts";
import { MAX_COMMAND_BYTES } from "./types.ts";
import { mergeNote, mergeTitle } from "./documents.ts";
import { isResourceRef, sortedEndpoints } from "./identity.ts";
export function counter(value:string):bigint {
  if(typeof value !== "string" || !/^(0|[1-9][0-9]*)$/u.test(value)) throw new TypeError("Counter must be a canonical nonnegative decimal");
  const n=BigInt(value);
  if(n>9223372036854775807n) throw new TypeError("Counter exceeds signed 64-bit range");
  return n;
}
export function mergeVector(a:Vector,b:Vector):Vector {
  const out:Record<string,string>={...a};
  for(const [replica,n] of Object.entries(b)) if(counter(n)>counter(out[replica]??"0")) out[replica]=n;
  return out;
}
export function isVisible(touch:Vector,deleted:Vector):boolean { return Object.entries(touch).some(([replica,n])=>counter(n)>counter(deleted[replica]??"0")); }
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item !== null && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
      : item,
  );
}
export function mergeRegister<T>(a:Register<T>|null,b:Register<T>|null):Register<T>|null {
  if(a===null) return b;
  if(b===null) return a;
  const first=counter(a.stamp.lamport),second=counter(b.stamp.lamport);
  if(first===second && a.stamp.replica_id===b.stamp.replica_id && canonical(a.value)!==canonical(b.value)) throw new TypeError("One register stamp identifies conflicting values");
  return first>second || (first===second && a.stamp.replica_id>b.stamp.replica_id)?a:b;
}
function requiredRegister<T>(a:Register<T>|null,b:Register<T>):Register<T> { return mergeRegister(a,b)!; }
export function projectResource(state:ResourceState):ResourceProjection {
  const common={ref:state.ref,kind:state.kind,visible:isVisible(state.touch_vv,state.delete_vv),body_pm_json:null,body_text:null,title:null,local_date:null,source_ref:null,selection:null,color:null,embedded_refs:[]};
  switch(state.kind) {
    case "note": {
      const {body}=mergeNote(state.body_state,null);
      const embedded_refs:string[]=[];
      const content=body.body_pm_json.content;
      if(Array.isArray(content)) for(const node of content) if(node.type==="resource_embed") embedded_refs.push(node.attrs.resource_ref);
      return {...common,...body,embedded_refs:[...new Set(embedded_refs)]};
    }
    case "page": return {...common,title:mergeTitle(state.title_state,null).title,local_date:state.local_date};
    case "highlight": return {...common,source_ref:state.source_ref,selection:state.selection.value,color:state.color.value};
  }
}
function resourceMerge(old:ResourceState|null,patch:ResourcePatch):ResourceState {
  if(!isResourceRef(patch.ref)) throw new TypeError("Invalid resource reference");
  const scheme=patch.kind==="note"?"note_block":patch.kind;
  if(!patch.ref.startsWith(`${scheme}:`)) throw new TypeError("Resource reference disagrees with kind");
  if(old && old.kind!==patch.kind) throw new TypeError("Resource kind is immutable");
  const causal={ref:patch.ref,touch_vv:mergeVector(old?.touch_vv??{},patch.touch_vv),delete_vv:mergeVector(old?.delete_vv??{},patch.delete_vv)};
  switch(patch.kind) {
    case "note": return {...causal,kind:"note",body_state:mergeNote(old?.kind==="note"?old.body_state:null,patch.body_update).body_state};
    case "page": {
      if(old?.kind==="page" && old.local_date!==patch.local_date) throw new TypeError("Daily binding is immutable");
      return {...causal,kind:"page",local_date:patch.local_date,title_state:mergeTitle(old?.kind==="page"?old.title_state:null,patch.title_update).title_state};
    }
    case "highlight": {
      if(!isResourceRef(patch.source_ref)) throw new TypeError("Invalid highlight source");
      const prior:HighlightPatch|null=old?.kind==="highlight"?old:null;
      if(prior && prior.source_ref!==patch.source_ref) throw new TypeError("Highlight source is immutable");
      return {...causal,kind:"highlight",source_ref:patch.source_ref,selection:requiredRegister(prior?.selection??null,patch.selection),color:requiredRegister(prior?.color??null,patch.color)};
    }
  }
}
export function mergeChanges(states:Corpus,changes:readonly Change[]):MergeResult {
  const resources=new Map(states.resources.map(r=>[r.ref,r]));
  const links=new Map(states.links.map(l=>[l.link_id,l]));
  const passages=new Map(states.passages.map(p=>[p.anchor_id,p]));
  const stubs=new Map(states.source_stubs.map(s=>[s.source_ref,s]));
  for(const change of changes) {
    validateChange(change);
    if(new TextEncoder().encode(JSON.stringify(change)).length>MAX_COMMAND_BYTES) throw new TypeError("Authored command exceeds 2 MiB");
    for(const patch of change.resources) resources.set(patch.ref,resourceMerge(resources.get(patch.ref)??null,patch));
    for(const patch of change.links) {
      const [a,b]=sortedEndpoints(patch.endpoint_a,patch.endpoint_b);
      if(a!==patch.endpoint_a||b!==patch.endpoint_b) throw new TypeError("Link endpoints must be sorted");
      const old=links.get(patch.link_id);
      if(old && (old.endpoint_a!==a||old.endpoint_b!==b)) throw new TypeError("Link endpoints are immutable");
      const merged:LinkState={...patch,add_vv:mergeVector(old?.add_vv??{},patch.add_vv),remove_vv:mergeVector(old?.remove_vv??{},patch.remove_vv),position_a:mergeRegister(old?.position_a??null,patch.position_a),position_b:mergeRegister(old?.position_b??null,patch.position_b)};
      links.set(patch.link_id,merged);
    }
    for(const patch of change.passages) {
      const old=passages.get(patch.anchor_id);
      if(old && ["source_ref","normalized_exact","prefix","suffix"].some(k=>old[k as keyof PassageState]!==patch[k as keyof PassageState])) throw new TypeError("Passage semantic binding is immutable");
      passages.set(patch.anchor_id,{...patch,capture:requiredRegister(old?.capture??null,patch.capture)});
    }
    for(const patch of change.source_stubs) {
      const old=stubs.get(patch.source_ref);
      stubs.set(patch.source_ref,{...patch,capture:requiredRegister(old?.capture??null,patch.capture)});
    }
  }
  const dates=new Map<string,string>();
  for(const r of resources.values()) if(r.kind==="page"&&r.local_date!==null) {
    if(dates.has(r.local_date)&&dates.get(r.local_date)!==r.ref) throw new TypeError("Conflicting daily binding");
    dates.set(r.local_date,r.ref);
  }
  const pairs=new Map<string,string>();
  for(const l of links.values()) {
    const key=JSON.stringify([l.endpoint_a,l.endpoint_b]);
    if(pairs.has(key)&&pairs.get(key)!==l.link_id) throw new TypeError("Conflicting link binding");
    pairs.set(key,l.link_id);
  }
  const passageKeys=new Map<string,string>();
  for(const p of passages.values()) {
    const key=JSON.stringify([p.source_ref,p.normalized_exact,p.prefix,p.suffix]);
    if(passageKeys.has(key)&&passageKeys.get(key)!==p.anchor_id) throw new TypeError("Conflicting passage binding");
    passageKeys.set(key,p.anchor_id);
  }
  const values=[...resources.values()];
  return {resources:values,links:[...links.values()],passages:[...passages.values()],source_stubs:[...stubs.values()],projections:values.map(projectResource)};
}
