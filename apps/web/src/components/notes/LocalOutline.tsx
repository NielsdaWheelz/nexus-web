"use client";
/** Ordered local user relationships. One exact occurrence owns structural keys;
 * repeated appearances share content, while unlink and join name their own ids. */
import { createContext, useContext, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Button from "@/components/ui/Button";
import ResourceOutlineList from "@/components/resources/ResourceOutlineList";
import ResourceOutlineRow from "@/components/resources/ResourceOutlineRow";
import ResourceComposer from "@/components/resources/ResourceComposer";
import {usePaneOutlineCommands} from "@/lib/panes/paneChrome";
import {readOutlineClipboard,writeOutlineClipboard,type ClipItem} from "@/lib/notes/clipboard";
import type {OutlineCommand} from "@/lib/notes/editorTypes";
import BoundNoteEditor from "./BoundNoteEditor";
import { useAuthoredQuery, useWritingRuntime } from "@/lib/notes/hooks";
import { OutlineHistory } from "@/lib/notes/structure";
import { LocalCommitError, writingStoreStopped, selectStates } from "@/lib/notes/runtime";
import {isVisible} from "@nexus/authored/merge";
import {parseBody} from "@nexus/authored/body";
import type { Intent } from "@nexus/authored/commands";
import {prepareTarget} from "@/lib/resourceGraph/links";
import { sortedEndpoints } from "@nexus/authored/identity";
import type { LinkState,ResourceProjection,QueryResult } from "@nexus/authored/types";
interface SelectedRow {key:string;link:LinkState;resource:ResourceProjection}
interface BlockSelection {
  state:{anchor:string|null;keys:readonly string[]};
  set:React.Dispatch<React.SetStateAction<{anchor:string|null;keys:readonly string[]}>>;
  root:React.RefObject<HTMLDivElement|null>;
  registry:Map<string,SelectedRow>;
}
const BlockSelectionContext=createContext<BlockSelection|null>(null);
const HistoryContext = createContext<OutlineHistory | null>(null);
export interface LocalOutlineHandle { append(): Promise<void>; focusNote(ref: string,signal?:AbortSignal): Promise<boolean>; focusFirst(): void }
const EMPTY_ROWS:QueryResult["rows"]=[];
const EMPTY_REFS:readonly string[]=[];
const EMPTY_INTENTS:readonly Intent[]=[];
const CLIPBOARD = "application/x-nexus-local-outline";
export default function LocalOutline({ rootRef, ancestors = EMPTY_REFS, prelude = EMPTY_INTENTS, apiRef, filter = "", session, occurrencePrefix = rootRef }: { rootRef: string; ancestors?: readonly string[]; prelude?: readonly Intent[]; apiRef?: React.RefObject<LocalOutlineHandle | null>; filter?: string; session?: OutlineHistory; occurrencePrefix?: string }) {
  const runtime = useWritingRuntime();
  const context = useContext(HistoryContext);
  const inherited = session ?? context;
  const [retryReference,setRetryReference]=useState<(()=>Promise<unknown>)|null>(null);
  const [error, setError] = useState<unknown | null>(null);
  const own = useMemo(() => runtime && !inherited ? new OutlineHistory(runtime, setError) : null, [runtime,inherited]);
  const history = inherited ?? own;
  useEffect(() => () => { if (!inherited) own?.close(); }, [inherited, own]);
  const [windowState, setWindow] = useState<{root:string;anchor:string|null;cursor:string|null}>({root:rootRef,anchor:null,cursor:null});
  const current=windowState.root===rootRef?windowState:{root:rootRef,anchor:null,cursor:null};
  const read = useAuthoredQuery(current.anchor===null
    ? {kind:"adjacency",ref:rootRef,cursor:current.cursor,limit:48}
    : {kind:"adjacency_window",ref:rootRef,link_id:current.anchor,cursor:current.cursor,limit:48});
  const rows = read.data?.rows ?? EMPTY_ROWS;
  const links = rows.flatMap(row => row.link ? [row.link] : []);
  const [active,setActive]=useState(false);
  const inheritedSelection=useContext(BlockSelectionContext);
  const [selectionState,setSelection]=useState<{anchor:string|null;keys:readonly string[]}>({anchor:null,keys:[]});
  const registry=useRef(new Map<string,SelectedRow>());
  const [selected, setSelected] = useState<string | null>(null);
  const surface = useRef<HTMLDivElement>(null);
  const ownSelection=useMemo(()=>({state:selectionState,set:setSelection,root:surface,registry:registry.current}),[selectionState]);
  const selection=inheritedSelection??ownSelection;
  const visible=useCallback(()=>[...selection.root.current?.querySelectorAll<HTMLElement>("[data-outline-occurrence]")??[]].filter(element=>element.getClientRects().length>0&&selection.registry.has(element.dataset.outlineOccurrence!)),[selection.root,selection.registry]);
  const setBlocks=selection.set;
  const selectBlocks=useCallback((key:string,extend:boolean)=>{
    window.getSelection()?.removeAllRanges();
    const order=visible().map(element=>element.dataset.outlineOccurrence!);
    setBlocks(current=>{
      const anchor=extend&&current.anchor!==null?current.anchor:key;
      const from=order.indexOf(anchor),to=order.indexOf(key);
      return {anchor,keys:from<0||to<0?[key]:order.slice(Math.min(from,to),Math.max(from,to)+1)};
    });
  },[visible,setBlocks]);
  useLayoutEffect(()=>{
    const entries=rows.filter(row=>row.link).map(row=>({key:`${occurrencePrefix}/${row.link!.link_id}`,link:row.link!,resource:row.resource}));
    for(const entry of entries)selection.registry.set(entry.key,entry);
    return()=>{for(const entry of entries)if(selection.registry.get(entry.key)===entry)selection.registry.delete(entry.key);};
  },[rows,occurrencePrefix,rootRef,selection.registry]);
  const selectedRows=()=>visible().map(element=>selection.registry.get(element.dataset.outlineOccurrence!)!).filter(row=>selection.state.keys.includes(row.key));
  const clipboardItems=():ClipItem[]=>{
    const selected=selectedRows();
    return selected.map((row,index)=>{
      const parent=selected.findLastIndex((other,at)=>at<index&&row.key.startsWith(`${other.key}/`));
      return row.resource.kind==="note"?{kind:"note",parent:parent<0?null:parent,body:runtime!.openBody(row.resource.ref)??parseBody(row.resource.body_pm_json)}:{kind:"resource",parent:parent<0?null:parent,ref:row.resource.ref,label:row.resource.title??row.resource.ref};
    });
  };
  const act = useCallback((operation: Promise<unknown>) => { setError(null); void operation.catch(error=>{if(!(error instanceof DOMException&&error.name==="AbortError"))setError(error);}); },[]);
  const pendingFocus=useRef<{ref:string;finish(value:boolean):void;fail(error:unknown):void}|null>(null);
  const [focusRevision,setFocusRevision]=useState(0);
  const focusRequest=useRef(0);
  const focusVisible = useCallback((ref: string): boolean => {
    const row = [...surface.current?.querySelectorAll<HTMLElement>("[data-outline-occurrence][data-resource-ref]") ?? []].find(row => row.dataset.resourceRef === ref && row.closest("[data-local-outline]")===surface.current);
    const editor=ref.startsWith("note_block:")?row?.querySelector<HTMLElement>('[role="textbox"]'):row;
    editor?.focus();
    return editor!==null && editor!==undefined;
  }, []);
  const focusResource = useCallback(async(ref:string,signal?:AbortSignal):Promise<boolean> => {
    const requestId=++focusRequest.current;
    pendingFocus.current?.fail(new DOMException("focus superseded","AbortError"));
    signal?.throwIfAborted();
    if(focusVisible(ref))return true;
    if(!runtime)return false;
    const store=await runtime.store;
    const [endpoint_a,endpoint_b]=sortedEndpoints(rootRef,ref);
    const binding=await store.query({kind:"binding",key:{kind:"link",endpoint_a,endpoint_b}});
    signal?.throwIfAborted();
    if(binding.binding_id===null)return false;
    const [states,projection]=await Promise.all([store.readStates(selectStates({link_ids:[binding.binding_id]})),store.query({kind:"resource",ref})]);
    signal?.throwIfAborted();
    const link=states.links.find(link=>link.link_id===binding.binding_id),resource=projection.rows[0]?.resource;
    if(!link||!isVisible(link.add_vv,link.remove_vv)||!resource?.visible)return false;
    const document=resource.kind==="note"?await runtime.openDocument(ref):null;
    const release=document?.retain()??(()=>{});
    if(signal?.aborted){release();signal.throwIfAborted();}
    if(requestId!==focusRequest.current){release();throw new DOMException("focus retired","AbortError");}
    return new Promise<boolean>((resolve,reject)=>{
      pendingFocus.current?.fail(new DOMException("focus superseded","AbortError"));
      let done=false;
      const finish=(error:unknown,value:boolean)=>{
        if(done)return;done=true;release();signal?.removeEventListener("abort",abort);
        if(pendingFocus.current===request)pendingFocus.current=null;
        if(error!==null)reject(error);else resolve(value);
      };
      const abort=()=>finish(signal?.reason??new DOMException("focus canceled","AbortError"),false);
      const request={ref,finish:(value:boolean)=>finish(null,value),fail:(error:unknown)=>finish(error,false)};
      pendingFocus.current=request;
      signal?.addEventListener("abort",abort,{once:true});
      setWindow({root:rootRef,anchor:binding.binding_id,cursor:null});setFocusRevision(value=>value+1);
    });
  },[focusVisible,runtime,rootRef]);
  const focus = useCallback(async(ref:string)=>{await focusResource(ref);},[focusResource]);
  useEffect(()=>{
    const request=pendingFocus.current;
    if(!request)return;
    const attempt=()=>{
      if(pendingFocus.current!==request)return;
      if(focusVisible(request.ref)){request.finish(true);return;}
      if(read.error){request.fail(read.error);return;}
      if(read.data&&!read.data.rows.some(row=>row.resource.ref===request.ref))request.finish(false);
    };
    const observer=new MutationObserver(()=>{attempt();if(pendingFocus.current!==request)observer.disconnect();});
    attempt();
    if(pendingFocus.current===request&&surface.current)observer.observe(surface.current,{childList:true,subtree:true});
    return()=>observer.disconnect();
  },[focusRevision,read.data,read.error,focusVisible]);
  useEffect(()=>()=>{focusRequest.current++;pendingFocus.current?.fail(new DOMException("outline closed","AbortError"));},[]);
  useLayoutEffect(()=>{
    if(!apiRef||!history)return;
    const handle:LocalOutlineHandle={append:async()=>focus(await history.create(rootRef,null,undefined,prelude)),focusNote:focusResource,focusFirst:()=>{const first=rows[0];if(first)act(focus(first.resource.ref));}};
    apiRef.current=handle;
    return()=>{if(apiRef.current===handle)apiRef.current=null;};
  });
  const outdent = useCallback((link: LinkState) => {
    const parent = ancestors.filter(ref => ref !== rootRef).at(-1);
    if (parent && history) act(history.relink(link, rootRef, parent));
  },[ancestors,rootRef,history,act]);
  const adjacentNote=useCallback(async(link:LinkState,side:"before"|"after"):Promise<string|null>=>{
    if(!runtime)return null;
    const store=await runtime.store;
    const neighbors=await store.query({kind:"positions",ref:rootRef,exclude_link_id:null,at:{kind:"neighbors",link_id:link.link_id,side}});
    const previous=neighbors.positions.find(item=>item.link_id!==link.link_id);
    if(!previous)return null;
    const ref=previous.endpoint_a===rootRef?previous.endpoint_b:previous.endpoint_a;
    const result=await store.query({kind:"resource",ref});
    return result.rows[0]?.resource.kind==="note"?ref:null;
  },[runtime,rootRef]);
  const publication=useMemo(()=>{
    if(!active||!history||filter.trim())return null;
    const row=rows.find(row=>row.link?.link_id===selected);
    const commandState=(command:OutlineCommand)=>{
      if(selection.state.keys.length>1&&command!=="undo"&&command!=="redo")return {enabled:false,reason:"select one item to arrange"};
      let enabled=true;
      if(command==="undo")enabled=history.canUndo();
      else if(command==="redo")enabled=history.canRedo();
      else if(command==="outdent")enabled=!!row&&ancestors.some(ref=>ref!==rootRef);
      else if(command==="indent")enabled=!!row&&(rows.indexOf(row)>0?rows[rows.indexOf(row)-1]?.resource.kind==="note":current.cursor!==null||read.data?.previous_cursor!==null);
      else if(command==="move_up"||command==="move_down")enabled=!!row;
      return {enabled,reason:enabled?null:"no item available"};
    };
    return {session:`local:${occurrencePrefix}`,insertLabel:"insert item",commandState,
      executeCommand:(command:OutlineCommand)=>{
        if(!commandState(command).enabled)return;
        if(command==="undo")history.undo();
        else if(command==="redo")history.redo();
        else if(command==="insert")act(history.create(rootRef,row?.link?.link_id??null,undefined,prelude).then(focus));
        else if(row?.link){
          if(command==="outdent")outdent(row.link);
          else if(command==="indent")act((async()=>{const parent=await adjacentNote(row.link!,"before");if(parent)await history.relink(row.link!,rootRef,parent);})());
          else act(history.moveAdjacent(row.link,rootRef,command==="move_up"?"before":"after"));
        }
      },done:()=>{(surface.current?.ownerDocument.activeElement as HTMLElement|null)?.blur();setActive(false);},
    };
  },[active,history,filter,rows,selected,ancestors,rootRef,occurrencePrefix,prelude,act,focus,outdent,selection.state.keys,adjacentNote,current.cursor,read.data]);
  usePaneOutlineCommands(publication);
  if (!runtime || !history) return null;
  return <BlockSelectionContext value={selection}><HistoryContext value={history}><div ref={surface} data-local-outline="true"
    onFocusCapture={event=>setActive(event.target.closest('[data-local-outline]')===event.currentTarget)}
    onBlurCapture={event=>{if(!event.currentTarget.contains(event.relatedTarget))setActive(false);}}>
    {read.error ? <div role="alert"><p>couldn’t open these links on this device.</p><Button onClick={read.retry}>retry</Button></div> : null}
    {error ? <div role="alert"><p>{error instanceof Error ? error.message : "this change couldn’t be saved on this device."}</p>{writingStoreStopped(error) ? <><Button onClick={()=>{void runtime.uncommittedText().then(text=>navigator.clipboard.writeText(text));}}>copy writing</Button><Button onClick={()=>window.location.reload()}>restart nexus</Button></> : error instanceof LocalCommitError ? <Button onClick={() => { void error.retry().then(() => setError(null), setError); }}>retry saving</Button> : retryReference ? <Button onClick={()=>act(retryReference().then(()=>setRetryReference(null)))}>retry linking</Button> : null}</div> : null}
    <ResourceOutlineList scope={`local:${rootRef}`} ariaLabel="linked resources" ancestorRef={rootRef}>
      {rows.map((row, index) => {
        const link = row.link!;
        const ref = row.resource.ref;
        const key=`${occurrencePrefix}/${link.link_id}`;
        const indent = () => act((async()=>{const parent=await adjacentNote(link,"before");if(parent)await history.relink(link,rootRef,parent);})());
        const move = (direction: number) => act(history.moveAdjacent(link,rootRef,direction<0?"before":"after"));
        const join = (direction:"backward"|"forward",displayed:Promise<import("@/lib/notes/runtime").WritingSnapshot>) => act((async()=>{const [neighbor,shown]=await Promise.all([adjacentNote(link,direction==="backward"?"before":"after"),displayed]);if(neighbor&&neighbor!==ref){const destination=direction==="backward"?neighbor:ref;await history.join(destination,direction==="backward"?ref:neighbor,direction==="backward"?{source:shown}:{destination:shown});await focus(destination);}})());
        if(filter.trim() && ![row.resource.title,row.resource.body_text,row.resource.selection?.quote_exact].some(value=>value?.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase())))return null;
        return <ResourceOutlineRow key={link.link_id} resourceRef={ref} occurrenceKey={`${occurrencePrefix}/${link.link_id}`}
          incoming={{ kind: "link", linkId:link.link_id,parentLabel:rootRef,unlink:()=>act(history.unlink(link)) }} editable={!filter.trim()}
          body={row.resource.kind === "note" ? <BoundNoteEditor noteRef={ref} session={history} editable={!filter.trim()} onSplit={position => act(history.split(ref, position, rootRef, link.link_id).then(focus))} onJoin={join}
            reference={{source_ref:rootRef,label:rootRef,onSelected:(target,item)=>{
              const accept=async()=>{const endpoint=await prepareTarget(runtime,target);await history.paste(rootRef,link.link_id,[{kind:"resource",ref:endpoint.ref,label:item.label,parent:null}],endpoint.intents);};
              setRetryReference(()=>accept);
              act(accept().then(()=>setRetryReference(null)));
            }}}
            structuralKeys={{ indent, outdent: () => outdent(link), selectBlock: () => {setSelected(link.link_id);selectBlocks(key,false);surface.current?.querySelector<HTMLElement>(`[data-resource-ref="${ref}"]`)?.focus();} }} /> : undefined}
          rootProps={{
            "data-selected": selection.state.keys.includes(key),
            tabIndex:0,
            onClick:event=>{if(event.target instanceof Element&&event.target.closest('[data-outline-occurrence]')===event.currentTarget&&!event.target.closest('a,button,input,textarea,[contenteditable=true]')){setSelected(link.link_id);selectBlocks(key,event.shiftKey);event.currentTarget.focus();}},
            onCopy:event=>{
              if(event.target!==event.currentTarget||!selection.state.keys.includes(key))return;
              event.preventDefault();
              writeOutlineClipboard(event.clipboardData,clipboardItems());
            },
            onCut:event=>{
              if(event.target!==event.currentTarget||!selection.state.keys.includes(key)||filter.trim())return;
              event.preventDefault();
              writeOutlineClipboard(event.clipboardData,clipboardItems());
              act(history.unlinkMany(selectedRows().map(row=>row.link)));
            },
            onPaste:event=>{
              if(event.target!==event.currentTarget||filter.trim())return;
              event.preventDefault();
              try{const items=readOutlineClipboard(event.clipboardData);act(history.paste(rootRef,link.link_id,items,prelude).then(refs=>{if(refs[0])focus(refs[0]);}));}catch(error){setError(error);}
            },
            onFocus: event => {if(event.target instanceof Element && event.target.closest("[data-local-outline]")===surface.current){setSelected(link.link_id);if(event.target.closest('[role="textbox"]'))selection.set({anchor:null,keys:[]});}},
            draggable: true,
            onDragStart: event => { if (!(event.target instanceof Element) || event.target.closest('[data-outline-occurrence]')!==event.currentTarget || event.target.closest('[role="textbox"]')) return;event.stopPropagation(); event.dataTransfer.setData(CLIPBOARD, JSON.stringify({ link_id: link.link_id, parent_ref: rootRef })); },
            onDragOver: event => { if (event.dataTransfer.types.includes(CLIPBOARD)) event.preventDefault(); },
            onDrop: event => {
              if (!event.dataTransfer.types.includes(CLIPBOARD)) return;
              event.preventDefault(); event.stopPropagation();
              let value: unknown;
              try { value = JSON.parse(event.dataTransfer.getData(CLIPBOARD)); } catch { return; }
              if (!value || typeof value !== "object" || !("link_id" in value) || !("parent_ref" in value) || typeof value.link_id !== "string" || typeof value.parent_ref !== "string") return;
              const id = value.link_id, parent = value.parent_ref;
              act((async () => {
                const state = await (await runtime.store).readStates(selectStates({ link_ids: [id] }));
                const dragged = state.links[0];
                if (!dragged || id === link.link_id) return;
                if (parent !== rootRef) await history.relink(dragged, parent, rootRef);
                else await history.move(dragged, rootRef, links, index);
              })());
            },
            onKeyDown: event => {
              if (filter.trim() || event.defaultPrevented || event.nativeEvent.isComposing) return;
              if(event.target===event.currentTarget&&event.key===" "&&!selection.state.keys.includes(key)){event.preventDefault();selectBlocks(key,false);return;}
              if(event.target===event.currentTarget&&event.key==="Escape"){
                event.preventDefault();selection.set({anchor:null,keys:[]});event.currentTarget.querySelector<HTMLElement>("[data-outline-bullet]")?.focus();return;
              }
              if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") { event.preventDefault(); if (event.shiftKey) history.redo(); else history.undo(); return; }
              if (event.altKey && event.shiftKey && event.key === "ArrowUp") { event.preventDefault(); move(-1); return; }
              if (event.altKey && event.shiftKey && event.key === "ArrowDown") { event.preventDefault(); move(1); return; }
              if (event.target instanceof Element && event.target.closest('[role="textbox"]')) return;
              if(event.key==="ArrowUp"||event.key==="ArrowDown"){
                event.preventDefault();event.stopPropagation();
                const order=visible(),at=order.findIndex(element=>element.dataset.outlineOccurrence===key),next=order[at+(event.key==="ArrowUp"?-1:1)];
                if(next){selectBlocks(next.dataset.outlineOccurrence!,event.shiftKey);next.focus();}
                return;
              }
              if (event.key === "Tab") { event.preventDefault(); if (event.shiftKey) outdent(link); else indent(); }
              else if (event.key === "Backspace" || event.key === "Delete") { event.preventDefault(); act(history.unlinkMany(selection.state.keys.includes(key)?selectedRows().map(row=>row.link):[link])); }
              else if (event.key === "Enter") { event.preventDefault(); act(history.create(rootRef, link.link_id).then(focus)); }
            },
          }} />;
      })}
    </ResourceOutlineList>
    {current.cursor!==null || current.anchor!==null ? <Button onClick={()=>setWindow({root:rootRef,anchor:read.data?.previous_cursor??null,cursor:null})}>previous links</Button> : null}
    {read.data?.next_cursor !== null && read.data !== null ? <Button onClick={()=>setWindow({root:rootRef,anchor:null,cursor:read.data!.next_cursor})}>next links</Button> : null}
    {!filter.trim() ? <ResourceComposer destinationRef={rootRef} occurrenceKey={`local:${rootRef}:insert`} label="add a note or link" prelude={prelude} afterSave="clear" onSaved={ref=>act(focus(ref))} /> : null}
  </div></HistoryContext></BlockSelectionContext>;
}
