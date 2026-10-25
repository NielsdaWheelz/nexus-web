/** Stable same-origin SharedWorker, named by account and format. Every SQL read,
 * local commit and incoming command passes one queue, across all browser tabs.
 * A window holds the account WebLock from preparation through exact settlement,
 * including failed-save retry. Begin and commit recheck its authoritative clientId
 * plus an ephemeral port lease; a delayed retired port cannot borrow a new holder.
 * An already admitted SQL commit finishes before the next queued preparation read.
 * This needs no cross-port ordering assumption or durable mutation ledger. */
import { FORMAT_REVISION, type CommitFrame, type AuthoredQuery, type StateSelection } from "@nexus/authored/types";
import { writingHints } from "./hints";
import { WIRE_REVISION } from "@/lib/api/wire.gen";
import { openDatabase } from "./sqlite";
import { Persistence } from "./persistence";
import { Sync } from "./sync";
import { syncStatus } from "./status";

interface WorkerScope { onconnect: ((event: MessageEvent) => void) | null; close(): void }
const scope = self as unknown as WorkerScope;
const ports = new Set<MessagePort>();
let persistence: Persistence | null = null;
let sync: Sync | null = null;
let hints: ReturnType<typeof writingHints> | null = null;
let account: string | null = null;
let retired = false;
let commandsPaused = false;
const deferred: (() => void)[] = [];
let preparation: { port: MessagePort; lease: string; holder: string } | null = null;
let queue: Promise<unknown> = Promise.resolve();
function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const next = queue.then(operation);
  queue = next.catch(() => undefined);
  return next;
}
function changed(corpusChanged = false) { for (const port of ports) port.postMessage({ kind: "changed", corpus_changed: corpusChanged, status: sync ? syncStatus(sync.facts) : "preparing", detail: sync?.last_error ?? null }); }
async function response(path: string, body: unknown | null, signal: AbortSignal) {
  let result: Response;
  const deadline = AbortSignal.timeout(path === "/api/authored/snapshot" ? 280_000 : 30_000);
  const requestSignal = AbortSignal.any([signal, deadline]);
  try { result = await fetch(path, { signal: requestSignal, method: body === null ? "GET" : "POST", credentials: "same-origin", cache: "no-store", headers: { "X-Nexus-Wire": String(WIRE_REVISION), "X-Nexus-Account": account!, ...(body === null ? {} : { "Content-Type": "application/json" }) }, body: body === null ? null : JSON.stringify(body) }); }
  catch (error) { throw Object.assign(new Error("authored network unavailable", { cause: error }), { status: deadline.aborted && !signal.aborted ? 504 : 0 }); }
  if (!result.ok) throw Object.assign(new Error(`authored request failed (${result.status})`), { status: result.status });
  return result;
}
async function operation(port: MessagePort, op: string, input: Record<string, unknown>) {
  if (op === "retire") {
    if (input.format_revision !== FORMAT_REVISION || typeof input.account_id !== "string" || account !== null && account !== input.account_id) throw new Error("authored retirement account or format mismatch");
    retired = true; sync?.close(); hints?.close();
    await persistence?.db.close();
    for (const current of ports) current.postMessage({ kind: "retired" });
    for (const current of ports) current.close();
    ports.clear(); scope.close(); return null;
  }
  if (op === "hello") {
    if (input.format_revision !== FORMAT_REVISION || typeof input.account_id !== "string") throw new Error("authored worker format mismatch");
    if (account !== null && account !== input.account_id) throw new Error("authored worker account mismatch");
    if (retired) throw new Error("authored account retired");
    if (!persistence) {
      account = input.account_id;
      persistence = new Persistence(await openDatabase(account));
      await persistence.initialize(account);
      sync = new Sync(persistence, {
        json: async <T>(path: string, body: unknown | null, signal: AbortSignal) => (await response(path, body, signal)).json() as Promise<T>,
        snapshot: async signal => { const result = await response("/api/authored/snapshot", null, signal); if (!result.body) throw new Error("authored snapshot stream missing"); return result.body; },
      }, serialize, changed);
      const state = await persistence.replica();
      sync.facts.ready = state.provisioning_complete;
      sync.facts.cursor = state.server_cursor;
      sync.facts.pending = (await persistence.pending()).length > 0;
      // Run after hello leaves the SQL queue.
      setTimeout(() => {
        sync?.wake();
        hints = writingHints(account!, () => sync?.wake()); hints.start();
      }, 0);
    }
    return { format_revision: FORMAT_REVISION, status: syncStatus(sync!.facts), detail: sync!.last_error };
  }
  if (!persistence || retired) throw new Error("authored account is closed");
  switch (op) {
    case "pause_commands": {
      commandsPaused = input.paused === true;
      if (!commandsPaused) { const waiting = deferred.splice(0); for (const resume of waiting) resume(); }
      return null;
    }
    case "command_begin": {
      const held = (await navigator.locks.query()).held?.find(lock => lock.name === `nexus-authored-command-${account}`);
      if (typeof input.holder !== "string" || held?.clientId !== input.holder) throw new Error("authored preparation owner has retired");
      const lease = crypto.randomUUID();
      preparation = { port, lease, holder: input.holder };
      return lease;
    }
    case "command_end": if (preparation?.port === port && preparation.lease === input.lease) preparation = null; return null;
    case "uploaded": {
      const state = await persistence.replica();
      if (BigInt(String(input.command_seq)) > BigInt(state.command_seq)) throw new Error("unknown authored source command");
      return (await persistence.db.all("SELECT command_seq FROM pending_changes WHERE command_seq=?", [BigInt(String(input.command_seq))])).length === 0;
    }
    case "read_snapshot": return persistence.readSnapshot(input.selection as unknown as StateSelection);
    case "replica": return persistence.replica();
    case "states": return persistence.states(input.selection as unknown as StateSelection);
    case "query": {
      if (!(await persistence.replica()).provisioning_complete) throw new Error("authored corpus is still preparing");
      return persistence.query(input.query as unknown as AuthoredQuery);
    }
    case "commit": {
      const held = (await navigator.locks.query()).held?.find(lock => lock.name === `nexus-authored-command-${account}`);
      if (preparation?.port !== port || preparation.lease !== input.lease || held?.clientId !== preparation.holder) throw new Error("authored preparation retired before local commit");
      if (!(await persistence.replica()).provisioning_complete) throw new Error("authored corpus is still preparing");
      sync!.facts.saving = true; changed();
      try {
        const result = await persistence.commit(input.frame as unknown as CommitFrame);
        if (result.kind === "committed") changed(true);
        sync!.localFailure(false);
        sync!.facts.pending = (await persistence.pending()).length > 0;
        setTimeout(() => sync?.wake(), 0);
        return result;
      } catch (error) { sync!.localFailure(true); throw error; }
      finally { sync!.facts.saving = false; changed(); }
    }
    case "wake": sync!.facts.online = input.online !== false; sync!.wake(); hints?.start(); return null;
    case "close": ports.delete(port); port.close(); return null;
    default: throw new Error("unknown authored operation");
  }
}
scope.onconnect = event => {
  const port = event.ports[0];
  ports.add(port);
  port.onmessage = ({ data }) => {
    if (!data || typeof data.id !== "number" || typeof data.op !== "string") return;
    const submit = () => {
      void serialize(async () => {
        if (commandsPaused && (data.op === "command_begin" || data.op === "commit")) { deferred.push(submit); return; }
        try {
          const result = await operation(port, data.op, data);
          if (data.op !== "close" && data.op !== "retire") port.postMessage({ id: data.id, ok: true, result });
        } catch (error) { port.postMessage({ id: data.id, ok: false, error: error instanceof Error ? error.message : "authored operation failed" }); }
      });
    };
    submit();
  };
  port.start();
};
