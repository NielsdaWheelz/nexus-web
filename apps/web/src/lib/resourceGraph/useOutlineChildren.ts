"use client";

/** One outer outline batches mounted occurrence probes. Local committed links are
 * authoritative; remote facts fail separately and never decide local emptiness.
 * Descriptor identity fences results from a previous occurrence's exclusions. */
import {useCallback, useEffect, useState} from "react";
import {useAuthoredStore, useAuthoredAccountId} from "@/lib/authored/provider";
import {useFeedbackOccurrence} from "@/components/feedback/Feedback";
import {apiFetch} from "@/lib/api/client";
import type {ApiJson,Schema} from "@/lib/api/wire";
import {useChangeStamp} from "@/lib/api/changes";
import {usePaneFreeServerValue} from "@/lib/api/serverState";
import type {OutlineChildrenOccurrence} from "@nexus/authored/types";

export interface OutlineChildrenDescriptor {
  identity: string;
  resource_ref: string;
  excluded_edge_ids: string[];
}
type RemoteProof=Schema<"RemoteChildrenItem">;
interface Proof {identity:string;value:boolean;local_ref:string|null}
export function useOutlineChildren(scope:string,descriptors:ReadonlyMap<string,OutlineChildrenDescriptor>){
  const store=useAuthoredStore();
  const accountId=useAuthoredAccountId();
  const entries=[...descriptors].sort(([a],[b])=>a.localeCompare(b));
  const key=JSON.stringify(entries);
  const [attempt,setAttempt]=useState(0);
  const remoteKey=entries.length?JSON.stringify(["outline-facts",scope,key]):null;
  const remote=usePaneFreeServerValue<Map<string,{identity:string;proof:RemoteProof}>>({
    key:remoteKey,
    stale:JSON.stringify([key,useChangeStamp("Metadata"),attempt]),
    load:async signal=>{
      const proofs=new Map<string,{identity:string;proof:RemoteProof}>();
      for(let offset=0;offset<entries.length;offset+=100){
        const chunk=entries.slice(offset,offset+100);
        const {data}=await apiFetch<ApiJson<"/resource-graph/connections/children/query","post">>("/api/resource-graph/connections/children/query",{method:"POST",signal,body:JSON.stringify({occurrences:chunk.map(([,descriptor])=>({resource_ref:descriptor.resource_ref,excluded_edge_ids:descriptor.excluded_edge_ids}))})});
        if(data.items.length!==chunk.length)throw Error("Remote child proof cardinality mismatch");
        chunk.forEach(([id,descriptor],index)=>proofs.set(id,{identity:descriptor.identity,proof:data.items[index]!}));
      }
      return proofs;
    },
  });
  const readyRemote=remote.status==="ready"?remote.data:null;
  const [retainedRemote,setRetainedRemote]=useState<ReadonlyMap<string,{identity:string;proof:RemoteProof}>>(()=>new Map());
  useEffect(()=>{
    setRetainedRemote(current=>{
      const next=new Map<string,{identity:string;proof:RemoteProof}>();
      for(const [id,descriptor]of entries){const incoming=readyRemote?.get(id),proof=incoming?.identity===descriptor.identity?incoming:current.get(id);if(proof?.identity===descriptor.identity)next.set(id,proof);}
      return next.size===current.size&&[...next].every(([id,proof])=>current.get(id)===proof)?current:next;
    });
    // The serialized mounted descriptors own retention; failed refreshes do not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[key,readyRemote]);
  const proofFor=(id:string,identity:string)=>{const incoming=readyRemote?.get(id);return incoming?.identity===identity?incoming:retainedRemote.get(id);};
  const occurrences:(OutlineChildrenOccurrence&{key:string})[]=entries.map(([id,descriptor])=>{
    const retained=proofFor(id,descriptor.identity);
    const owner=retained?.identity===descriptor.identity?retained.proof.local_ref:null;
    return {key:id,refs:owner&&owner!==descriptor.resource_ref?[descriptor.resource_ref,owner]:[descriptor.resource_ref],excluded_link_ids:descriptor.excluded_edge_ids};
  });
  const localKey=JSON.stringify([accountId,occurrences]);
  const chunkKeys=new Set<string>();
  for(let offset=0;offset<occurrences.length;offset+=100)chunkKeys.add(JSON.stringify(occurrences.slice(offset,offset+100)));
  const [local,setLocal]=useState<{proofs:ReadonlyMap<string,{query:OutlineChildrenOccurrence&{key:string};value:boolean}>;errors:ReadonlyMap<string,{error:unknown;occurrence:object}>;pending:ReadonlySet<string>;accountId:string|null}>(()=>({proofs:new Map(),errors:new Map(),pending:chunkKeys,accountId}));
  useEffect(()=>{
    let active=true;const stops:(()=>void)[]=[];
    const mounted=new Set(occurrences.map(item=>item.key));
    setLocal(current=>({accountId,proofs:new Map(current.accountId===accountId?[...current.proofs].filter(([id])=>mounted.has(id)):[]),errors:new Map(current.accountId===accountId?[...current.errors].filter(([key])=>chunkKeys.has(key)):[]),pending:chunkKeys}));
    for(let offset=0;offset<occurrences.length;offset+=100){
      const chunk=occurrences.slice(offset,offset+100),query={kind:"outline_children" as const,occurrences:chunk.map(({refs,excluded_link_ids})=>({refs,excluded_link_ids}))},chunkKey=JSON.stringify(chunk);
      let revision:bigint|null=null;
      const receive=(result:Awaited<ReturnType<typeof store.query>>)=>{
        if(!active||revision!==null&&BigInt(result.store_revision)<revision)return;
        revision=BigInt(result.store_revision);
        if(result.children.length!==chunk.length)throw Error("Local child proof cardinality mismatch");
        setLocal(current=>{
          const proofs=new Map(current.proofs),errors=new Map(current.errors);errors.delete(chunkKey);
          chunk.forEach((item,index)=>proofs.set(item.key,{query:item,value:result.children[index]===true}));
          const pending=new Set(current.pending);pending.delete(chunkKey);
          return {accountId,proofs,errors,pending};
        });
      };
      stops.push(store.subscribe(query,receive,error=>{
        if(!active)return;
        setLocal(current=>{
        const pending=new Set(current.pending);pending.delete(chunkKey);
        return {...current,pending,errors:new Map(current.errors).set(chunkKey,{error,occurrence:current.errors.get(chunkKey)?.occurrence??{}})};
      });}));
    }
    return()=>{active=false;for(const stop of stops)stop();};
    // Serialized descriptors are the closed query's identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[store,localKey,attempt]);
  const localQueries=new Map(occurrences.map(item=>[item.key,item]));
  const items=new Map<string,Proof>();
  for(const [id,descriptor]of entries){
    const retained=proofFor(id,descriptor.identity);
    const fact=retained?.identity===descriptor.identity?retained.proof:null;
    const localProof=local.accountId===accountId?local.proofs.get(id):null,query=localQueries.get(id)!;
    const localPositive=localProof?.value===true&&JSON.stringify(localProof.query.excluded_link_ids)===JSON.stringify(query.excluded_link_ids)&&localProof.query.refs.every(ref=>query.refs.includes(ref));
    items.set(id,{identity:descriptor.identity,value:localPositive||fact?.has_children===true,local_ref:fact?.local_ref??null});
  }
  const retry=useCallback(()=>setAttempt(n=>n+1),[]);
  const failure=local.accountId===accountId?[...local.errors].find(([key])=>chunkKeys.has(key))?.[1]??null:null;
  const remoteError=remote.status==="loading"?null:remote.error;
  const remoteOccurrence=useFeedbackOccurrence(remoteError!==null,remoteKey);
  return {items,error:failure?.error??null,occurrence:failure?.occurrence??null,
    pending:local.accountId!==accountId||[...local.pending].some(key=>chunkKeys.has(key)),
    remoteError,remoteOccurrence,remotePending:remote.status==="loading"||remote.status==="failed"&&remote.retrying||remote.status==="ready"&&remote.refreshing,retry};
}
