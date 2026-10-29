"use client";

import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { ApiError } from "@/lib/api/client";
import { database, type BrowserBinding } from "@/lib/authored/binding";
import { normalizeVisitTitleHint } from "@/lib/workspace/model";
import { installedApp } from "@/lib/native/admission";
import { openRecent, readRecent, useRecentTarget, reconcileRecentTarget, subscribeRecentChanged } from "@/lib/native/client";
import { applyRecent, parseRecentSnapshot, recentTargetKey, type RecentObservation, type RecentEntry, type RecentReconcile, type RecentSnapshot, type RecentValue } from "./model";

type View = { snapshot: RecentSnapshot | null; readFailure: boolean; writeFailure: RecentObservation["write_failure"] };
type Operation = { kind: "use"; value: RecentValue } | { kind: "reconcile"; input: RecentReconcile };

function browserOperation(accountId: string, lifetime: string, epoch: string | null, op: Operation | null, live: () => boolean): Promise<RecentSnapshot> {
  return database().then(async db => {
    try { return await new Promise((resolve, reject) => {
      const tx = db.transaction("binding", "readwrite", { durability: "strict" });
      const store = tx.objectStore("binding");
      const current = store.get("current");
      const retiring = store.get("retiring");
      const token = store.get("lifetime");
      const history = store.get("recent_targets");
      let result: RecentSnapshot;
      history.onsuccess = () => {
        try {
          if (!live() || retiring.result != null || token.result !== lifetime || (current.result as BrowserBinding | undefined)?.account.account_id !== accountId) throw new Error("recent account retired");
          if (history.result === undefined) {
            if (epoch !== null) throw new Error("recent epoch retired");
            result = { format_version: 1, account_id: accountId, epoch: crypto.randomUUID(), revision: "1", entries: [] };
            store.put(result, "recent_targets");
          } else result = parseRecentSnapshot(history.result);
          if (result.account_id !== accountId || epoch !== null && result.epoch !== epoch) throw new Error("recent epoch mismatch");
          if (op !== null) {
            const next = applyRecent(result, op);
            if (next !== result) store.put(next, "recent_targets");
            result = next;
          }
        } catch { tx.abort(); }
      };
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(tx.error ?? new Error("recent storage operation failed"));
      tx.onerror = () => reject(tx.error);
    }); } finally { db.close(); }
  });
}

const initialDocuments = new Set<string>();

function createRecent(accountId: string, lifetime: string | null) {
  let view: View = { snapshot: null, readFailure: false, writeFailure: null };
  let active = true;
  let localFailure: RecentObservation["write_failure"] = null;
  let failureFloor: bigint | null = null;
  let channel: BroadcastChannel | null = null;
  let queue: Promise<void> = Promise.resolve();
  const listeners = new Set<() => void>();
  const publish = (patch: Partial<View>) => { if (!active) return; view = { ...view, ...patch }; for (const listener of listeners) listener(); };
  const adopt = (observation: RecentObservation) => {
    const current = view.snapshot;
    if (!active || current && (current.epoch !== observation.snapshot.epoch || BigInt(current.revision) > BigInt(observation.snapshot.revision))) return;
    publish({ snapshot: observation.snapshot, readFailure: false, writeFailure: observation.write_failure });
  };
  const open = async () => {
    const result = installedApp ? await openRecent() : { snapshot: await browserOperation(accountId, lifetime!, null, null, () => active), write_failure: null };
    if (!active || result.snapshot.account_id !== accountId) throw new Error("recent account retired");
    if (!installedApp) {
      channel = new BroadcastChannel(`nexus-recent-${result.snapshot.epoch}`);
      channel.onmessage = () => read();
    }
    return result;
  };
  let opened: Promise<RecentObservation> | null = null;
  const ensureOpen = () => {
    if (opened === null) {
      opened = open().catch(error => { opened = null; throw error; });
    }
    return opened;
  };
  const read = () => {
    queue = queue.then(async () => {
      try {
        const initial = await ensureOpen();
        const observation = installedApp ? await readRecent(initial.snapshot.epoch) : { snapshot: await browserOperation(accountId, lifetime!, initial.snapshot.epoch, null, () => active), write_failure: view.writeFailure };
        if (installedApp && localFailure !== null) {
          const latestUse = BigInt(observation.snapshot.entries[0]?.used_revision ?? "0");
          if (failureFloor !== null && latestUse > failureFloor) { localFailure = null; failureFloor = null; }
          else if (failureFloor === null) failureFloor = latestUse;
        }
        adopt({ ...observation, write_failure: installedApp ? localFailure ?? observation.write_failure : view.writeFailure });
      } catch { publish({ readFailure: true }); }
    });
  };
  const submit = (input: Operation | null, initial = false): Promise<RecentEntry | null> => {
    const normalize = (value: RecentValue): RecentValue => ({ ...value, title_hint: normalizeVisitTitleHint(value.title_hint), detail_hint: normalizeVisitTitleHint(value.detail_hint) });
    const op: Operation | null = input === null ? null : input.kind === "use" ? { kind: "use", value: normalize(input.value) } : { kind: "reconcile", input: { ...input.input, replacement: input.input.replacement === null ? null : normalize(input.input.replacement) } };
    const result = queue.then(async (): Promise<RecentEntry | null> => {
      try {
        const opened = await ensureOpen();
        if (initial) {
          const key = `${accountId}:${opened.snapshot.epoch}`;
          if (initialDocuments.has(key)) return null;
          initialDocuments.add(key);
        }
        if (op === null) return null;
        const result = installedApp ? op.kind === "use" ? await useRecentTarget(opened.snapshot.epoch, op.value) : await reconcileRecentTarget(opened.snapshot.epoch, op.input)
          : { snapshot: await browserOperation(accountId, lifetime!, opened.snapshot.epoch, op, () => active), write_failure: op.kind === "use" ? null : view.writeFailure };
        if (op.kind === "use" && result.write_failure === null) { localFailure = null; failureFloor = null; }
        adopt({ ...result, write_failure: installedApp ? localFailure ?? result.write_failure : op.kind === "use" ? result.write_failure : view.writeFailure });
        channel?.postMessage(null);
        const first = result.snapshot.entries[0];
        return op.kind === "use" && result.write_failure === null && first && recentTargetKey(first.target) === recentTargetKey(op.value.target) ? first : null;
      } catch (error) {
        if (op === null) { publish({ readFailure: true }); return null; }
        const uncertain = installedApp && (!(error instanceof ApiError) || error.code === "E_NATIVE_TIMEOUT" || error.code === "E_INVALID_RESPONSE");
        localFailure = uncertain ? "unconfirmed" : "failed";
        failureFloor = null;
        publish({ writeFailure: localFailure });
        if (uncertain) {
          try {
            const initial = await ensureOpen();
            const observation = await readRecent(initial.snapshot.epoch);
            failureFloor = BigInt(observation.snapshot.entries[0]?.used_revision ?? "0");
            adopt({ ...observation, write_failure: "unconfirmed" });
          } catch { publish({ readFailure: true }); }
        }
        return null;
      }
    });
    queue = result.then(() => {});
    return result;
  };
  return { subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, value: () => view,
    read, use: (value: RecentValue) => submit({ kind: "use", value }), useInitial: (value: RecentValue | null) => submit(value === null ? null : { kind: "use", value }, true), reconcile: (input: RecentReconcile) => { void submit({ kind: "reconcile", input }); },
    start: () => { active = true; read(); },
    close: () => { active = false; channel?.close(); channel = null; } };
}
type Store = ReturnType<typeof createRecent>;
const Context = createContext<Store | null>(null);
export function RecentProvider({ accountId, browserLifetime, children }: { accountId: string; browserLifetime: string | null; children: ReactNode }) {
  const [store] = useState(() => createRecent(accountId, browserLifetime));
  const lease = useRef(0);
  useEffect(() => {
    const owner = lease;
    const current = ++owner.current;
    store.start();
    const retired = () => store.close();
    const visible = () => { if (document.visibilityState === "visible") store.read(); };
    const unsubscribe = installedApp ? subscribeRecentChanged(store.read) : () => {};
    window.addEventListener("nexus:authored-retired", retired);
    document.addEventListener("visibilitychange", visible);
    return () => { unsubscribe(); window.removeEventListener("nexus:authored-retired", retired); document.removeEventListener("visibilitychange", visible); queueMicrotask(() => { if (owner.current === current) store.close(); }); };
  }, [store]);
  return <Context value={store}>{children}</Context>;
}
export function useRecent() {
  const store = useContext(Context);
  if (!store) throw new Error("useRecent requires RecentProvider");
  const view = useSyncExternalStore(store.subscribe, store.value, store.value);
  return { ...view, read: store.read, use: store.use, useInitial: store.useInitial, reconcile: store.reconcile };
}
