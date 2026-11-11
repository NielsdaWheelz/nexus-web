/** Stable same-origin SharedWorker, named by account and format. Every SQL read,
 * local commit and incoming command passes one queue, across all browser tabs.
 * A window holds the account WebLock from preparation through exact settlement,
 * including failed-save retry. Begin and commit recheck its authoritative clientId
 * plus an ephemeral port lease; a delayed retired port cannot borrow a new holder.
 * An already admitted SQL commit finishes before the next queued preparation read.
 * This needs no cross-port ordering assumption or durable mutation ledger. */
import { changesDailyIndex } from "@nexus/authored/queries";
import { FORMAT_REVISION, type CommitFrame, type AuthoredQuery, type StateSelection } from "@nexus/authored/types";
import { ApiError, readResponse } from "@/lib/api/client";
import { WIRE_REVISION } from "@/lib/api/wire.gen";
import { isAbortError } from "@/lib/errors";
import { openDatabase } from "./sqlite";
import { Persistence } from "./persistence";
import { Sync } from "./sync";
import { syncStatus } from "./status";

interface WorkerScope { onconnect: ((event: MessageEvent) => void) | null; close(): void }
const scope = self as unknown as WorkerScope;
const ports = new Set<MessagePort>();
let persistence: Persistence | null = null;
let sync: Sync | null = null;
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
function changed(corpusChanged = false, dailyIndexChanged = false) { for (const port of ports) port.postMessage({ kind: "changed", corpus_changed: corpusChanged, daily_index_changed: dailyIndexChanged, status: sync ? syncStatus(sync.facts) : "preparing", detail: sync?.detail ?? null, failure: sync?.facts.failure ?? null }); }
/** `readResponse` takes any abort for its caller's, and here the caller may not have aborted:
 * Firefox rejects `text()` with AbortError when `response`'s deadline passes mid-body. That is
 * a body that died, as it is in Chromium, so it reads as one. */
async function answer<T>(result: Response, signal: AbortSignal): Promise<T> {
  try { return await readResponse<T>(result); }
  catch (error) { throw isAbortError(error) && !signal.aborted ? new ApiError(0, "E_NETWORK", "authored body interrupted") : error; }
}
async function response(path: string, body: unknown | null, signal: AbortSignal) {
  let result: Response;
  const deadline = AbortSignal.timeout(path === "/api/authored/snapshot" ? 280_000 : 30_000);
  const requestSignal = AbortSignal.any([signal, deadline]);
  try { result = await fetch(path, { signal: requestSignal, method: body === null ? "GET" : "POST", credentials: "same-origin", cache: "no-store", headers: { "X-Nexus-Wire": String(WIRE_REVISION), "X-Nexus-Account": account!, ...(body === null ? {} : { "Content-Type": "application/json" }) }, body: body === null ? null : JSON.stringify(body) }); }
  catch (error) { throw Object.assign(new Error("authored network unavailable", { cause: error }), { status: deadline.aborted && !signal.aborted ? 504 : 0 }); }
  if (!result.ok) await answer(result, signal); // throws the answer's status and code
  return result;
}
async function operation(port: MessagePort, op: string, input: Record<string, unknown>) {
  if ((op === "hello" || op === "retire") && (input.wire_revision !== WIRE_REVISION || input.format_revision !== FORMAT_REVISION))
    throw new ApiError(426, "E_WIRE_MISMATCH", "close all nexus tabs to update local writing");
  if (op === "retire") {
    if (input.format_revision !== FORMAT_REVISION || typeof input.account_id !== "string" || account !== null && account !== input.account_id) throw new Error("authored retirement account or format mismatch");
    retired = true; sync?.close();
    await persistence?.db.close();
    for (const current of ports) current.postMessage({ kind: "retired", wire_revision: WIRE_REVISION });
    for (const current of ports) current.close();
    ports.clear(); scope.close(); return null;
  }
  if (op === "hello") {
    if (input.format_revision !== FORMAT_REVISION || typeof input.account_id !== "string") throw new Error("authored worker format mismatch");
    if (account !== null && account !== input.account_id) throw new Error("authored worker account mismatch");
    if (retired) throw new Error("authored account retired");
    if (!persistence) {
      account = input.account_id;
      const opened = new Persistence(await openDatabase(account));
      try { await opened.initialize(account); }
      catch (error) { await opened.db.close(); throw error; }
      persistence = opened;
      sync = new Sync(persistence, {
        json: async <T>(path: string, body: unknown | null, signal: AbortSignal) => answer<T>(await response(path, body, signal), signal),
        snapshot: async signal => {
          const result = await response("/api/authored/snapshot", null, signal);
          if (!result.body) throw new Error("authored snapshot stream missing");
          const body = result.body.getReader();
          return new ReadableStream<Uint8Array>({
            pull: async controller => {
              try {
                const { value, done } = await body.read();
                if (done) controller.close(); else controller.enqueue(value);
              } catch (error) { throw signal.aborted ? error : new ApiError(0, "E_NETWORK", "authored snapshot interrupted"); }
            },
            cancel: reason => body.cancel(reason),
          });
        },
      }, serialize, changed, () => {
        for (const port of ports) port.postMessage({ kind: "evidence_changed" });
      });
      const state = await persistence.replica();
      sync.facts.ready = state.provisioning_complete;
      sync.facts.cursor = state.server_cursor;
      sync.facts.pending = (await persistence.pending()).length > 0;
    }
    return { wire_revision: WIRE_REVISION, format_revision: FORMAT_REVISION, status: syncStatus(sync!.facts), detail: sync!.detail, failure: sync!.facts.failure };
  }
  if (op === "close") { ports.delete(port); port.close(); return null; }
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
        const frame = input.frame as unknown as CommitFrame;
        const result = await persistence.commit(frame);
        if (result.kind === "committed") changed(true, changesDailyIndex(frame.change));
        sync!.facts.pending = (await persistence.pending()).length > 0;
        return result;
      } finally { sync!.facts.saving = false; changed(); }
    }
    case "sync_step": {
      if (typeof input.refresh !== "boolean" || typeof input.online !== "boolean") throw new Error("invalid authored synchronization request");
      sync!.facts.online = input.online;
      return sync!.step({ refresh: input.refresh });
    }
    default: throw new Error("unknown authored operation");
  }
}
scope.onconnect = event => {
  const port = event.ports[0];
  ports.add(port);
  port.onmessage = ({ data }) => {
    if (!data || typeof data.id !== "number" || typeof data.op !== "string") return;
    const submit = () => {
      const answer = async () => {
        if (commandsPaused && (data.op === "command_begin" || data.op === "commit")) { deferred.push(submit); return; }
        try {
          const result = await operation(port, data.op, data);
          if (data.op !== "close" && data.op !== "retire") port.postMessage({ id: data.id, ok: true, result });
        } catch (error) { port.postMessage({ id: data.id, ok: false, error: error instanceof Error ? error.message : "authored operation failed", status: error instanceof ApiError ? error.status : null, code: error instanceof ApiError ? error.code : error instanceof Error && "code" in error && (error.code === "E_AUTHORED_LOCAL" || error.code === "E_AUTHORED_UPGRADE_PENDING") ? error.code : null }); }
      };
      // Network work reacquires the SQL queue for each local transaction.
      if (data.op === "sync_step") void answer();
      else void serialize(answer);
    };
    submit();
  };
  port.start();
};
