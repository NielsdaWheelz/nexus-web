/** Commands freeze observed causal coverage and Yjs deltas once. A note create
 * carries its frozen initializer as body_update; preparation never remints it.
 * Retrying remerges identical bytes, never rereading delete coverage or
 * allocating another touch. An owned identity is not recreated; revival is an
 * explicit restore. */
import { generateKeyBetween, generateNKeysBetween } from "fractional-indexing";
import type { Change, Corpus, HighlightColor, PassageCapture, SourceCapture, LinkState, ResourcePatch, ResourceState, SelectionCapture, Stamp, Vector } from "./types.ts";
import { createNote, createTitle } from "./documents.ts";
import { canonicalSelection } from "./geometry.ts";
import { mergeChanges, counter, isVisible } from "./merge.ts";
import { sortedEndpoints } from "./identity.ts";
import type { NoteBody } from "./body.ts";
export interface CommandContext { replica_id:string; command_seq:string; lamport:string }
export type Intent =
  | { kind:"create_note"; ref:string; body_update:string }
  | { kind:"create_page"; ref:string; title:string; local_date:string|null }
  | { kind:"edit_body"; ref:string; body_update:string }
  | { kind:"edit_title"; ref:string; title_update:string }
  | { kind:"delete_resource"; ref:string; observed_touch:Vector }
  | { kind:"restore_resource"; ref:string }
  | { kind:"add_link"; link_id:string; endpoint_a:string; endpoint_b:string; position_a:string; position_b:string }
  | { kind:"restore_link"; link_id:string }
  | { kind:"unlink"; link_id:string; observed_add:Vector }
  | { kind:"restore_position"; link_id:string; endpoint_ref:string; expected:Stamp; position:string }
  | { kind:"move_link"; link_id:string; endpoint_ref:string; position:string }
  | { kind:"create_highlight"; ref:string; source_ref:string; selection:SelectionCapture; color:HighlightColor }
  | { kind:"update_highlight"; ref:string; selection:SelectionCapture|null; color:HighlightColor|null }
  | { kind:"capture_passage"; anchor_id:string; source_ref:string; normalized_exact:string; prefix:string; suffix:string; capture:PassageCapture }
  | { kind:"capture_source"; source_ref:string; capture:SourceCapture }
  | { kind:"batch"; intents:Intent[] };
/** Freeze a note initializer before any asynchronous command preparation. */
export function createNoteIntent(ref:string, body:NoteBody): Extract<Intent,{kind:"create_note"}> {
  return {kind:"create_note",ref,body_update:createNote(body)};
}
function patchOf(r:ResourceState):ResourcePatch {
  switch(r.kind) {
    case "note": return {ref:r.ref,kind:"note",touch_vv:{},delete_vv:{},body_update:null};
    case "page": return {ref:r.ref,kind:"page",touch_vv:{},delete_vv:{},local_date:r.local_date,title_update:null};
    case "highlight": return {...r,touch_vv:{},delete_vv:{}};
  }
}
export function prepareChange(context:CommandContext,intent:Intent,states:Corpus):Change {
  if(counter(context.command_seq)<1n||counter(context.lamport)<1n) throw new TypeError("Commands need positive causal counters");
  const change:Change={command_seq:context.command_seq,lamport:context.lamport,resources:[],links:[],passages:[],source_stubs:[]};
  const stamp={lamport:context.lamport,replica_id:context.replica_id};
  const dot:Vector={[context.replica_id]:context.command_seq};
  const knownResource=(ref:string):ResourceState|null=>mergeChanges(states,[change]).resources.find(resource=>resource.ref===ref)??null;
  const resource=(ref:string):ResourceState=>{const r=knownResource(ref);if(!r)throw new TypeError(`Unknown resource ${ref}`);return r;};
  const link=(id:string):LinkState=>{const l=mergeChanges(states,[change]).links.find(l=>l.link_id===id);if(!l)throw new TypeError(`Unknown link ${id}`);return l;};
  const register=<T>(value:T)=>({value,stamp});
  const add=(action:Intent):void=>{
    switch(action.kind) {
      case "capture_passage": change.passages.push({anchor_id:action.anchor_id,source_ref:action.source_ref,normalized_exact:action.normalized_exact,prefix:action.prefix,suffix:action.suffix,capture:register(action.capture)});return;
      case "capture_source": change.source_stubs.push({source_ref:action.source_ref,capture:register(action.capture)});return;
      case "batch": for(const child of action.intents)add(child);return;
      case "create_note": {
        const known=knownResource(action.ref);
        if(known){if(known.kind!=="note")throw new TypeError("Resource kind is immutable");return;}
        change.resources.push({kind:"note",ref:action.ref,touch_vv:dot,delete_vv:{},body_update:action.body_update});return;
      }
      case "create_page": {
        const known=knownResource(action.ref);
        if(known){if(known.kind!=="page"||known.local_date!==action.local_date)throw new TypeError("Resource kind and daily binding are immutable");return;}
        change.resources.push({kind:"page",ref:action.ref,touch_vv:dot,delete_vv:{},local_date:action.local_date,title_update:createTitle(action.title)});return;
      }
      case "edit_body": {
        if(resource(action.ref).kind!=="note")throw new TypeError("Body edit addresses a note");
        change.resources.push({kind:"note",ref:action.ref,touch_vv:dot,delete_vv:{},body_update:action.body_update});return;
      }
      case "edit_title": {
        const old=resource(action.ref);if(old.kind!=="page")throw new TypeError("Title edit addresses a page");
        change.resources.push({kind:"page",ref:old.ref,local_date:old.local_date,title_update:action.title_update,touch_vv:dot,delete_vv:{}});return;
      }
      case "delete_resource":change.resources.push({...patchOf(resource(action.ref)),delete_vv:action.observed_touch});return;
      case "restore_resource":change.resources.push({...patchOf(resource(action.ref)),touch_vv:dot});return;
      case "add_link": {
        const [a,b]=sortedEndpoints(action.endpoint_a,action.endpoint_b);
        if(a!==action.endpoint_a||b!==action.endpoint_b)throw new TypeError("Link endpoints and positions must be sorted");
        const known=mergeChanges(states,[change]).links.find(link=>link.link_id===action.link_id);
        if(known && isVisible(known.add_vv,known.remove_vv))return;
        change.links.push({link_id:action.link_id,endpoint_a:a,endpoint_b:b,add_vv:dot,remove_vv:{},position_a:register(action.position_a),position_b:register(action.position_b)});return;
      }
      case "restore_link":change.links.push({...link(action.link_id),add_vv:dot,remove_vv:{},position_a:null,position_b:null});return;
      case "unlink":change.links.push({...link(action.link_id),add_vv:{},remove_vv:action.observed_add,position_a:null,position_b:null});return;
      case "restore_position": {
        const old=link(action.link_id);
        const position=action.endpoint_ref===old.endpoint_a?old.position_a:action.endpoint_ref===old.endpoint_b?old.position_b:null;
        if(position!==null && position.stamp.lamport===action.expected.lamport && position.stamp.replica_id===action.expected.replica_id) change.links.push({...old,add_vv:{},remove_vv:{},position_a:action.endpoint_ref===old.endpoint_a?register(action.position):null,position_b:action.endpoint_ref===old.endpoint_b?register(action.position):null});
        return;
      }
      case "move_link": {
        const old=link(action.link_id);if(action.endpoint_ref!==old.endpoint_a&&action.endpoint_ref!==old.endpoint_b)throw new TypeError("Move addresses one exact endpoint");
        change.links.push({...old,add_vv:{},remove_vv:{},position_a:action.endpoint_ref===old.endpoint_a?register(action.position):null,position_b:action.endpoint_ref===old.endpoint_b?register(action.position):null});return;
      }
      case "create_highlight":change.resources.push({kind:"highlight",ref:action.ref,source_ref:action.source_ref,touch_vv:dot,delete_vv:{},selection:register(canonicalSelection(action.selection)),color:register(action.color)});return;
      case "update_highlight": {
        const old=resource(action.ref);if(old.kind!=="highlight")throw new TypeError("Highlight edit addresses a highlight");
        change.resources.push({...old,touch_vv:dot,delete_vv:{},selection:action.selection===null?old.selection:register(canonicalSelection(action.selection)),color:action.color===null?old.color:register(action.color)});return;
      }
    }
  };
  add(intent);return change;
}
export interface OrderedLink {link_id:string;position:string}
/** Re-key only an observed equal-position run and the insertion, atomically. */
export function insertionPositions(siblings:readonly OrderedLink[],index:number,new_link_id:string):OrderedLink[] {
  if(!Number.isInteger(index)||index<0||index>siblings.length)throw new TypeError("Invalid insertion index");
  const left=siblings[index-1],right=siblings[index];
  if(!left||!right||left.position!==right.position)return[{link_id:new_link_id,position:generateKeyBetween(left?.position??null,right?.position??null)}];
  let start=index-1,end=index+1;
  while(start>0&&siblings[start-1]!.position===left.position)start--;
  while(end<siblings.length&&siblings[end]!.position===left.position)end++;
  const run=siblings.slice(start,end).map(item=>item.link_id);run.splice(index-start,0,new_link_id);
  const keys=generateNKeysBetween(siblings[start-1]?.position??null,siblings[end]?.position??null,run.length);
  return run.map((link_id,i)=>({link_id,position:keys[i]!}));
}
