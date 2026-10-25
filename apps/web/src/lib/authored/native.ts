/** Native adapter uses the same shared semantic kernel. Kotlin admits only
 * closed SQL transactions and fixed foreground transport operations. */
import { bindingQueries } from "@nexus/authored/queries";
import { validateBindings } from "@nexus/authored/identity";
import { mergeChanges } from "@nexus/authored/merge";
import type { AuthoredStore, Change, FeedChange, ReplicaState, StateSelection, QueryResult, SyncStatus } from "@nexus/authored/types";
import { selectionFor } from "./persistence";
import { nativeQueryPlan } from "./nativeQuery";
import { Sync } from "./sync";
import { syncStatus } from "./status";
type Port = { postMessage(frame: string): void; onmessage: ((event: { data: string }) => void) | null };
let nextId = 0;
let installedPort: Port | null = null;
const hints = new Set<() => void>();
const foregroundListeners = new Set<(active: boolean) => void>();
let nativeForeground = false;
let foregroundRevision = BigInt(-1);
function receiveForeground(active: boolean, revision: string) {
  if (BigInt(revision) < foregroundRevision) return;
  foregroundRevision = BigInt(revision); nativeForeground = active;
  for (const listener of foregroundListeners) listener(active);
}
const pending = new Map<number, { resolve(value: Record<string, unknown>): void; reject(error: Error): void }>();
function nativePort(): Port {
  const port = (window as Window & { nexusAuthored?: Port }).nexusAuthored;
  if (!port) throw new Error("native authored storage unavailable");
  if (installedPort !== port) {
  installedPort = port;
  port.onmessage = ({ data }) => {
    const reply = JSON.parse(data);
    if (reply.kind === "authored_foreground") { receiveForeground(reply.active, reply.revision); return; }
    if (reply.kind === "authored_hint") { for (const wake of hints) wake(); return; }
    const waiting = pending.get(reply.id); pending.delete(reply.id);
    if (reply.ok) waiting?.resolve(reply.result);
    else waiting?.reject(Object.assign(new Error(reply.error.message), { status: reply.error.status, code: reply.error.code }));
  };
  }
  return port;
}
async function frame<T>(op: string, input: Record<string, unknown> = {}, signal?: AbortSignal, timeout = 30_000): Promise<T> {
  signal?.throwIfAborted();
  const id = ++nextId;
  const port = nativePort();
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); pending.delete(id); };
    const cancel = () => port.postMessage(JSON.stringify({ id: ++nextId, op: "cancel", target_id: id }));
    const abort = () => { cleanup(); cancel(); reject(signal?.reason ?? new DOMException("cancelled", "AbortError")); };
    const timer = setTimeout(() => { cleanup(); cancel(); reject(new Error("native authored operation did not acknowledge completion")); }, timeout);
    pending.set(id, { resolve: value => { cleanup(); resolve(value as T); }, reject: error => { cleanup(); reject(error); } });
    signal?.addEventListener("abort", abort, { once: true });
    port.postMessage(JSON.stringify({ id, op, ...input }));
  });
}
function base64(bytes: Uint8Array): string { return btoa(String.fromCharCode(...bytes)); }
function unbase64(value: string): Uint8Array { return Uint8Array.from(atob(value), char => char.charCodeAt(0)); }
async function call<T>(op: string, input: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
  const bytes = new TextEncoder().encode(JSON.stringify({ op, ...input }));
  const transfer_id = crypto.randomUUID();
  try {
  await frame("begin", { transfer_id, byte_count: bytes.byteLength }, signal);
  for (let offset = 0; offset < bytes.byteLength; offset += 24 * 1024) await frame("chunk", { transfer_id, offset, base64: base64(bytes.subarray(offset, offset + 24 * 1024)) }, signal);
  const { byte_count } = await frame<{ byte_count: number }>("invoke", { transfer_id }, signal, op === "snapshot" ? 300_000 : 30_000);
  const output = new Uint8Array(byte_count);
  for (let offset = 0; offset < byte_count;) {
    const chunk = await frame<{ base64: string; next_offset: number }>("read", { transfer_id, offset }, signal);
    const raw = unbase64(chunk.base64);
    if (chunk.next_offset !== offset + raw.byteLength || raw.byteLength === 0) throw new Error("invalid native authored result framing");
    output.set(raw, offset); offset = chunk.next_offset;
  }
  return JSON.parse(new TextDecoder().decode(output));
  } finally { if (signal?.aborted) void frame("discard_transfer", { transfer_id }).catch(reportError); }
}
export async function openNativeAuthoredStore(accountId: string): Promise<AuthoredStore> {
  const replica = await call<ReplicaState & { foreground: boolean; foreground_revision: string }>("hello");
  receiveForeground(replica.foreground, replica.foreground_revision);
  if (replica.account_id !== accountId) throw new Error("native authored account mismatch");
  let lease: string | null = null;
  let closed = false;
  let queue: Promise<unknown> = Promise.resolve();
  const serialize = <T,>(work: () => Promise<T>): Promise<T> => { const next = queue.then(work); queue = next.catch(() => undefined); return next; };
  const queries = new Set<() => void>();
  const closedWaiters = new Set<() => void>();
  const statuses = new Set<(status: SyncStatus, detail: string | null) => void>();
  const changed = () => { for (const listener of statuses) listener(syncStatus(sync.facts), sync.last_error); for (const listener of queries) listener(); };
  const queryLocal = async (query: Parameters<AuthoredStore["query"]>[0]): Promise<QueryResult> => call("query", { query, ...await nativeQueryPlan(query) });
  const changeStates = async (changes: Change[]) => {
    const selection: StateSelection = { refs: [], link_ids: [], anchor_ids: [], source_refs: [] };
    for (const change of changes) {
      const touched = selectionFor(change);
      for (const key of ["refs", "link_ids", "anchor_ids", "source_refs"] as const) selection[key].push(...touched[key]);
      for (const binding of bindingQueries(change)) {
        const known = await queryLocal(binding.query);
        if (known.binding_id !== null) selection[binding.selector].push(known.binding_id);
      }
    }
    for (const key of ["refs", "link_ids", "anchor_ids", "source_refs"] as const) selection[key] = [...new Set(selection[key])];
    return call<Parameters<typeof mergeChanges>[0]>("states", { selection });
  };
  const persistence = {
    replica: () => call<ReplicaState>("replica"),
    pending: async () => (await call<{ changes: Change[] }>("pending")).changes,
    acknowledge: async (sequence: string) => { await call("acknowledge", { sequence }); },
    applyRemote: async (entries: FeedChange[], nextCursor: string): Promise<ReplicaState> => {
      for (;;) {
        const current = await call<ReplicaState>("replica");
        if (BigInt(current.server_cursor) >= BigInt(nextCursor)) return current;
        const changes = entries.filter(entry => BigInt(entry.server_seq) > BigInt(current.server_cursor));
        const states = await changeStates(changes.map(entry => entry.change));
        await validateBindings(accountId, states, changes.map(entry => entry.change));
        const merged = mergeChanges(states, changes.map(entry => entry.change));
        const result = await call<ReplicaState | { kind: "stale" }>("apply_remote", { expected_store_revision: current.store_revision, changes, next_cursor: nextCursor, states: merged });
        if (!("kind" in result)) return result;
      }
    },
    resetProvisioning: async () => { await call("reset_provisioning"); },
    stage: async (states: Parameters<typeof mergeChanges>[0] & { projections: unknown[] }) => { await call("stage", { states }); },
    finishProvisioning: async (cursor: string, counts: Record<string, number>, lamport: string) => { await call("finish_provisioning", { cursor, counts, lamport }); },
  };
  const sync = new Sync(persistence, {
    json: <T,>(path: string, body: unknown | null, signal: AbortSignal): Promise<T> => path.includes("replicas") ? call<T>("register", { body }, signal) : body !== null ? call<T>("push", { body }, signal) : call<T>("pull", { after: new URL(path, location.origin).searchParams.get("after") }, signal),
    snapshot: async signal => {
      await call("snapshot", {}, signal);
      let offset = 0;
      return new ReadableStream<Uint8Array>({ pull: async controller => {
        const chunk = await frame<{ base64: string; next_offset: number; done: boolean }>("snapshot_chunk", { offset }, signal);
        controller.enqueue(unbase64(chunk.base64)); offset = chunk.next_offset;
        if (chunk.done) controller.close();
      }, cancel: async () => { await frame("snapshot_cancel"); } });
    },
  }, serialize, changed);
  sync.facts.ready = replica.provisioning_complete; sync.facts.cursor = replica.server_cursor; sync.facts.pending = (await persistence.pending()).length > 0;
  const wake = () => sync.wake();
  const foreground = () => sync.setForeground(nativeForeground && document.visibilityState === "visible");
  const nativeVisibility = (active: boolean) => sync.setForeground(active && document.visibilityState === "visible");
  foregroundListeners.add(nativeVisibility);
  hints.add(wake);
  window.addEventListener("online", wake); document.addEventListener("visibilitychange", foreground);
  sync.setForeground(nativeForeground && document.visibilityState === "visible");
  return {
    withCommand: async work => {
      if (closed) throw new Error("authored account closed");
      lease = (await call<{ lease: string }>("command_begin")).lease;
      try { return await work(); } finally { const token = lease; lease = null; await call("command_end", { lease: token }); }
    },
    whenUploaded: (commandSeq, signal) => new Promise<void>((resolve, reject) => {
      let done = false;
      const finish = (error: unknown | null) => { if (done) return; done = true; queries.delete(check); signal.removeEventListener("abort", aborted); closedWaiters.delete(aborted); if (error !== null) reject(error); else resolve(); };
      const aborted = () => finish(signal.reason ?? new DOMException("authored store closed", "AbortError"));
      const check = () => { void call<{ uploaded: boolean }>("uploaded", { command_seq: commandSeq }).then(result => {
        if (result.uploaded) finish(null);
        else {
          const status = syncStatus(sync.facts);
          if (["offline", "sign_in_required", "update_required", "sync_error", "local_error"].includes(status) || status === "preparing" && sync.last_error !== null) finish(new Error(sync.last_error ?? (status === "offline" ? "changes are saved on this device. connect to sync before continuing." : "changes are saved on this device but haven’t synced. retry syncing before continuing.")));
        }
      }, finish); };
      if (signal.aborted) { aborted(); return; }
      queries.add(check); closedWaiters.add(aborted); signal.addEventListener("abort", aborted, { once: true }); check();
    }),
    readSnapshot: selection => serialize(() => call("read_snapshot", { selection })),
    readReplica: () => serialize(persistence.replica),
    readStates: selection => serialize(() => call("states", { selection })),
    query: query => serialize(() => queryLocal(query)),
    commit: frame => serialize(async () => {
      sync.facts.saving = true; changed();
      try {
        const states = await changeStates([frame.change]);
        await validateBindings(accountId, states, [frame.change]);
        frame = { ...frame, states: mergeChanges(states, [frame.change]) };
        const result = await call<Awaited<ReturnType<AuthoredStore["commit"]>>>("commit", { frame, lease }); sync.localFailure(false); sync.facts.pending = true; sync.wake(); return result; }
      catch (error) { sync.localFailure(true); throw error; }
      finally { sync.facts.saving = false; changed(); }
    }),
    subscribe: (query, listener) => {
      let live = true;
      const read = () => { void serialize(() => queryLocal(query)).then(result => { if (live) listener(result); }, error => { if (live && sync.facts.ready) reportError(error); }); };
      queries.add(read); read(); return () => { live = false; queries.delete(read); };
    },
    sync_status: listener => { statuses.add(listener); listener(syncStatus(sync.facts), sync.last_error); return () => { statuses.delete(listener); }; },
    close: async () => {
      closed = true; sync.close();
      for (const cancel of closedWaiters) cancel(); closedWaiters.clear();
      queries.clear(); statuses.clear(); hints.delete(wake); foregroundListeners.delete(nativeVisibility);
      window.removeEventListener("online", wake); document.removeEventListener("visibilitychange", foreground);
      await sync.stopped(); await queue;
    },
  };
}
/** Shelf derives the provider identity from native authority, never its URL. */
export async function readNativeAuthoredAccount(): Promise<string> { return (await call<ReplicaState>("hello")).account_id; }
