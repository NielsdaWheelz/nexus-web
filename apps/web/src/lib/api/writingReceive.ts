"use client";

// one authenticated-tab stream wakes account-scoped, mounted projections. a watch
// owns its adopted lanes; a probe is evidence for a reread, never authored state.
// each failure survives retry until its own accepted recovery or retirement.
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useOptionalAuthenticatedAccount } from "@/lib/account/authenticatedAccount";
import { assertNever } from "@/lib/assertNever";
import { remoteReady } from "@/lib/native/admission";
import { apiFetch, isApiError, isSameSystemApiDefect, type ApiError } from "@/lib/api/client";
import { publishChange } from "@/lib/api/changes";
import { requestWithRetry } from "@/lib/api/serverState";
import { openStream } from "@/lib/api/stream";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { isAbortError } from "@/lib/errors";
import { subscribeWritingAcknowledgements, writingAccount } from "@/lib/notes/journal";
import { acknowledgeGraphCommands } from "@/lib/resourceGraph/links";

export type WritingVersionLane = "body_version" | "title_version" | "links_version" | "annotations_version" | "highlight_version";
export type WritingVersions = Partial<Pick<Schema<"ResourceVersionState">, WritingVersionLane>>;
export interface WritingConnection {
  readonly phase: "idle" | "connecting" | "live" | "recovering" | "failed";
  readonly failure: ApiError | null;
}
export interface WritingReceiveSnapshot {
  readonly connection: WritingConnection;
  readonly probe_failure: ApiError | null;
  readonly probing: boolean;
}
const IDLE_SNAPSHOT: WritingReceiveSnapshot = {
  connection: { phase: "idle", failure: null }, probe_failure: null, probing: false,
};
export interface WritingWatch {
  capture(): number;
  adopt(versions: WritingVersions, generation: number): boolean;
  fail(error: unknown, generation: number): void;
  stop(): void;
}
interface Watch extends WritingWatch {
  ref: string;
  lanes: readonly WritingVersionLane[];
  generation: number;
  versions: WritingVersions;
  observed: WritingVersions;
  stale: boolean;
  unavailable: boolean;
  error: ApiError | null;
  invalidate(state: "stale" | "unavailable"): void;
  acknowledge?: (ack: Schema<"WritingAck">) => WritingVersions;
}
interface Receiver {
  watchers: Set<Watch>;
  listeners: Set<() => void>;
  revision: number | null;
  stamp: number;
  snapshot: WritingReceiveSnapshot;
  users: number;
  start(): void;
  stop(): void;
  probe(): void;
  reconnect(): void;
  retryRefresh(ref: string): void;
  notify(): void;
}
const receivers = new Map<string, Receiver>();
const PROBE_BATCH_SIZE = 256;
function modeledFailure(error: unknown): ApiError | null {
  // justify-ignore-error: abort and handled sign-in already have recovery owners.
  if (isAbortError(error) || handleUnauthenticatedApiError(error)) return null;
  if (isApiError(error) && !isSameSystemApiDefect(error)) return error;
  reportError(error);
  return null;
}

function receiver(accountId: string): Receiver {
  const existing = receivers.get(accountId);
  if (existing) return existing;
  let epoch = 0;
  let streamEpoch = 0;
  let controller: AbortController | null = null;
  let stopStream: (() => void) | null = null;
  let stopAcknowledgements: (() => void) | null = null;
  let removeForeground: (() => void) | null = null;
  let probing = false;
  let queued = false;
  let scheduled = false;
  let phase: WritingConnection["phase"] = "idle";
  // a retry's defect must not turn the retained earlier failure into a focus retry.
  let terminalDefect = false;
  let streamError: ApiError | null = null;
  let probeError: ApiError | null = null;
  const notify = () => {
    if (current.watchers.size === 0) probeError = null;
    const previous = current.snapshot;
    const connection = previous.connection.phase === phase && previous.connection.failure === streamError
      ? previous.connection : { phase, failure: streamError };
    const busy = scheduled || probing || queued;
    if (connection !== previous.connection || probeError !== previous.probe_failure || busy !== previous.probing)
      current.snapshot = { connection, probe_failure: probeError, probing: busy };
    for (const listener of current.listeners) listener();
  };
  function retryFailedWatches(ref: string | null) {
    for (const watch of [...current.watchers]) {
      if (!current.watchers.has(watch) || watch.error === null || (ref !== null && watch.ref !== ref)) continue;
      watch.stale = true;
      watch.generation += 1;
      try { watch.invalidate(watch.unavailable ? "unavailable" : "stale"); }
      catch (error) { reportError(error); }
    }
  }
  function stale(watch: Watch, versions: WritingVersions, unavailable: boolean) {
    if (!current.watchers.has(watch)) return;
    const changed = watch.lanes.some(lane => lane in versions && versions[lane] !== watch.versions[lane]);
    if (!unavailable && !watch.unavailable && !changed) return;
    if (watch.stale && watch.unavailable === unavailable && watch.lanes.every(lane => !(lane in versions) || watch.observed[lane] === versions[lane])) return;
    watch.generation += 1;
    watch.observed = { ...watch.observed, ...versions };
    watch.stale = true;
    watch.unavailable = unavailable;
    try { watch.invalidate(unavailable ? "unavailable" : "stale"); }
    catch (error) { reportError(error); }
  }
  async function probe() {
    const active = controller;
    const started = epoch;
    if (active === null || active.signal.aborted || !remoteReady()) { notify(); return; }
    probing = true;
    notify();
    try {
      do {
        queued = false;
        const refs = [...new Set([...current.watchers].map(watch => watch.ref))];
        for (let offset = 0; offset < refs.length; offset += PROBE_BATCH_SIZE) {
          const batch = refs.slice(offset, offset + PROBE_BATCH_SIZE);
          const captured = new Map([...current.watchers].filter(watch => batch.includes(watch.ref)).map(watch => [watch, watch.generation]));
          const response = await requestWithRetry(signal => apiFetch<ApiJson<"/resource-graph/versions/query", "post">>("/api/resource-graph/versions/query", {
            method: "POST", body: JSON.stringify({ refs: batch }), signal,
          }), active.signal);
          if (started !== epoch || active.signal.aborted) return;
          const byRef = new Map(response.data.items.map(item => [item.ref, item]));
          for (const [watch, generation] of captured) {
            if (!current.watchers.has(watch) || watch.generation !== generation) continue;
            const item = byRef.get(watch.ref);
            // the route returns one state per requested ref; omission is a defect.
            if (!item) throw new Error("writing version probe omitted a requested resource");
            stale(watch, item, item.state === "unavailable");
          }
        }
        probeError = null;
        notify();
      } while (queued && started === epoch && !active.signal.aborted);
    } catch (error) {
      if (started !== epoch || active.signal.aborted || isAbortError(error)) return;
      const failure = modeledFailure(error);
      if (failure !== null && current.watchers.size > 0) probeError = failure;
      notify();
    } finally {
      if (started === epoch) {
        probing = false;
        if (queued) { queued = false; current.probe(); }
        notify();
      }
    }
  }
  function connect() {
    const active = controller;
    if (active === null) return;
    const opened = ++streamEpoch;
    stopStream?.();
    const started = epoch;
    const currentStream = () => started === epoch && opened === streamEpoch && !active.signal.aborted;
    terminalDefect = false;
    phase = "connecting";
    notify();
    stopStream = openStream<Schema<"WritingState">, Schema<"WritingState">>({
      path: "/api/stream/writing",
      decode(type, state) {
        if (type !== "state") throw new Error(`unexpected writing event: ${type}`);
        return state;
      },
      isTerminal: () => false,
      onEvent(state) {
        if (!currentStream()) return;
        terminalDefect = false;
        phase = "live";
        streamError = null;
        if (current.revision !== state.revision) {
          current.revision = state.revision;
          current.stamp += 1;
        }
        notify();
        current.probe();
      },
      onReconnect() {
        if (!currentStream()) return;
        phase = "recovering";
        retryFailedWatches(null);
        notify();
        current.probe();
      },
      onSuspended(error) {
        if (!currentStream()) return;
        phase = "recovering";
        const failure = modeledFailure(error);
        if (failure !== null) streamError = failure;
        notify();
      },
      onError(error) {
        if (!currentStream()) return;
        phase = "failed";
        const failure = modeledFailure(error);
        terminalDefect = failure === null;
        if (failure !== null) streamError = failure;
        notify();
      },
      signal: active.signal,
    });
  }
  const current: Receiver = {
    watchers: new Set(), listeners: new Set(), revision: null, stamp: 0, snapshot: IDLE_SNAPSHOT, users: 0,
    notify,
    start() {
      if (controller !== null) return;
      epoch += 1;
      controller = new AbortController();
      stopAcknowledgements = subscribeWritingAcknowledgements(ack => {
        if (writingAccount() !== accountId) return;
        const started = epoch;
        // synchronous journal subscribers adopt facts first. local request/history
        // owners must not depend on the ordering of nested promise continuations.
        queueMicrotask(() => {
          if (started !== epoch || controller === null || writingAccount() !== accountId) return;
          for (const watch of [...current.watchers]) {
            try {
              const adopted = watch.acknowledge?.(ack);
              if (adopted && Object.keys(adopted).length > 0) watch.adopt(adopted, watch.capture());
            } catch (error) { reportError(error); }
          }
          acknowledgeGraphCommands(ack);
          const bodies = ack.notes.length > 0 || ack.deleted_refs.some(ref => ref.startsWith("note_block:"));
          const structure = ack.pages.length > 0 || ack.insertions.length > 0 || ack.removed_link_ids.length > 0 ||
            ack.lanes.some(lane => lane.lane === "title" || lane.lane === "links") ||
            ack.deleted_refs.some(ref => ref.startsWith("page:") || ref.startsWith("note_block:"));
          if (structure && bodies) publishChange("Notes", "NoteBodies");
          else if (structure) publishChange("Notes");
          else if (bodies) publishChange("NoteBodies");
          for (const watch of current.watchers) {
            const versions: WritingVersions = {};
            for (const lane of ack.lanes) {
              if (lane.ref !== watch.ref) continue;
              switch (lane.lane) {
                case "body": versions.body_version = lane.version; break;
                case "title": versions.title_version = lane.version; break;
                case "links": versions.links_version = lane.version; break;
                case "annotations": versions.annotations_version = lane.version; break;
                case "context": break;
                default: assertNever(lane.lane);
              }
            }
            const highlight = ack.highlights.find(item => watch.ref === `highlight:${item.id}`);
            if (highlight) versions.highlight_version = highlight.version;
            // an older local acknowledgement cannot roll back newer read evidence.
            for (const lane of watch.lanes) {
              const value = versions[lane];
              const adopted = watch.versions[lane];
              if (typeof value === "number" && typeof adopted === "number" && value < adopted) delete versions[lane];
            }
            stale(watch, versions, ack.deleted_refs.includes(watch.ref));
          }
        });
      });
      const foreground = () => {
        if (document.visibilityState === "hidden") return;
        current.stamp += 1;
        retryFailedWatches(null);
        notify();
        if (phase === "failed" && streamError !== null && !terminalDefect) current.reconnect();
        current.probe();
      };
      document.addEventListener("visibilitychange", foreground);
      for (const event of ["focus", "online", "pageshow"] as const) window.addEventListener(event, foreground);
      removeForeground = () => {
        document.removeEventListener("visibilitychange", foreground);
        for (const event of ["focus", "online", "pageshow"] as const) window.removeEventListener(event, foreground);
      };
      retryFailedWatches(null);
      connect();
      current.probe();
    },
    stop() {
      epoch += 1;
      streamEpoch += 1;
      controller?.abort();
      controller = null;
      stopStream?.(); stopStream = null;
      stopAcknowledgements?.(); stopAcknowledgements = null;
      removeForeground?.(); removeForeground = null;
      probing = false; queued = false; scheduled = false;
      phase = "idle"; streamError = null; probeError = null;
      for (const watch of current.watchers) { watch.generation += 1; watch.error = null; }
      notify();
    },
    probe() {
      if (controller === null) return;
      if (probing) { queued = true; notify(); return; }
      if (scheduled) return;
      scheduled = true;
      const started = epoch;
      notify();
      queueMicrotask(() => {
        if (started !== epoch) return;
        scheduled = false;
        void probe();
      });
    },
    reconnect() {
      if (controller === null || phase === "connecting" || phase === "recovering") return;
      connect();
    },
    retryRefresh(ref) {
      if (controller !== null) retryFailedWatches(ref);
    },
  };
  if (typeof window !== "undefined") receivers.set(accountId, current);
  return current;
}

export function watchWritingResource(input: {
  accountId: string;
  ref: string;
  lanes: readonly WritingVersionLane[];
  invalidate(state: "stale" | "unavailable"): void;
  /** only lanes whose complete projection has adopted these exact facts. */
  acknowledge?: (ack: Schema<"WritingAck">) => WritingVersions;
}): WritingWatch {
  const owner = receiver(input.accountId);
  const watch: Watch = {
    ref: input.ref, lanes: input.lanes, invalidate: input.invalidate, acknowledge: input.acknowledge,
    generation: 0, versions: {}, observed: {}, stale: false, unavailable: false, error: null,
    capture: () => watch.generation,
    adopt(versions, generation) {
      if (!owner.watchers.has(watch) || generation !== watch.generation || watch.unavailable) return false;
      const adopted = Object.keys(versions).length === 0 ? watch.observed : versions;
      for (const lane of watch.lanes) {
        const previous = watch.versions[lane];
        const next = adopted[lane];
        if (typeof previous === "number" && typeof next === "number" && next < previous) return false;
      }
      watch.versions = { ...watch.versions, ...adopted };
      watch.stale = false;
      watch.error = null;
      watch.generation += 1;
      owner.notify();
      return true;
    },
    fail(error, generation) {
      if (!owner.watchers.has(watch) || generation !== watch.generation) return;
      const failure = modeledFailure(error);
      if (failure === null) return;
      watch.error = failure;
      owner.notify();
    },
    stop() {
      watch.generation += 1;
      watch.error = null;
      owner.watchers.delete(watch);
      owner.notify();
    },
  };
  owner.watchers.add(watch);
  owner.probe();
  return watch;
}

export function useWritingReceive(accountId: string): {
  snapshot: WritingReceiveSnapshot;
  reconnect(): void;
  retryProbe(): void;
} {
  const owner = receiver(accountId);
  useEffect(() => {
    owner.users += 1;
    owner.start();
    return () => { owner.users -= 1; if (owner.users === 0) owner.stop(); };
  }, [owner]);
  const subscribe = useCallback((listener: () => void) => {
    owner.listeners.add(listener);
    return () => { owner.listeners.delete(listener); };
  }, [owner]);
  const snapshot = useSyncExternalStore(subscribe, () => owner.snapshot, () => IDLE_SNAPSHOT);
  return { snapshot, reconnect: owner.reconnect, retryProbe: owner.probe };
}

/** Passive observation; the mounted projection remains the only read owner. */
export function useWritingRefresh(ref: string): { error: ApiError | null; retry(): void } {
  const account = useOptionalAuthenticatedAccount();
  const owner = account === null ? null : receivers.get(account.accountId) ?? null;
  const subscribe = useCallback((listener: () => void) => {
    owner?.listeners.add(listener);
    return () => { owner?.listeners.delete(listener); };
  }, [owner]);
  const error = useSyncExternalStore(subscribe, () => {
    if (owner !== null) for (const watch of owner.watchers)
      if (watch.ref === ref && watch.error !== null) return watch.error;
    return null;
  }, () => null);
  const retry = useCallback(() => owner?.retryRefresh(ref), [owner, ref]);
  return { error, retry };
}

export function useWritingRevision(): number {
  const account = useOptionalAuthenticatedAccount();
  const owner = account === null ? null : receiver(account.accountId);
  const subscribe = useCallback((listener: () => void) => {
    owner?.listeners.add(listener);
    return () => { owner?.listeners.delete(listener); };
  }, [owner]);
  return useSyncExternalStore(subscribe, () => owner?.stamp ?? 0, () => 0);
}
