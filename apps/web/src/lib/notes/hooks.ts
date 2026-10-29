"use client";
/** React reads subscribe to the local account database, including online. */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { Intent } from "@nexus/authored/commands";
import type { AuthoredQuery, QueryResult } from "@nexus/authored/types";
import { useAuthoredStore, useAuthoredAccountId } from "@/lib/authored/provider";
import { getWritingRuntime, type DocumentReadSnapshot, type WritingDocument, type WritingRuntime } from "./runtime";
export function useWritingRuntime(): WritingRuntime | null {
  const accountId = useAuthoredAccountId();
  return useMemo(() => accountId === null ? null : getWritingRuntime(accountId), [accountId]);
}
export function useAuthoredQuery(query: AuthoredQuery | null) {
  const accountId = useAuthoredAccountId();
  const store = useAuthoredStore();
  const key = JSON.stringify(query);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ key: string; accountId: string | null; data: QueryResult | null; error: unknown | null; occurrence: object | null; pending: boolean }>({ key, accountId, data: null, error: null, occurrence: null, pending: query !== null });
  useEffect(() => {
    if (query === null || accountId === null) { setState({ key, accountId, data: null, error: null, occurrence: null, pending: false }); return; }
    setState(old => old.key === key && old.accountId === accountId ? {...old, pending: true} : {key, accountId, data: null, error: null, occurrence: null, pending: true});
    let retired = false;
    let latestRevision: bigint | null = null;
    const receive = (data:QueryResult) => {
      const revision=BigInt(data.store_revision);
      if(retired || latestRevision!==null && revision<latestRevision)return;
      latestRevision=revision;
      setState({key,accountId,data,error:null,occurrence:null,pending:false});
    };
    const unsubscribe = store.subscribe(query, receive, error => {
      if (!retired) setState(old => ({ key, accountId, data: old.key === key && old.accountId === accountId ? old.data : null, error, occurrence: old.key === key && old.accountId === accountId ? old.occurrence ?? {} : {}, pending: false }));
    });
    return () => { retired = true; unsubscribe(); };
    // The serialized closed query is its stable value identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, key, attempt, store]);
  const retry = useCallback(() => setAttempt(n => n + 1), []);
  const current = state.key === key && state.accountId === accountId;
  return { data: current ? state.data : null, error: current ? state.error : null, occurrence: current ? state.occurrence : null, pending: query !== null && (!current || state.pending), retry };
}
const NO_READ: DocumentReadSnapshot = {retrying: false, error: null, occurrence: null};
const noSubscribe = () => () => {};
const noRead = () => NO_READ;
export function useWritingDocumentRead(document: WritingDocument | null): DocumentReadSnapshot {
  return useSyncExternalStore(document?.subscribeRead ?? noSubscribe, document?.readSnapshot ?? noRead, noRead);
}
export function useWritingDocument(ref: string | null, prelude: readonly Intent[] = []) {
  const runtime = useWritingRuntime();
  const preludeKey = JSON.stringify(prelude);
  const [attempt,setAttempt]=useState(0);
  const retry=useCallback(()=>setAttempt(value=>value+1),[]);
  const [state, setState] = useState<{ ref: string | null; runtime: WritingRuntime | null; document: WritingDocument | null; error: unknown | null; occurrence: object | null; pending: boolean }>({ ref, runtime, document: null, error: null, occurrence: null, pending: ref !== null });
  useEffect(() => {
    if (!runtime || !ref) return;
    setState(old => old.ref === ref && old.runtime === runtime ? {...old, pending: true} : {ref, runtime, document: null, error: null, occurrence: null, pending: true});
    let retired = false;
    let release: (() => void) | null = null;
    void runtime.openDocument(ref, prelude).then(document => {
      if (retired) return;
      release = document.retain();
      setState({ ref, runtime, document, error: null, occurrence: null, pending: false });
    }).catch(error => { if (!retired) setState(old => ({ ref, runtime, document: null, error, occurrence: old.ref === ref && old.runtime === runtime ? old.occurrence ?? {} : {}, pending: false })); });
    return () => { retired = true; release?.(); };
    // The serialized prelude is its stable value identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtime, ref, preludeKey, attempt]);
  return {...(state.ref === ref && state.runtime === runtime ? state : { document: null, error: null, occurrence: null, pending: ref !== null }),retry};
}

/** Read a bounded prefix from one local revision. A newer subscription delivery
 * supersedes an in-flight traversal; mixed-revision pages are never published. */
type CursorQuery = Extract<AuthoredQuery, { cursor: string | null }>;
export function useAuthoredPrefix(query: CursorQuery | null, count: number) {
  const store = useAuthoredStore();
  const accountId = useAuthoredAccountId();
  const key = JSON.stringify([accountId, query === null ? null : { ...query, cursor: null }]);
  const [state, setState] = useState<{ key: string; data: QueryResult | null; error: unknown | null; occurrence: object | null; pending: boolean }>({ key, data: null, error: null, occurrence: null, pending: query !== null });
  const [attempt, retry] = useState(0);
  useEffect(() => {
    setState(old => query !== null && old.key === key ? {...old, pending: true} : {key, data: null, error: null, occurrence: null, pending: query !== null});
    if (query === null) return;
    let generation = 0;
    let active = true;
    let latestRevision:bigint|null=null;
    const firstQuery = { ...query, cursor: null };
    const receive = (first: QueryResult) => {
      const revision=BigInt(first.store_revision);
      if(!active || latestRevision!==null && revision<latestRevision)return;
      latestRevision=revision;
      const current = ++generation;
      void (async () => {
        const rows = first.scope_available === false ? [] : [...first.rows];
        let cursor = first.scope_available === false ? null : first.next_cursor;
        for (let page = 1; page < count && cursor !== null; page++) {
          const next = await store.query({ ...query, cursor });
          if (!active || current !== generation || next.store_revision !== first.store_revision) return;
          if (next.scope_available === false) {
            setState({ key, data: { ...next, rows: [], next_cursor: null }, error: null, occurrence: null, pending: false });
            return;
          }
          rows.push(...next.rows); cursor = next.next_cursor;
        }
        if (active && current === generation) setState({ key, data: { ...first, rows, next_cursor: cursor }, error: null, occurrence: null, pending: false });
      })().catch(error => { if (active && current === generation) setState(old => ({ key, data: old.key === key ? old.data : null, error, occurrence: old.key === key ? old.occurrence ?? {} : {}, pending: false })); });
    };
    const unsubscribe = store.subscribe(firstQuery, receive, error => {
      if (!active) return;
      generation++;
      setState(old => ({ key, data: old.key === key ? old.data : null, error, occurrence: old.key === key ? old.occurrence ?? {} : {}, pending: false }));
    });
    return () => { active = false; generation++; unsubscribe(); };
    // The serialized query is its stable value identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, key, count, attempt]);
  return { data: query !== null && state.key === key ? state.data : null, error: query !== null && state.key === key ? state.error : null, occurrence: query !== null && state.key === key ? state.occurrence : null, pending: query !== null && (state.key !== key || state.pending), retry: () => retry(n => n + 1) };
}

/** The picker owns its page count; controlled search passes its count to the same prefix owner. */
export function useAuthoredPages(query: CursorQuery | null) {
  const accountId = useAuthoredAccountId();
  const key = JSON.stringify([accountId, query === null ? null : { ...query, cursor: null }]);
  const [pages, setPages] = useState({ key, count: 1 });
  const count = pages.key === key ? pages.count : 1;
  const prefix = useAuthoredPrefix(query, count);
  return { ...prefix, more: () => setPages({ key, count: count + 1 }) };
}
