"use client";

/** One outer outline batches mounted occurrence probes. Local committed links are
 * authoritative; remote facts fail separately and never decide local emptiness.
 * Descriptor identity fences results from a previous occurrence's exclusions. */
import {useCallback, useEffect, useState} from "react";
import {useAuthoredStore} from "@/lib/authored/provider";
import {apiFetch} from "@/lib/api/client";
import type {ApiJson,Schema} from "@/lib/api/wire";
import {useChangeStamp} from "@/lib/api/changes";
import {usePaneFreeServerValue} from "@/lib/api/serverState";
import type {ChildOccurrence} from "@nexus/authored/types";

export interface OutlineChildrenDescriptor {
  identity: string;
  resource_ref: string;
  excluded_edge_ids: string[];
}
type RemoteProof=Schema<"RemoteChildrenItem">;
interface Proof {identity:string;value:boolean;local_ref:string|null}
export function useOutlineChildren(scope:string,descriptors:ReadonlyMap<string,OutlineChildrenDescriptor>){
  const store=useAuthoredStore();
  const entries=[...descriptors].sort(([a],[b])=>a.localeCompare(b));
  const key=JSON.stringify(entries);
  const [attempt,setAttempt]=useState(0);
  const remote=usePaneFreeServerValue<Map<string,{identity:string;proof:RemoteProof}>>({
    key:entries.length?`outline-facts:${scope}`:null,
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
  const occurrences:ChildOccurrence[]=entries.map(([id,descriptor])=>{
    const retained=proofFor(id,descriptor.identity);
    const owner=retained?.identity===descriptor.identity?retained.proof.local_ref:null;
    return {key:id,refs:owner&&owner!==descriptor.resource_ref?[descriptor.resource_ref,owner]:[descriptor.resource_ref],excluded_link_ids:descriptor.excluded_edge_ids};
  });
  const localKey=JSON.stringify(occurrences);
  const [local,setLocal]=useState<{proofs:ReadonlyMap<string,{query:ChildOccurrence;value:boolean}>;errors:ReadonlyMap<string,unknown>}>(()=>({proofs:new Map(),errors:new Map()}));
  useEffect(()=>{
    let active=true;const stops:(()=>void)[]=[];
    const mounted=new Set(occurrences.map(item=>item.key));
    setLocal(current=>({proofs:new Map([...current.proofs].filter(([id])=>mounted.has(id))),errors:new Map()}));
    for(let offset=0;offset<occurrences.length;offset+=100){
      const chunk=occurrences.slice(offset,offset+100),query={kind:"children" as const,occurrences:chunk},chunkKey=JSON.stringify(chunk);
      let revision:bigint|null=null;
      const receive=(result:Awaited<ReturnType<typeof store.query>>)=>{
        if(!active||revision!==null&&BigInt(result.store_revision)<revision)return;
        revision=BigInt(result.store_revision);
        const positive=new Set(result.child_keys);
        setLocal(current=>{
          const proofs=new Map(current.proofs),errors=new Map(current.errors);errors.delete(chunkKey);
          for(const item of chunk)proofs.set(item.key,{query:item,value:positive.has(item.key)});
          return {proofs,errors};
        });
      };
      stops.push(store.subscribe(query,receive));
      void store.query(query).then(receive,error=>{if(active&&revision===null)setLocal(current=>({...current,errors:new Map(current.errors).set(chunkKey,error)}));});
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
    const localProof=local.proofs.get(id),query=localQueries.get(id)!;
    const localPositive=localProof?.value===true&&JSON.stringify(localProof.query.excluded_link_ids)===JSON.stringify(query.excluded_link_ids)&&localProof.query.refs.every(ref=>query.refs.includes(ref));
    items.set(id,{identity:descriptor.identity,value:localPositive||fact?.has_children===true,local_ref:fact?.local_ref??null});
  }
  const retry=useCallback(()=>setAttempt(n=>n+1),[]);
  return {items,error:local.errors.values().next().value??null,remoteError:remote.status==="loading"?null:remote.error,retry};
}
