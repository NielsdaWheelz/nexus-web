/**
 * Cooperative account-scoped browser ownership. The Web Lock holder alone has
 * audio/write authority. BroadcastChannel carries snapshots and revision-bound
 * requests, never a durable ledger. Transfer pauses and drains before release;
 * timeout cancels waiting permission and cannot cause late autoplay.
 */
import { QueueCommandError, type QueueRequest } from "@/lib/player/queue";
import { ApiError, isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import type { EngineState, PlayerQueue } from "@/lib/player/playerRuntime";

export const BROWSER_COORDINATION_BOUND_MS = 5_000;

interface BrowserSnapshot { readonly queue: PlayerQueue; readonly engine: EngineState }

export type BrowserPlayerCommand =
  | { readonly kind: "queue"; readonly request: QueueRequest }
  | { readonly kind: "pause" | "resume" | "stop" | "clear" | "check" }
  | { readonly kind: "seek"; readonly position_ms: number; readonly expected_subject: string | null }
  | { readonly kind: "rate"; readonly rate: number }
  | { readonly kind: "silence"; readonly on: boolean };

type Message =
  | { readonly kind: "state"; readonly sender: string; readonly owner_client_id: string; readonly snapshot: BrowserSnapshot }
  | { readonly kind: "observe"; readonly sender: string }
  | { readonly kind: "transfer"; readonly sender: string; readonly id: string }
  | { readonly kind: "command"; readonly sender: string; readonly id: string; readonly command: BrowserPlayerCommand }
  | { readonly kind: "result"; readonly sender: string; readonly target: string; readonly id: string; readonly error:
      | { readonly kind: "Api"; readonly message: string; readonly status: number; readonly code: string; readonly request_id: string | null }
      | { readonly kind: "Queue" | "Defect"; readonly message: string }
      | null };

export function createBrowserOwnership(input: {
  readonly accountId: string;
  readonly acquired: () => Promise<void>;
  readonly release: () => Promise<void>;
  readonly command: (command: BrowserPlayerCommand) => Promise<void>;
  readonly snapshot: () => BrowserSnapshot;
  readonly mirror: (snapshot: BrowserSnapshot) => void;
  readonly changed: () => void;
}) {
  const supported = typeof navigator.locks?.query === "function" && typeof BroadcastChannel !== "undefined";
  const sender = crypto.randomUUID();
  const channel = supported ? new BroadcastChannel(`nexus-playback:${input.accountId}`) : null;
  const lockName = `nexus-playback:${input.accountId}`;
  let owner = false;
  let ready = false;
  let closed = false;
  let releasing = false;
  let unlock: (() => void) | null = null;
  let acquiring: Promise<boolean> | null = null;
  let ownerClientId: string | null = null;
  let received = 0;
  let accepted = 0;
  const requests = new Map<string, { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const post = (message: Message) => channel?.postMessage(message);
  const publish = () => {
    if (owner && ready && ownerClientId !== null) post({ kind: "state", sender,
      owner_client_id: ownerClientId, snapshot: input.snapshot() });
  };
  const result = (target: string, id: string, error: unknown) => post({ kind: "result", sender, target, id,
    error: error === null ? null : isApiError(error) && !isSameSystemApiDefect(error)
      ? { kind: "Api", message: error.message, status: error.status, code: error.code, request_id: error.requestId ?? null }
      : { message: error instanceof Error ? error.message : "couldn’t change playback", kind: error instanceof QueueCommandError ? "Queue" : "Defect" } });
  const release = async () => {
    if (!owner || releasing) return;
    releasing = true;
    try {
      if (!ready && acquiring !== null) await acquiring;
      if (!owner) return;
      await input.release();
      owner = false;
      ready = false;
      unlock?.();
      unlock = null;
      input.changed();
    } finally { releasing = false; }
  };
  if (channel !== null) channel.onmessage = (event: MessageEvent<Message>) => {
    const message = event.data;
    if (closed || message.sender === sender) return;
    switch (message.kind) {
      case "state": {
        if (owner) return;
        const receipt = ++received;
        // Channel ordering is only per sender. Ask the lock owner, so a delayed
        // final snapshot from a released tab cannot overwrite its successor.
        void navigator.locks.query().then(locks => {
          if (closed || owner || receipt < accepted ||
              !locks.held?.some(lock => lock.name === lockName && lock.clientId === message.owner_client_id)) return;
          accepted = receipt;
          input.mirror(message.snapshot);
        });
        return;
      }
      case "observe": publish(); return;
      case "transfer":
        if (owner) void release().then(() => result(message.sender, message.id, null), () => result(message.sender, message.id, new QueueCommandError("playback is still in another tab")));
        return;
      case "command":
        if (owner && ready && !releasing) void input.command(message.command).then(() => { publish(); result(message.sender, message.id, null); }, error => result(message.sender, message.id, error));
        return;
      case "result": {
        if (message.target !== sender) return;
        const request = requests.get(message.id);
        if (request === undefined) return;
        clearTimeout(request.timer);
        requests.delete(message.id);
        if (message.error === null) request.resolve();
        else if (message.error.kind === "Api") {
          const error = new ApiError(message.error.status, message.error.code, message.error.message, message.error.request_id ?? undefined);
          handleUnauthenticatedApiError(error);
          request.reject(error);
        } else request.reject(message.error.kind === "Queue" ? new QueueCommandError(message.error.message) : new Error(message.error.message));
      }
    }
  };
  const acquire = (transfer: boolean): Promise<boolean> => {
    if (!supported || closed) return Promise.reject(new QueueCommandError("playback needs a browser with web locks and broadcast channels"));
    if (releasing) return Promise.reject(new QueueCommandError("playback is moving to another tab"));
    if (acquiring !== null) return acquiring;
    if (owner && ready) return Promise.resolve(true);
    acquiring = new Promise<boolean>((resolve, reject) => {
      const abort = new AbortController();
      let granted = false;
      const timer = setTimeout(() => { if (!granted) { abort.abort(); reject(new QueueCommandError("playback is still in another tab")); } }, BROWSER_COORDINATION_BOUND_MS);
      // No steal: the old audio must stop before a new holder can be admitted.
      const options: LockOptions = transfer ? { mode: "exclusive", signal: abort.signal } : { mode: "exclusive", ifAvailable: true };
      void navigator.locks.request(lockName, options, async lock => {
        if (lock === null || closed || abort.signal.aborted) { clearTimeout(timer); resolve(false); return; }
        owner = true;
        const held = new Promise<void>(done => { unlock = done; });
        try {
          await input.acquired();
          const locks = await navigator.locks.query();
          ownerClientId = locks.held?.find(heldLock => heldLock.name === lockName)?.clientId ?? null;
          if (ownerClientId === null) throw new QueueCommandError("playback ownership could not be confirmed");
          if (closed || abort.signal.aborted) { owner = false; unlock?.(); resolve(false); return; }
          granted = true;
          clearTimeout(timer);
          ready = true;
          input.changed();
          publish();
          resolve(true);
          await held;
        } catch (error) {
          owner = false;
          ready = false;
          unlock?.();
          reject(error);
        }
      }).catch(error => { clearTimeout(timer); if (!abort.signal.aborted) reject(error); });
      if (transfer) post({ kind: "transfer", sender, id: crypto.randomUUID() });
    }).finally(() => { acquiring = null; });
    return acquiring;
  };
  post({ kind: "observe", sender });
  return {
    supported,
    owner: () => owner && ready && !releasing,
    acquire,
    publish,
    async command(command: BrowserPlayerCommand) {
      if (owner && ready && !releasing) return input.command(command);
      if (await acquire(false)) return input.command(command);
      const id = crypto.randomUUID();
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { requests.delete(id); reject(new QueueCommandError("playback is still in another tab")); }, BROWSER_COORDINATION_BOUND_MS);
        requests.set(id, { resolve, reject, timer });
        post({ kind: "command", sender, id, command });
      });
    },
    close() {
      closed = true;
      for (const request of requests.values()) { clearTimeout(request.timer); request.reject(new QueueCommandError("playback account changed")); }
      requests.clear();
      // Teardown has already paused the engine. Any sent write keeps the lock until settled.
      void release().catch(() => {
        // Account teardown has no remaining audio authority or request owner.
        // A later holder always rereads the saved row paused.
        owner = false;
        ready = false;
        unlock?.();
        unlock = null;
      }).finally(() => channel?.close());
    },
  };
}
