"use client";

// one authenticated-tab stream wakes account-scoped, mounted projections. a watch
// owns its adopted lanes; a probe is evidence for a reread, never authored state.
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useOptionalAuthenticatedAccount } from "@/lib/account/authenticatedAccount";
import { assertNever } from "@/lib/assertNever";
import { apiFetch } from "@/lib/api/client";
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
  error: Error | null;
  invalidate(state: "stale" | "unavailable"): void;
  acknowledge?: (ack: Schema<"WritingAck">) => WritingVersions;
}
interface Receiver {
  watchers: Set<Watch>;
  listeners: Set<() => void>;
  revision: number | null;
  stamp: number;
  error: Error | null;
  users: number;
  start(): void;
  stop(): void;
  probe(): void;
  retry(): void;
  notify(): void;
}
const receivers = new Map<string, Receiver>();
const PROBE_BATCH_SIZE = 256;
const asError = (error: unknown) => error instanceof Error ? error : new Error(String(error));

function receiver(accountId: string): Receiver {
  const existing = receivers.get(accountId);
  if (existing) return existing;
  let epoch = 0;
  let controller: AbortController | null = null;
  let stopStream: (() => void) | null = null;
  let stopAcknowledgements: (() => void) | null = null;
  let removeForeground: (() => void) | null = null;
  let probing = false;
  let queued = false;
  let scheduled = false;
  let streamError: Error | null = null;
  let probeError: Error | null = null;
  const notify = () => {
    let watchError: Error | null = null;
    for (const watch of current.watchers) if (watch.error !== null) { watchError = watch.error; break; }
    current.error = streamError ?? probeError ?? watchError;
    for (const listener of current.listeners) listener();
  };
  function retryFailedWatches() {
    for (const watch of current.watchers) {
      if (watch.error === null) continue;
      watch.error = null;
      watch.stale = false;
      watch.generation += 1;
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
    if (active === null || active.signal.aborted) return;
    if (probing) { queued = true; return; }
    probing = true;
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
      if (started !== epoch || active.signal.aborted || isAbortError(error) || handleUnauthenticatedApiError(error)) return;
      probeError = asError(error);
      notify();
    } finally {
      if (started === epoch) {
        probing = false;
        if (queued) current.probe();
      }
    }
  }
  function connect() {
    const active = controller;
    if (active === null) return;
    stopStream?.();
    const started = epoch;
    stopStream = openStream<Schema<"WritingState">, Schema<"WritingState">>({
      path: "/api/stream/writing",
      decode(type, state) {
        if (type !== "state") throw new Error(`unexpected writing event: ${type}`);
        return state;
      },
      isTerminal: () => false,
      onEvent(state) {
        if (started !== epoch) return;
        streamError = null;
        if (current.revision !== state.revision) {
          current.revision = state.revision;
          current.stamp += 1;
        }
        notify();
        current.probe();
      },
      onReconnect() {
        if (started !== epoch) return;
        streamError = new Error("writing updates disconnected. reconnecting…");
        retryFailedWatches();
        notify();
        current.probe();
      },
      onError(error) {
        if (started !== epoch) return;
        streamError = error;
        notify();
      },
      signal: active.signal,
    });
  }
  const current: Receiver = {
    watchers: new Set(), listeners: new Set(), revision: null, stamp: 0, error: null, users: 0,
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
        retryFailedWatches();
        notify();
        if (streamError !== null) connect();
        current.probe();
      };
      document.addEventListener("visibilitychange", foreground);
      for (const event of ["focus", "online", "pageshow"] as const) window.addEventListener(event, foreground);
      removeForeground = () => {
        document.removeEventListener("visibilitychange", foreground);
        for (const event of ["focus", "online", "pageshow"] as const) window.removeEventListener(event, foreground);
      };
      retryFailedWatches();
      connect();
      current.probe();
    },
    stop() {
      epoch += 1;
      controller?.abort();
      controller = null;
      stopStream?.(); stopStream = null;
      stopAcknowledgements?.(); stopAcknowledgements = null;
      removeForeground?.(); removeForeground = null;
      probing = false; queued = false; scheduled = false;
      streamError = null; probeError = null;
      notify();
    },
    probe() {
      if (controller === null || scheduled) return;
      scheduled = true;
      queueMicrotask(() => { scheduled = false; void probe(); });
    },
    retry() {
      if (controller === null) return;
      retryFailedWatches();
      notify();
      connect();
      current.probe();
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
      watch.error = asError(error);
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

export function useWritingReceive(accountId: string): { error: Error | null; retry(): void } {
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
  const error = useSyncExternalStore(subscribe, () => owner.error, () => null);
  return { error, retry: owner.retry };
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
