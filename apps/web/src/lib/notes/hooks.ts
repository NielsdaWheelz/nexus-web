"use client";
/** React reads subscribe to the local account database, including online. */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
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
  const cell = useMemo(() => {
    const empty: { data: QueryResult | null; error: unknown | null } = { data: null, error: null };
    let snapshot = empty;
    return {
      snapshot: () => snapshot,
      serverSnapshot: () => empty,
      subscribe: (notify: () => void) => {
        if (query === null || accountId === null) return () => {};
        if (snapshot.error !== null) { snapshot = { data: snapshot.data, error: null }; notify(); }
        let retired = false;
        let latestRevision: bigint | null = null;
        const unsubscribe = store.subscribe(query, data => {
          const revision = BigInt(data.store_revision);
          if (retired || latestRevision !== null && revision < latestRevision) return;
          latestRevision = revision;
          snapshot = { data, error: null }; notify();
        }, error => {
          if (!retired) { snapshot = { data: snapshot.data, error }; notify(); }
        });
        return () => { retired = true; unsubscribe(); };
      },
    };
    // The serialized closed query owns this cell; creating it performs no read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, key, store]);
  const subscribe = useCallback((notify: () => void) => cell.subscribe(notify),
    // Retry reattaches the same cell: retain rows, clear error, and catch up once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cell, attempt]);
  const state = useSyncExternalStore(subscribe, cell.snapshot, cell.serverSnapshot);
  const retry = useCallback(() => setAttempt(n => n + 1), []);
  return { ...state, retry };
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
type CursorQuery = Extract<AuthoredQuery, { cursor: string | null }>;
export function useAuthoredPrefix(query: CursorQuery | null, count: number) {
  const store = useAuthoredStore();
  const accountId = useAuthoredAccountId();
  const key = JSON.stringify([accountId, query === null ? null : { ...query, cursor: null }]);
  const [state, setState] = useState<{ key: string; data: QueryResult | null; error: unknown | null }>({ key, data: null, error: null });
  const [attempt, retry] = useState(0);
  useEffect(() => {
    setState(old => ({ key, data: query !== null && old.key === key ? old.data : null, error: null }));
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
            setState({ key, data: { ...next, rows: [], next_cursor: null }, error: null });
            return;
          }
          rows.push(...next.rows); cursor = next.next_cursor;
        }
        if (active && current === generation) setState({ key, data: { ...first, rows, next_cursor: cursor }, error: null });
      })().catch(error => { if (active && current === generation) setState(old => ({ key, data: old.key === key ? old.data : null, error })); });
    };
    const unsubscribe = store.subscribe(firstQuery, receive, error => {
      if (!active) return;
      generation++;
      setState(old => ({ key, data: old.key === key ? old.data : null, error }));
    });
    return () => { active = false; generation++; unsubscribe(); };
    // The serialized query is its stable value identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, key, count, attempt]);
  return { data: query !== null && state.key === key ? state.data : null, error: query !== null && state.key === key ? state.error : null, retry: () => retry(n => n + 1) };
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
