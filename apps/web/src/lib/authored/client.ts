"use client";
/** A tab owns only a port. The stable worker owns database/replication; closing a
 * tab never retires an account or discards its committed pending changes. */
import { openNativeAuthoredStore } from "./native";
import { FORMAT_REVISION, type AuthoredStore, type QueryResult, type SyncStatus } from "@nexus/authored/types";

const retiredAccounts = new Set<string>();
export function admitAuthoredAccount(accountId: string): void { retiredAccounts.delete(accountId); }
const accounts = new Map<string, { promise: Promise<AuthoredStore>; users: number; closing: Promise<void> | null }>();
export async function openAuthoredStore(accountId: string): Promise<AuthoredStore> {
  if (retiredAccounts.has(accountId)) throw new Error("authored account has been retired on this device");
  let owner = accounts.get(accountId);
  if (owner?.closing) { await owner.closing; return openAuthoredStore(accountId); }
  if (!owner) {
    owner = { promise: openStore(accountId), users: 0, closing: null };
    accounts.set(accountId, owner);
    const current = owner;
    void owner.promise.catch(() => { if (accounts.get(accountId) === current) accounts.delete(accountId); });
  }
  owner.users++;
  let store: AuthoredStore;
  try { store = await owner.promise; }
  catch (error) { owner.users--; throw error; }
  const current = owner;
  let released = false;
  return { ...store, close: async () => {
    if (released) return;
    released = true; current.users--;
    if (current.users === 0 && accounts.get(accountId) === current) {
      current.closing = store.close();
      try { await current.closing; } finally { if (accounts.get(accountId) === current) accounts.delete(accountId); }
    }
  } };
}
async function openStore(accountId: string): Promise<AuthoredStore> {
  if ("nexusAuthored" in window) return openNativeAuthoredStore(accountId);
  if (!navigator.storage?.persist || !await navigator.storage.persist()) throw new Error("persistent storage is required to make your notes available offline. allow persistent storage for nexus, then retry.");
  if (typeof SharedWorker === "undefined") throw new Error("this browser cannot open the shared authored store");
  const worker = new SharedWorker("/_nexus/authored/worker.js", { type: "module", name: `nexus-authored-${accountId}-format-${FORMAT_REVISION}` });
  const port = worker.port;
  let sequence = 0;
  let closed = false;
  let commandLease: string | null = null;
  let detail: string | null = null;
  let status: SyncStatus = "preparing";
  const waiting = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  const queries = new Set<() => void>();
  const statuses = new Set<(status: SyncStatus, detail: string | null) => void>();
  function call<T>(op: string, input: Record<string, unknown> = {}): Promise<T> {
    if (closed) return Promise.reject(new Error("authored store closed"));
    const id = ++sequence;
    return new Promise<T>((resolve, reject) => {
      waiting.set(id, { resolve: value => resolve(value as T), reject });
      port.postMessage({ id, op, ...input });
    });
  }
  port.onmessage = ({ data }) => {
    if (data.kind === "changed") {
      status = data.status; detail = data.detail ?? null;
      for (const listener of statuses) listener(status, detail);
      for (const query of queries) query();
    } else if (data.kind === "retired") {
      window.removeEventListener("online", wake); window.removeEventListener("offline", wake); document.removeEventListener("visibilitychange", foreground);
      queries.clear(); statuses.clear();
      retiredAccounts.add(accountId);
      accounts.delete(accountId);
      window.dispatchEvent(new Event("nexus:authored-retired"));
      closed = true;
      for (const pending of waiting.values()) pending.reject(new Error("authored account retired"));
      waiting.clear(); port.close();
    } else {
      const pending = waiting.get(data.id);
      waiting.delete(data.id);
      if (data.ok) pending?.resolve(data.result);
      else pending?.reject(new Error(data.error));
    }
  };
  worker.onerror = () => {
    status = "local_error";
    for (const listener of statuses) listener(status, detail);
    for (const pending of waiting.values()) pending.reject(new Error("authored worker could not open. keep this page open. retry saving."));
    waiting.clear();
  };
  port.start();
  const hello = await call<{ status: SyncStatus; detail: string | null }>("hello", { account_id: accountId, format_revision: FORMAT_REVISION });
  status = hello.status; detail = hello.detail;
  function wake() { void call("wake", { online: navigator.onLine }).catch(reportError); }
  function foreground() { if (document.visibilityState === "visible") wake(); }
  window.addEventListener("online", wake);
  window.addEventListener("offline", wake);
  document.addEventListener("visibilitychange", foreground);
  wake();
  return {
    withCommand: work => navigator.locks.request(`nexus-authored-command-${accountId}`, async () => {
      if (closed) throw new Error("authored store closed");
      const locks = await navigator.locks.query();
      const holder = locks.held?.find(lock => lock.name === `nexus-authored-command-${accountId}`)?.clientId;
      if (!holder) throw new Error("this browser does not expose shared command ownership");
      commandLease = await call<string>("command_begin", { holder });
      try { return await work(); }
      finally { const lease = commandLease; commandLease = null; await call("command_end", { lease }); }
    }),
    whenUploaded: (commandSeq, signal) => new Promise<void>((resolve, reject) => {
      let done = false;
      const finish = (error: unknown | null) => { if (done) return; done = true; queries.delete(check); signal.removeEventListener("abort", aborted); if (error !== null) reject(error); else resolve(); };
      const aborted = () => finish(signal.reason ?? new DOMException("cancelled", "AbortError"));
      const check = () => { void call<boolean>("uploaded", { command_seq: commandSeq }).then(uploaded => { if (uploaded) finish(null); }, finish); };
      if (signal.aborted) { aborted(); return; }
      queries.add(check); signal.addEventListener("abort", aborted, { once: true }); check();
    }),
    readReplica: () => call("replica"),
    readStates: selection => call("states", { selection }),
    query: query => call("query", { query }),
    commit: frame => call("commit", { frame, lease: commandLease }),
    subscribe: (query, listener) => {
      let active = true;
      let generation = 0;
      const read = () => { const current = ++generation; void call<QueryResult>("query", { query }).then(result => { if (active && generation === current) listener(result); }, error => { if (active && status !== "preparing") reportError(error); }); };
      queries.add(read); read();
      return () => { active = false; queries.delete(read); };
    },
    sync_status: listener => { statuses.add(listener); listener(status, detail); return () => { statuses.delete(listener); }; },
    close: async () => {
      if (closed) return;
      window.removeEventListener("online", wake); window.removeEventListener("offline", wake); document.removeEventListener("visibilitychange", foreground);
      port.postMessage({ id: ++sequence, op: "close" });
      closed = true;
      for (const pending of waiting.values()) pending.reject(new Error("authored store closed"));
      waiting.clear(); queries.clear(); statuses.clear(); port.close();
    },
  };
}
