"use client";
/** One signed document shares one cached port per account; replacement waits for
 * its previous owner to close. The worker owns SQL and replication. withCommand
 * holds the account WebLock through preparation, uncertain commit and exact retry;
 * the worker independently fences its clientId and ephemeral lease. Closing a tab
 * never retires the account or discards committed pending changes. */
import { observeShellWaiting, observeWorkerUpdate, observeRemoteFailure } from "@/lib/native/admission";
import { ApiError } from "@/lib/api/client";
import { WIRE_REVISION } from "@/lib/api/wire.gen";
import { observeShellUpdate, prepareShell } from "./shell";
import { openNativeAuthoredStore } from "./native";
import { uploadStall } from "./status";
import { scheduleReplication } from "./schedule";
import type { SyncStep } from "./sync";
import { FORMAT_REVISION, type AuthoredStore, type QueryResult, type SyncFailure, type SyncStatus } from "@nexus/authored/types";

/** Existing host admission refusals are recoverable setup conditions. */
export class AuthoredSetupError extends Error {
  constructor(readonly reason: "Persistence" | "SharedWorker" | "PendingUpgrade") { super("authored setup unavailable"); }
}
const retiredAccounts = new Set<string>();
export function admitAuthoredAccount(accountId: string): void { retiredAccounts.delete(accountId); }
export function retireAuthoredAccount(accountId: string): void {
  retiredAccounts.add(accountId); accounts.delete(accountId);
  window.dispatchEvent(new Event("nexus:authored-retired"));
}
const accounts = new Map<string, { promise: Promise<AuthoredStore>; users: number; closing: Promise<void> | null }>();
const stoppedAccounts = new Set<string>();
/** Whether the account's store in this document has stopped: nothing it holds can commit until
 * nexus restarts. Read it beside the `sync_status` change that announces the stop. */
export const authoredStoreStopped = (accountId: string) => stoppedAccounts.has(accountId);
export async function openAuthoredStore(accountId: string): Promise<AuthoredStore> {
  if (retiredAccounts.has(accountId)) throw new Error("authored account has been retired on this device");
  let owner = accounts.get(accountId);
  if (owner?.closing) { await owner.closing; return openAuthoredStore(accountId); }
  if (!owner) {
    owner = { promise: openStore(accountId).then(store => { store.sync_status(observeSyncUpdate); return store; }), users: 0, closing: null };
    accounts.set(accountId, owner);
    const current = owner;
    void owner.promise.catch(() => { if (accounts.get(accountId) === current) accounts.delete(accountId); });
  }
  owner.users++;
  let store: AuthoredStore;
  try { store = await owner.promise; }
  catch (error) {
    owner.users--;
    if (error instanceof Error && "code" in error && error.code === "E_AUTHORED_UPGRADE_PENDING") throw new AuthoredSetupError("PendingUpgrade");
    throw error;
  }
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
/** A 426 the sync transport met is this document's update state too. It never reloads:
 * a reload cannot replace a shared worker another tab holds. */
function observeSyncUpdate(status: SyncStatus) { if (status === "update_required") observeWorkerUpdate(); else if (status === "sign_in_required") observeRemoteFailure(401); }
let shellObserved = false;
async function openStore(accountId: string): Promise<AuthoredStore> {
  if ("nexusAuthored" in window) return openNativeAuthoredStore(accountId);
  stoppedAccounts.delete(accountId);
  if (!navigator.storage?.persist || !await navigator.storage.persist()) throw new AuthoredSetupError("Persistence");
  await prepareShell();
  if (!shellObserved) { shellObserved = true; observeShellUpdate(observeShellWaiting); }
  if (retiredAccounts.has(accountId)) throw new Error("authored account retired before opening storage");
  if (typeof SharedWorker === "undefined") throw new AuthoredSetupError("SharedWorker");
  const worker = new SharedWorker("/_nexus/authored/worker.js", { type: "module", name: `nexus-authored-${accountId}-format-${FORMAT_REVISION}` });
  const port = worker.port;
  let sequence = 0;
  let closed = false;
  let terminalFailure: Error | null = null;
  let unresponsive = 0;
  let commandLease: string | null = null;
  let detail: string | null = null;
  let status: SyncStatus = "preparing";
  let failure: SyncFailure = null;
  let replication: ReturnType<typeof scheduleReplication> | null = null;
  const waiting = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  const queries = new Set<(corpusChanged: boolean, dailyIndexChanged: boolean) => void>();
  const evidence = new Set<() => void>();
  const closedWaiters = new Set<() => void>();
  const statuses = new Set<(status: SyncStatus, detail: string | null, failure: SyncFailure) => void>();
  function failPort(message: string) {
    terminalFailure = Object.assign(new Error(message), { code: "E_AUTHORED_WORKER_STOPPED" });
    stoppedAccounts.add(accountId);
    detail = terminalFailure.message; status = "local_error";
    for (const listener of statuses) listener(status, detail, failure);
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
        reject(terminalFailure ?? Object.assign(new Error("local notes did not acknowledge completion. keep this page open and retry saving."), {code: "E_AUTHORED_LOCAL"}));
      }, op === "sync_step" ? 300_000 : 30_000);
      waiting.set(id, { resolve: value => { clearTimeout(timer); unresponsive = 0; resolve(value as T); }, reject: error => { clearTimeout(timer); reject(error); } });
      port.postMessage({ id, op, ...input });
    });
  }
  port.onmessage = ({ data }) => {
    if (data.kind === "changed") {
      if (terminalFailure !== null) return;
      status = data.status; detail = data.detail ?? null; failure = data.failure;
      for (const listener of statuses) listener(status, detail, failure);
      for (const query of queries) query(data.corpus_changed, data.daily_index_changed);
    } else if (data.kind === "evidence_changed") {
      if (terminalFailure === null) for (const listener of evidence) listener();
    } else if (data.kind === "retired") {
      replication?.close();
      for (const cancel of closedWaiters) cancel(); closedWaiters.clear();
      queries.clear(); statuses.clear(); evidence.clear();
      retireAuthoredAccount(accountId);
      closed = true;
      for (const pending of waiting.values()) pending.reject(new Error("authored account retired"));
      waiting.clear(); port.close();
    } else {
      const pending = waiting.get(data.id);
      waiting.delete(data.id);
      if (data.ok) pending?.resolve(data.result);
      else pending?.reject(typeof data.status === "number" ? new ApiError(data.status, data.code, data.error) : Object.assign(new Error(data.error), {code: data.code}));
    }
  };
  worker.onerror = () => failPort("the local notes store stopped. keep this page open and copy unfinished writing before restarting nexus.");
  port.start();
  let hello: { wire_revision: number; format_revision: number; status: SyncStatus; detail: string | null; failure: SyncFailure };
  try {
    hello = await call<typeof hello>("hello", { account_id: accountId, format_revision: FORMAT_REVISION, wire_revision: WIRE_REVISION });
    if (hello.wire_revision !== WIRE_REVISION || hello.format_revision !== FORMAT_REVISION) throw new ApiError(426, "E_WIRE_MISMATCH", "close all nexus tabs to update local writing");
  } catch (error) {
    port.postMessage({ id: ++sequence, op: "close" }); port.close();
    if (error instanceof ApiError && error.status === 426) observeWorkerUpdate();
    throw error;
  }
  status = hello.status; detail = hello.detail; failure = hello.failure;
  replication = scheduleReplication(refresh => call<SyncStep>("sync_step", { refresh, online: navigator.onLine }), () => failPort("the local notes store stopped responding. keep this page open and copy unfinished writing before restarting nexus."));
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
        if (uploaded) { finish(null); return; }
        const stall = uploadStall({ status, detail, failure }, Date.now());
        if (stall !== null) finish(stall);
      }, finish); };
      if (signal.aborted) { aborted(); return; }
      queries.add(check); closedWaiters.add(aborted); signal.addEventListener("abort", aborted, { once: true }); check();
    }),
    readSnapshot: selection => call("read_snapshot", { selection }),
    readReplica: () => call("replica"),
    readStates: selection => call("states", { selection }),
    query: query => call("query", { query }),
    commit: async frame => { const result = await call<Awaited<ReturnType<AuthoredStore["commit"]>>>("commit", { frame, lease: commandLease }); if (result.kind === "committed") replication?.wake(); return result; },
    subscribe: (query, listener, failed) => {
      let active = true;
      let generation = 0;
      const read = (corpusChanged: boolean, dailyIndexChanged: boolean) => { if (!(query.kind === "daily_index" ? dailyIndexChanged : corpusChanged)) return; const current = ++generation; void call<QueryResult>("query", { query }).then(value => { if (active && generation === current) listener(value); }, error => { if (active && generation === current) failed(error); }); };
      queries.add(read); read(true, true);
      return () => { active = false; queries.delete(read); };
    },
    evidence_changed: listener => { evidence.add(listener); return () => { evidence.delete(listener); }; },
    sync_status: listener => { statuses.add(listener); listener(status, detail, failure); return () => { statuses.delete(listener); }; },
    close: async () => {
      if (closed) return;
      replication?.close();
      port.postMessage({ id: ++sequence, op: "close" });
      closed = true;
      for (const pending of waiting.values()) pending.reject(new Error("authored store closed"));
      waiting.clear(); for (const cancel of closedWaiters) cancel(); closedWaiters.clear(); queries.clear(); statuses.clear(); evidence.clear(); port.close();
    },
  };
}
