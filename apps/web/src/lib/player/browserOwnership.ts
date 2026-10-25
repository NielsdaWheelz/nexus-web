/**
 * Cooperative account-scoped browser ownership. Only the Web Lock holder has
 * audio/write authority. A transfer carries the originating queue fence and a
 * bounded request lifetime; neither grants permission after cancellation.
 * Holder admission runs in its playback lane before any pause or release. The
 * acquirer rereads and checks that same fence before becoming ready.
 */
import { QueueCommandError, type QueueFence, type QueueRequest } from "@/lib/player/queue";
import { ApiError, isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import type { EngineState, PlayerQueue } from "@/lib/player/playerRuntime";

export const BROWSER_COORDINATION_BOUND_MS = 5_000;

interface BrowserSnapshot { readonly queue: PlayerQueue; readonly engine: EngineState; readonly playing_entry_id: string | null }

export type BrowserPlayerCommand =
  | { readonly kind: "queue"; readonly request: QueueRequest }
  | { readonly kind: "pause" | "resume" | "stop" | "check" }
  | { readonly kind: "seek"; readonly position_ms: number; readonly expected_subject: string | null }
  | { readonly kind: "rate"; readonly rate: number }
  | { readonly kind: "silence"; readonly on: boolean };

type Message =
  | { readonly kind: "state"; readonly sender: string; readonly owner_client_id: string; readonly snapshot: BrowserSnapshot }
  | { readonly kind: "observe"; readonly sender: string }
  | { readonly kind: "transfer"; readonly sender: string; readonly id: string; readonly expected_queue: QueueFence | null; readonly expires_at: number }
  | { readonly kind: "cancel"; readonly sender: string; readonly id: string }
  | { readonly kind: "command"; readonly sender: string; readonly id: string; readonly command: BrowserPlayerCommand }
  | { readonly kind: "result"; readonly sender: string; readonly target: string; readonly id: string; readonly error:
      | { readonly kind: "Api"; readonly message: string; readonly status: number; readonly code: string; readonly request_id: string | null }
      | { readonly kind: "Queue" | "Defect"; readonly message: string }
      | null };

export function createBrowserOwnership(input: {
  readonly accountId: string;
  readonly acquired: () => Promise<void>;
  readonly release: (expectedQueue: QueueFence | null, isCurrent: () => boolean) => Promise<void>;
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
  let acquiring: { readonly promise: Promise<boolean>; readonly cancel: () => void } | null = null;
  let ownerClientId: string | null = null;
  let received = 0;
  let accepted = 0;
  const requests = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  const transfers = new Map<string, { cancelled: boolean }>();
  const post = (message: Message) => channel?.postMessage(message);
  const publish = () => {
    if (owner && ready && ownerClientId !== null) post({ kind: "state", sender,
      owner_client_id: ownerClientId, snapshot: input.snapshot() });
  };
  const result = (target: string, id: string, error: unknown) => post({ kind: "result", sender, target, id,
    error: error === null ? null : isApiError(error) && !isSameSystemApiDefect(error)
      ? { kind: "Api", message: error.message, status: error.status, code: error.code, request_id: error.requestId ?? null }
      : { message: error instanceof Error ? error.message : "couldn’t change playback", kind: error instanceof QueueCommandError ? "Queue" : "Defect" } });
  const release = async (expectedQueue: QueueFence | null, isCurrent: () => boolean) => {
    if (!owner || !ready || releasing || !isCurrent()) throw new QueueCommandError("playback is moving to another tab");
    releasing = true;
    try {
      await input.release(expectedQueue, isCurrent);
      if (!isCurrent()) throw new QueueCommandError("playback request expired");
      owner = false;
      ready = false;
      unlock?.();
      unlock = null;
      input.changed();
    } finally { releasing = false; }
  };
  const cancelAcquisition = () => acquiring?.cancel();
  if (channel !== null) channel.onmessage = (event: MessageEvent<Message>) => {
    const message = event.data;
    if (closed || message.sender === sender) return;
    switch (message.kind) {
      case "state": {
        if (owner) return;
        const receipt = ++received;
        // Channel ordering is per sender. A released tab cannot overwrite its successor.
        void navigator.locks.query().then(locks => {
          if (closed || owner || receipt < accepted ||
              !locks.held?.some(lock => lock.name === lockName && lock.clientId === message.owner_client_id)) return;
          accepted = receipt;
          input.mirror(message.snapshot);
        });
        return;
      }
      case "observe": publish(); return;
      case "transfer": {
        if (!owner) return;
        const transfer = { cancelled: false };
        transfers.set(message.id, transfer);
        const isCurrent = () => !closed && !transfer.cancelled && Date.now() < message.expires_at;
        void release(message.expected_queue, isCurrent).then(
          () => result(message.sender, message.id, null),
          error => result(message.sender, message.id, error),
        ).finally(() => transfers.delete(message.id));
        return;
      }
      case "cancel": {
        const transfer = transfers.get(message.id);
        if (transfer !== undefined) transfer.cancelled = true;
        return;
      }
      case "command":
        if (owner && ready && !releasing) void input.command(message.command).then(() => { publish(); result(message.sender, message.id, null); }, error => result(message.sender, message.id, error));
        return;
      case "result": {
        if (message.target !== sender) return;
        const request = requests.get(message.id);
        if (request === undefined) return;
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
  const acquire = (transfer: boolean, expectedQueue: QueueFence | null): Promise<boolean> => {
    if (!supported || closed) return Promise.reject(new QueueCommandError("playback needs a browser with web locks and broadcast channels"));
    if (releasing) return Promise.reject(new QueueCommandError("playback is moving to another tab"));
    cancelAcquisition();
    if (owner && ready) return Promise.resolve(true);
    const abort = new AbortController();
    const id = crypto.randomUUID();
    const expiresAt = Date.now() + BROWSER_COORDINATION_BOUND_MS;
    let cancel = () => {};
    const promise = new Promise<boolean>((resolve, reject) => {
      let settled = false;
      const finish = (error: Error | null, acquired: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        requests.delete(id);
        if (!acquired) {
          abort.abort();
          if (transfer) post({ kind: "cancel", sender, id });
        }
        if (error === null) resolve(acquired); else reject(error);
      };
      cancel = () => finish(null, false);
      const timer = setTimeout(() => finish(new QueueCommandError("playback is still in another tab"), false), BROWSER_COORDINATION_BOUND_MS);
      const options: LockOptions = transfer ? { mode: "exclusive", signal: abort.signal } : { mode: "exclusive", ifAvailable: true };
      void navigator.locks.request(lockName, options, async lock => {
        if (lock === null || closed || abort.signal.aborted) { finish(null, false); return; }
        owner = true;
        let free = () => {};
        const held = new Promise<void>(done => { free = done; unlock = done; });
        try {
          await input.acquired();
          if (closed || abort.signal.aborted || Date.now() >= expiresAt) { finish(null, false); return; }
          const header = input.snapshot().queue.header;
          if (expectedQueue !== null && (header?.queue_id !== expectedQueue.queue_id || header.revision !== expectedQueue.expected_revision))
            throw new QueueCommandError("queue changed; try again");
          const locks = await navigator.locks.query();
          if (closed || abort.signal.aborted || Date.now() >= expiresAt) { finish(null, false); return; }
          ownerClientId = locks.held?.find(heldLock => heldLock.name === lockName)?.clientId ?? null;
          if (ownerClientId === null) throw new QueueCommandError("playback ownership could not be confirmed");
          ready = true;
          input.changed();
          publish();
          finish(null, true);
          await held;
        } catch (error) {
          finish(error instanceof Error ? error : new Error("playback ownership failed"), false);
        } finally {
          owner = false;
          ready = false;
          free();
          if (unlock === free) unlock = null;
        }
      }).catch(error => { if (!abort.signal.aborted) finish(error, false); });
      if (transfer) {
        requests.set(id, { resolve: () => {}, reject: error => finish(error, false) });
        post({ kind: "transfer", sender, id, expected_queue: expectedQueue, expires_at: expiresAt });
      }
    });
    const attempt = { promise, cancel: () => cancel() };
    acquiring = attempt;
    void promise.finally(() => { if (acquiring === attempt) acquiring = null; }).catch(() => {});
    return promise;
  };
  post({ kind: "observe", sender });
  return {
    supported,
    owner: () => owner && ready,
    acquire,
    cancelAcquisition,
    publish,
    async command(command: BrowserPlayerCommand) {
      if (owner && ready && !releasing) return input.command(command);
      if (await acquire(false, null)) return input.command(command);
      const id = crypto.randomUUID();
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { requests.delete(id); reject(new QueueCommandError("playback is still in another tab")); }, BROWSER_COORDINATION_BOUND_MS);
        requests.set(id, {
          resolve: () => { clearTimeout(timer); resolve(); },
          reject: error => { clearTimeout(timer); reject(error); },
        });
        post({ kind: "command", sender, id, command });
      });
    },
    close() {
      closed = true;
      cancelAcquisition();
      for (const request of requests.values()) request.reject(new QueueCommandError("playback account changed"));
      requests.clear();
      // Account teardown already paused the engine; sent writes keep their lane position.
      const leaving = owner && ready ? input.release(null, () => true) : Promise.resolve();
      void leaving.finally(() => { owner = false; ready = false; unlock?.(); unlock = null; channel?.close(); }).catch(() => {});
    },
  };
}
