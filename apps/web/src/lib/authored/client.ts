"use client";
/** One signed document shares one cached port per account; replacement waits for
 * its previous owner to close. The worker owns SQL and replication. withCommand
 * holds the account WebLock through preparation, uncertain commit and exact retry;
 * the worker independently fences its clientId and ephemeral lease. Closing a tab
 * never retires the account or discards committed pending changes. */
import { prepareShell } from "./shell";
import { openNativeAuthoredStore } from "./native";
import { FORMAT_REVISION, type AuthoredStore, type QueryResult, type SyncStatus } from "@nexus/authored/types";

const retiredAccounts = new Set<string>();
export function admitAuthoredAccount(accountId: string): void { retiredAccounts.delete(accountId); }
export function retireAuthoredAccount(accountId: string): void {
  retiredAccounts.add(accountId); accounts.delete(accountId);
  window.dispatchEvent(new Event("nexus:authored-retired"));
}
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
  await prepareShell();
  if (retiredAccounts.has(accountId)) throw new Error("authored account retired before opening storage");
  if (typeof SharedWorker === "undefined") throw new Error("this browser cannot open the shared authored store");
  const worker = new SharedWorker("/_nexus/authored/worker.js", { type: "module", name: `nexus-authored-${accountId}-format-${FORMAT_REVISION}` });
  const port = worker.port;
  let sequence = 0;
  let closed = false;
  let terminalFailure: Error | null = null;
  let unresponsive = 0;
  let commandLease: string | null = null;
  let detail: string | null = null;
  let status: SyncStatus = "preparing";
  const waiting = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  const queries = new Set<(corpusChanged?: boolean) => void>();
  const annotations = new Set<() => void>();
  const closedWaiters = new Set<() => void>();
  const statuses = new Set<(status: SyncStatus, detail: string | null) => void>();
  function failPort(message: string) {
    terminalFailure = Object.assign(new Error(message), { code: "E_AUTHORED_WORKER_STOPPED" });
    detail = terminalFailure.message; status = "local_error";
    for (const listener of statuses) listener(status, detail);
    for (const pending of waiting.values()) pending.reject(terminalFailure);
    waiting.clear();
  }
  function call<T>(op: string, input: Record<string, unknown> = {}): Promise<T> {
    if (closed) return Promise.reject(new Error("authored store closed"));
    if (terminalFailure !== null) return Promise.reject(terminalFailure);
    const id = ++sequence;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(id); unresponsive++;
        if (unresponsive >= 2) failPort("the local notes store isn’t responding. keep this page open and copy unfinished writing before restarting nexus.");
        reject(terminalFailure ?? new Error("local notes did not acknowledge completion. keep this page open and retry saving."));
      }, 30_000);
      waiting.set(id, { resolve: value => { clearTimeout(timer); unresponsive = 0; resolve(value as T); }, reject: error => { clearTimeout(timer); reject(error); } });
      port.postMessage({ id, op, ...input });
    });
  }
  port.onmessage = ({ data }) => {
    if (data.kind === "changed") {
      if (terminalFailure !== null) return;
      status = data.status; detail = data.detail ?? null;
      for (const listener of statuses) listener(status, detail);
      for (const query of queries) query(data.corpus_changed === true);
    } else if (data.kind === "annotations_changed") {
      if (terminalFailure === null) for (const listener of annotations) listener();
    } else if (data.kind === "retired") {
      window.removeEventListener("online", wake); window.removeEventListener("offline", wake); document.removeEventListener("visibilitychange", foreground);
      for (const cancel of closedWaiters) cancel(); closedWaiters.clear();
      queries.clear(); statuses.clear(); annotations.clear();
      retireAuthoredAccount(accountId);
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
  worker.onerror = () => failPort("the local notes store stopped. keep this page open and copy unfinished writing before restarting nexus.");
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
      const finish = (error: unknown | null) => { if (done) return; done = true; queries.delete(check); signal.removeEventListener("abort", aborted); closedWaiters.delete(aborted); if (error !== null) reject(error); else resolve(); };
      const aborted = () => finish(signal.reason ?? new DOMException("authored store closed", "AbortError"));
      const check = () => { void call<boolean>("uploaded", { command_seq: commandSeq }).then(uploaded => {
        if (uploaded) finish(null);
        else if (["offline", "sign_in_required", "update_required", "sync_error", "local_error"].includes(status) || status === "preparing" && detail !== null) finish(new Error(detail ?? (status === "offline" ? "changes are saved on this device. connect to sync before continuing." : "changes are saved on this device but haven’t synced. retry syncing before continuing.")));
      }, finish); };
      if (signal.aborted) { aborted(); return; }
      queries.add(check); closedWaiters.add(aborted); signal.addEventListener("abort", aborted, { once: true }); check();
    }),
    readSnapshot: selection => call("read_snapshot", { selection }),
    readReplica: () => call("replica"),
    readStates: selection => call("states", { selection }),
    query: query => call("query", { query }),
    commit: frame => call("commit", { frame, lease: commandLease }),
    subscribe: (query, listener) => {
      let active = true;
      let generation = 0;
      const read = (corpusChanged = true) => { if (!corpusChanged) return; const current = ++generation; void call<QueryResult>("query", { query }).then(result => { if (active && generation === current) listener(result); }, error => { if (active && status !== "preparing") reportError(error); }); };
      queries.add(read); read();
      return () => { active = false; queries.delete(read); };
    },
    annotations_changed: listener => { annotations.add(listener); return () => { annotations.delete(listener); }; },
    sync_status: listener => { statuses.add(listener); listener(status, detail); return () => { statuses.delete(listener); }; },
    close: async () => {
      if (closed) return;
      window.removeEventListener("online", wake); window.removeEventListener("offline", wake); document.removeEventListener("visibilitychange", foreground);
      port.postMessage({ id: ++sequence, op: "close" });
      closed = true;
      for (const pending of waiting.values()) pending.reject(new Error("authored store closed"));
      waiting.clear(); for (const cancel of closedWaiters) cancel(); closedWaiters.clear(); queries.clear(); statuses.clear(); annotations.clear(); port.close();
    },
  };
}
