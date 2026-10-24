"use client";

/** Installed catalog memory and refresh owner. Native owns durable publication;
 * this owner binds one account, replaces whole indexes and retires late file reads.
 * Remote writes never await this work. No catalog state enters browser storage. */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from "react";
import { ApiError, isApiError, WIRE_HEADER } from "@/lib/api/client";
import { useChangeStamp } from "@/lib/api/changes";
import { WIRE_REVISION } from "@/lib/api/wire.gen";
import { isAbortError } from "@/lib/errors";
import { remoteReady } from "@/lib/native/admission";
import { useRemoteAdmission } from "@/lib/native/admissionHooks";
import { readCatalogStatus, refreshCatalog, subscribeCatalogStatus } from "@/lib/native/client";
import type { CatalogStatus } from "@/lib/native/contracts";
import { isRecord } from "@/lib/validation";
import { indexCatalog, type CatalogIndex, type OfflineCatalog } from "./selectors";
import type { CatalogRead } from "./types";

interface State { readonly data: CatalogIndex | null; readonly loading: boolean; readonly status: CatalogStatus | null; readonly error: ApiError | null; readonly completed: number; readonly accepting: boolean }
function createOwner(accountId: string) {
  let state: State = { data: null, loading: true, status: null, error: null, completed: 0, accepting: false };
  const listeners = new Set<() => void>();
  let epoch = 0;
  let file: { controller: AbortController; promise: Promise<void> } | null = null;
  let initial: Promise<void> | null = null;
  let unsubscribe: (() => void) | null = null;
  let pushes = 0;
  let stopped = false;
  let lifetime = 0;
  let acceptance: Promise<void> | null = null;
  const publish = (next: State) => { state = next; for (const listener of listeners) listener(); };
  function readFile(): Promise<void> {
    file?.controller.abort();
    const controller = new AbortController();
    const generation = ++epoch;
    const promise = (async () => {
      try {
        const response = await fetch("/_nexus/device/catalog.json", { cache: "no-store", signal: controller.signal, headers: { [WIRE_HEADER]: String(WIRE_REVISION) } });
        if (!response.ok && response.status !== 204) {
          const body: unknown = await response.json();
          const error = isRecord(body) && isRecord(body.error) ? body.error : null;
          throw new ApiError(response.status, typeof error?.code === "string" ? error.code : "E_CATALOG_IO", typeof error?.message === "string" ? error.message : "saved catalog couldn’t be opened");
        }
        const envelope: { data: OfflineCatalog } | null = response.status === 204 ? null : await response.json();
        if (controller.signal.aborted || generation !== epoch || stopped) return;
        if (envelope !== null && (envelope.data.account_id !== accountId || envelope.data.wire_revision !== WIRE_REVISION || envelope.data.format_version !== 1))
          throw new ApiError(0, "E_CATALOG_INCOMPATIBLE", "saved catalog needs an online rebuild");
        const data = envelope === null ? null : indexCatalog(envelope.data);
        publish({ ...state, data, loading: false, error: null });
      } catch (error) {
        if (controller.signal.aborted || generation !== epoch || stopped || isAbortError(error)) return;
        publish({ ...state, data: null, loading: false, error: isApiError(error) ? error : new ApiError(0, "E_CATALOG_INVALID", "saved catalog couldn’t be opened") });
      } finally { if (file?.controller === controller) file = null; }
    })();
    file = { controller, promise };
    return promise;
  }
  function adoptStatus(status: CatalogStatus) {
    if (stopped) return;
    const previous = state.status?.snapshot?.snapshot_id ?? state.data?.value.snapshot_id ?? null;
    publish({ ...state, status, error: state.data !== null ? null : state.error, completed: state.completed + (state.status?.refreshing && !status.refreshing ? 1 : 0) });
    if ((status.snapshot?.snapshot_id ?? null) !== previous) void readFile();
  }
  function start() {
    if (unsubscribe !== null) return;
    stopped = false;
    const started = ++lifetime;
    unsubscribe = subscribeCatalogStatus(status => { pushes += 1; adoptStatus(status); });
    initial = readFile();
    void initial.then(() => {
      if (stopped || started !== lifetime) return;
      const before = pushes;
      void readCatalogStatus().then(status => { if (started === lifetime && before === pushes) adoptStatus(status); }, error => {
        if (!stopped && started === lifetime && before === pushes) publish({ ...state, error: isApiError(error) ? error : new ApiError(0, "E_CATALOG_IO", "catalog status couldn’t be read") });
      });
    });
  }
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    get: () => state,
    start,
    stop() { stopped = true; lifetime += 1; epoch += 1; file?.controller.abort(); file = null; initial = null; acceptance = null; state = { ...state, accepting: false }; unsubscribe?.(); unsubscribe = null; },
    async load(signal: AbortSignal) {
      start();
      await initial;
      while (file !== null) { signal.throwIfAborted(); await file.promise; }
      signal.throwIfAborted();
      if (state.error !== null && state.data === null) throw state.error;
      return state.data;
    },
    refresh(): Promise<void> {
      if (stopped || !remoteReady() || document.visibilityState === "hidden") return Promise.resolve();
      if (acceptance !== null) return acceptance;
      const before = pushes;
      const started = lifetime;
      const completed = state.completed;
      publish({ ...state, accepting: true });
      const request = (async () => {
        try { const status = await refreshCatalog(); if (started === lifetime && before === pushes) adoptStatus(status); }
        catch (error) { if (!stopped && started === lifetime && before === pushes) publish({ ...state, error: isApiError(error) ? error : new ApiError(0, "E_CATALOG_IO", "catalog couldn’t be updated") }); }
        finally {
          if (started === lifetime) acceptance = null;
          if (!stopped && started === lifetime) publish({ ...state, accepting: false,
            completed: state.completed + (state.completed === completed && !state.status?.refreshing ? 1 : 0) });
        }
      })();
      acceptance = request;
      return request;
    },
  };
}
type Owner = ReturnType<typeof createOwner>;
const Context = createContext<Owner | null>(null);

export function CatalogProvider({ accountId, children }: { readonly accountId: string; readonly children: ReactNode }) {
  const owner = useMemo(() => createOwner(accountId), [accountId]);
  const admission = useRemoteAdmission();
  const changes = useChangeStamp("Libraries", "Entries", "Metadata", "Podcasts", "PodcastEpisodes", "Lectern", "Notes", "Chats");
  const state = useSyncExternalStore(owner.subscribe, owner.get, owner.get);
  const pending = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastChanges = useRef(changes);
  useEffect(() => { owner.start(); return () => owner.stop(); }, [owner]);
  const refresh = useCallback((change = false) => {
    if (!remoteReady() || document.visibilityState === "hidden") return;
    if (owner.get().accepting || owner.get().status?.refreshing) { if (change) pending.current = true; return; }
    void owner.refresh();
  }, [owner]);
  useEffect(() => {
    if (admission === "Ready") refresh();
  }, [admission, refresh]);
  useEffect(() => {
    const foreground = () => { if (document.visibilityState === "visible") refresh(); };
    document.addEventListener("visibilitychange", foreground);
    window.addEventListener("online", foreground);
    return () => { document.removeEventListener("visibilitychange", foreground); window.removeEventListener("online", foreground); };
  }, [refresh]);
  useEffect(() => {
    if (changes === lastChanges.current) return;
    lastChanges.current = changes;
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => { timer.current = null; refresh(true); }, 30_000);
    return () => { if (timer.current !== null) clearTimeout(timer.current); };
  }, [changes, refresh]);
  const completed = useRef(state.completed);
  useEffect(() => {
    if (state.accepting || completed.current === state.completed) return;
    completed.current = state.completed;
    const queued = pending.current;
    pending.current = false;
    if (queued && state.status?.last_error === null && state.error === null) refresh();
  }, [state.accepting, state.completed, state.status, state.error, refresh]);
  return <Context value={owner}>{children}</Context>;
}

export function useCatalogState() {
  const owner = useContext(Context);
  const empty = useMemo<State>(() => ({ data: null, loading: false, status: null, error: null, completed: 0, accepting: false }), []);
  const state = useSyncExternalStore(owner?.subscribe ?? (() => () => {}), owner?.get ?? (() => empty), () => empty);
  return { ...state, refresh: owner?.refresh ?? (async () => {}) };
}

export function useCatalogRead<T>(selector: (catalog: CatalogIndex) => T | null): CatalogRead<T> | undefined {
  const owner = useContext(Context);
  const state = useCatalogState();
  const selection = useRef(selector);
  selection.current = selector;
  return useMemo<CatalogRead<T> | undefined>(() => owner === null ? undefined : {
    snapshot_id: state.data?.value.snapshot_id ?? null,
    async load(signal: AbortSignal) {
      const data = await owner.load(signal);
      if (data === null) return null;
      const selected = selection.current(data);
      if (selected === null) throw new ApiError(0, "E_CATALOG_COVERAGE", "not in the saved catalog");
      return { data: selected, source: { kind: "catalog", snapshot_id: data.value.snapshot_id, captured_at: data.value.captured_at } };
    },
  }, [owner, state.data]);
}
