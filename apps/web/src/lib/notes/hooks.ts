"use client";
/** React reads subscribe to the local account database, including online. */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Intent } from "@nexus/authored/commands";
import type { AuthoredQuery, QueryResult } from "@nexus/authored/types";
import { useAuthoredStore, useAuthoredAccountId } from "@/lib/authored/provider";
import { getWritingRuntime, type WritingDocument, type WritingRuntime } from "./runtime";
export function useWritingRuntime(): WritingRuntime | null {
  const accountId = useAuthoredAccountId();
  return useMemo(() => accountId === null ? null : getWritingRuntime(accountId), [accountId]);
}
export function useAuthoredQuery(query: AuthoredQuery | null): { data: QueryResult | null; error: unknown | null; retry(): void } {
  const accountId = useAuthoredAccountId();
  const store = useAuthoredStore();
  const key = JSON.stringify(query);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ key: string; accountId: string | null; data: QueryResult | null; error: unknown | null }>({ key, accountId, data: null, error: null });
  useEffect(() => {
    if (query === null || accountId === null) return;
    let retired = false;
    let latestRevision: bigint | null = null;
    const receive = (data:QueryResult) => {
      const revision=BigInt(data.store_revision);
      if(retired || latestRevision!==null && revision<latestRevision)return;
      latestRevision=revision;
      setState({key,accountId,data,error:null});
    };
    const unsubscribe = store.subscribe(query, receive);
    void store.query(query).then(receive).catch(error => { if (!retired && latestRevision===null) setState({ key, accountId, data: null, error }); });
    return () => { retired = true; unsubscribe(); };
    // The serialized closed query is its stable value identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, key, attempt, store]);
  const retry = useCallback(() => setAttempt(n => n + 1), []);
  return { data: state.key === key && state.accountId === accountId ? state.data : null, error: state.key === key && state.accountId === accountId ? state.error : null, retry };
}
export function useWritingDocument(ref: string | null, prelude: readonly Intent[] = []): { document: WritingDocument | null; error: unknown | null; retry():void } {
  const runtime = useWritingRuntime();
  const preludeKey = JSON.stringify(prelude);
  const [attempt,setAttempt]=useState(0);
  const retry=useCallback(()=>setAttempt(value=>value+1),[]);
  const [state, setState] = useState<{ ref: string | null; runtime: WritingRuntime | null; document: WritingDocument | null; error: unknown | null }>({ ref, runtime, document: null, error: null });
  useEffect(() => {
    if (!runtime || !ref) return;
    let retired = false;
    let release: (() => void) | null = null;
    void runtime.openDocument(ref, prelude).then(document => {
      if (retired) return;
      release = document.retain();
      setState({ ref, runtime, document, error: null });
    }).catch(error => { if (!retired) setState({ ref, runtime, document: null, error }); });
    return () => { retired = true; release?.(); };
    // The serialized prelude is its stable value identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtime, ref, preludeKey, attempt]);
  return {...(state.ref === ref && state.runtime === runtime ? state : { document: null, error: null }),retry};
}

/** Read a bounded prefix from one local revision. A newer subscription delivery
 * supersedes an in-flight traversal; mixed-revision pages are never published. */
export function useAuthoredPages(query: Extract<AuthoredQuery, { cursor: string | null }>) {
  const store = useAuthoredStore();
  const accountId = useAuthoredAccountId();
  const key = JSON.stringify([accountId,{ ...query, cursor: null }]);
  const [pages, setPages] = useState({ key, count: 1 });
  const count = pages.key === key ? pages.count : 1;
  const [state, setState] = useState<{ key: string; data: QueryResult | null; error: unknown | null }>({ key, data: null, error: null });
  const [attempt, retry] = useState(0);
  useEffect(() => {
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
        const rows = [...first.rows];
        let cursor = first.next_cursor;
        for (let page = 1; page < count && cursor !== null; page++) {
          const next = await store.query({ ...query, cursor });
          if (!active || current !== generation || next.store_revision !== first.store_revision) return;
          rows.push(...next.rows); cursor = next.next_cursor;
        }
        if (active && current === generation) setState({ key, data: { ...first, rows, next_cursor: cursor }, error: null });
      })().catch(error => { if (active && current === generation) setState(old => ({ key, data: old.key === key ? old.data : null, error })); });
    };
    const stop = store.subscribe(firstQuery, receive);
    void store.query(firstQuery).then(receive).catch(error => { if (active && latestRevision===null) setState({ key, data: null, error }); });
    return () => { active = false; generation++; stop(); };
    // The serialized query is its stable value identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, key, count, attempt]);
  return { data: state.key === key ? state.data : null, error: state.key === key ? state.error : null, more: () => setPages({ key, count: count + 1 }), retry: () => retry(n => n + 1) };
}
