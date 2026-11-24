"use client";
/** React reads subscribe to the local account database, including online. */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Intent } from "@nexus/authored/commands";
import type { AuthoredQuery, IndexRange, QueryResult } from "@nexus/authored/types";
import { useAuthoredStore, useAuthoredAccountId } from "@/lib/authored/provider";
import { getWritingRuntime, type WritingDocument, type WritingRuntime } from "./runtime";
import { subscribeAuthoredIndex, type AuthoredIndex, type StructuralQuery } from "./indexes";

export function useAuthoredIndex<Row>(query: StructuralQuery | null, select: (result: QueryResult) => IndexRange<Row> | null) {
  const store = useAuthoredStore(), account = useAuthoredAccountId();
  const key = JSON.stringify([account, query]);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{key: string; data: AuthoredIndex<Row> | null; error: unknown | null; pending: boolean}>(
    {key, data: null, error: null, pending: query !== null});
  useEffect(() => {
    if (query === null) return;
    setState(old => ({key, data: old.key === key ? old.data : null, error: null, pending: true}));
    return subscribeAuthoredIndex(store, query, select,
      data => setState({key, data, error: null, pending: false}),
      error => setState(old => ({key, data: old.key === key ? old.data : null, error, pending: false})));
    // The serialized closed query is its content identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, attempt, store, select]);
  const retry = useCallback(() => setAttempt(n => n + 1), []);
  return query !== null && state.key === key ? {...state, retry} : {data: null, error: null, pending: query !== null, retry};
}
export function useWritingRuntime(): WritingRuntime {
  const accountId = useAuthoredAccountId();
  return useMemo(() => getWritingRuntime(accountId), [accountId]);
}
/** Whether a failed commit holds one of these refs. Their editor turns its caret `--danger`
 * while the words are at risk: an echo of the risk slip, never the sole signal. */
export function useWordsAtRisk(refs: readonly string[]): boolean {
  const runtime = useWritingRuntime();
  const read = () => { const writing = runtime.snapshot(); return writing.error !== null && writing.error_refs.some(ref => refs.includes(ref)); };
  return useSyncExternalStore(runtime.subscribe, read, () => false);
}
export function useAuthoredQuery(query: AuthoredQuery | null) {
  const accountId = useAuthoredAccountId();
  const store = useAuthoredStore();
  const key = JSON.stringify(query);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ key: string; accountId: string; data: QueryResult | null; error: unknown | null; occurrence: object | null; pending: boolean }>({ key, accountId, data: null, error: null, occurrence: null, pending: query !== null });
  useEffect(() => {
    if (query === null) { setState({ key, accountId, data: null, error: null, occurrence: null, pending: false }); return; }
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
export function useWritingDocument(ref: string | null, prelude: readonly Intent[] = []) {
  const runtime = useWritingRuntime();
  const preludeKey = JSON.stringify(prelude);
  const [attempt,setAttempt]=useState(0);
  const retry=useCallback(()=>setAttempt(value=>value+1),[]);
  const [state, setState] = useState<{ ref: string | null; runtime: WritingRuntime; document: WritingDocument | null; error: unknown | null; occurrence: object | null; pending: boolean }>({ ref, runtime, document: null, error: null, occurrence: null, pending: ref !== null });
  useEffect(() => {
    if (!ref) return;
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

export class AuthoredContinuationCursorError extends Error {}

/** One admitted first-page subscription and one outstanding cursor. A demand
 * reads just that cursor; only its own live account, query and revision can append. */
export function useAuthoredContinuation(query: CursorQuery | null) {
  const store = useAuthoredStore(), account = useAuthoredAccountId();
  const key = JSON.stringify([account, query === null ? null : {...query, cursor: null}]);
  const [state, setState] = useState<{key: string; data: QueryResult | null; error: unknown | null; pending: boolean}>(
    {key, data: null, error: null, pending: query !== null});
  const owner = useRef<{key: string; more(signal?: AbortSignal): Promise<QueryResult | null>; retry(): void} | null>(null);

  useEffect(() => {
    if (query === null) return;
    const first = {...query, cursor: null};
    let live = true, generation = 0, replaying = false;
    let data: QueryResult | null = null, revision: bigint | null = null;
    let active: Promise<QueryResult | null> | null = null, failedCursor = false;
    let spent = new Set<string>();
    const publish = (pending: boolean, error: unknown | null = null) => {
      if (live) setState({key, data, error, pending});
    };
    function receive(next: QueryResult) {
      const incoming = BigInt(next.store_revision);
      if (!live || revision !== null && incoming < revision) return;
      // A repeat notification from the same snapshot cannot truncate an accepted suffix.
      if (data?.store_revision === next.store_revision && data.scope_available === next.scope_available) {
        if (replaying) { replaying = false; publish(false); }
        return;
      }
      const ticket = ++generation;
      revision = incoming;
      active = null;
      failedCursor = false;
      const pages = spent.size + 1;
      const commit = (value: QueryResult, cursors: Set<string>) => {
        data = value.scope_available ? value : {...value, rows: [], next_cursor: null};
        spent = value.scope_available ? cursors : new Set();
        replaying = false;
        publish(false);
      };
      if (!next.scope_available || pages === 1 || next.next_cursor === null) {
        commit(next, new Set());
        return;
      }
      replaying = true;
      publish(true);
      void (async () => {
        const cursors = new Set<string>();
        const rows = [...next.rows];
        let cursor = next.next_cursor;
        while (cursor !== null && cursors.size + 1 < pages) {
          cursors.add(cursor);
          next = await store.query({...first, cursor});
          if (!live || generation !== ticket) return;
          const version = BigInt(next.store_revision);
          if (!next.scope_available && version >= incoming) {
            revision = version;
            commit(next, new Set());
            return;
          }
          if (version !== incoming) {
            if (version > incoming) revision = version;
            refresh();
            return;
          }
          cursor = next.next_cursor;
          if (cursor !== null && cursors.has(cursor))
            throw new AuthoredContinuationCursorError("Local search returned a previous cursor");
          rows.push(...next.rows);
        }
        commit({...next, rows}, cursors);
      })().catch(error => {
        if (!live || generation !== ticket) return;
        replaying = false;
        publish(false, error);
      });
    }
    function refresh() {
      const ticket = ++generation;
      replaying = true;
      active = null;
      publish(true);
      void store.query(first).then(next => {
        if (live && generation === ticket) receive(next);
      }, error => {
        if (!live || generation !== ticket) return;
        replaying = false;
        publish(false, error);
      });
    }
    function more(signal?: AbortSignal): Promise<QueryResult | null> {
      if (!live || replaying || signal?.aborted || data === null || data.next_cursor === null) return Promise.resolve(null);
      if (active !== null) return active;
      const base = data, cursor = data.next_cursor, ticket = generation;
      failedCursor = false;
      publish(true);
      const read = store.query({...first, cursor}).then(next => {
        if (!live || generation !== ticket) return null;
        if (signal?.aborted) { publish(false); return null; }
        if (!next.scope_available) { receive(next); return data; }
        if (next.store_revision !== base.store_revision) {
          if (BigInt(next.store_revision) > BigInt(base.store_revision)) {
            revision = BigInt(next.store_revision);
            refresh();
          } else publish(false);
          return null;
        }
        if (next.next_cursor !== null && (next.next_cursor === cursor || spent.has(next.next_cursor))) {
          failedCursor = true; publish(false, new AuthoredContinuationCursorError("Local search returned a previous cursor")); return null;
        }
        spent.add(cursor);
        data = {...next, rows: [...base.rows, ...next.rows]};
        publish(false);
        return data;
      }, error => {
        if (live && generation === ticket) { failedCursor = !signal?.aborted; publish(false, signal?.aborted ? null : error); }
        return null;
      }).finally(() => { if (active === read) active = null; });
      active = read;
      return read;
    }
    owner.current = {key, more, retry: () => { if (failedCursor) void more(); else refresh(); }};
    publish(true);
    const unsubscribe = store.subscribe(first, receive, error => {
      if (!live) return;
      generation++; active = null; replaying = false; failedCursor = false; publish(false, error);
    });
    return () => { live = false; owner.current = null; unsubscribe(); };
    // The complete serialized query plus account is its subscription identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, store]);
  const more = useCallback((signal?: AbortSignal) => owner.current?.key === key ? owner.current.more(signal) : Promise.resolve(null), [key]);
  const retry = useCallback(() => { if (owner.current?.key === key) owner.current.retry(); }, [key]);
  const current = query !== null && state.key === key;
  return {data: current ? state.data : null, pending: query !== null && (!current || state.pending), error: current ? state.error : null, more, retry};
}

type Resolved = QueryResult["rows"][number]["resource"];
/** Resources by ref for a display that stays on screen while its set of refs changes: at most 100
 * refs, one local `resolve`. While a changed set is pending, this account's resources already
 * resolved for refs still in the set stand, provisionally; refs that left go at once. The settled
 * read then owns the rows, its absences and its failure (kept rows and all, for `AuthoredReadFailure`).
 * The provisional rows are presentation alone: anything that waits on or records a read waits on
 * `settled`, and nothing here is a `QueryResult` to hand on. */
export function useResolvedRefs(refs: readonly string[]) {
  const accountId = useAuthoredAccountId();
  // Sorted and distinct, the read keeps its key while only the order moves.
  const wanted = useMemo(() => [...new Set(refs)].sort(), [refs]);
  const read = useAuthoredQuery(wanted.length ? { kind: "resolve", refs: wanted } : null);
  const [last, setLast] = useState<{ accountId: string; data: QueryResult } | null>(null);
  const settled = wanted.length === 0 || read.data !== null || read.error !== null;
  if (read.data !== null && (last?.data !== read.data || last.accountId !== accountId)) setLast({ accountId, data: read.data });
  else if (read.data === null && settled && last !== null) setLast(null);
  const source = read.data ?? (!settled && last !== null && last.accountId === accountId ? last.data : null);
  const resources = useMemo(() => {
    const members = new Set(wanted);
    return new Map<string, Resolved>((source?.rows ?? []).flatMap(({ resource }) => members.has(resource.ref) ? [[resource.ref, resource]] : []));
  }, [source, wanted]);
  return { resources, settled, error: read.error, pending: read.pending, retry: read.retry };
}
