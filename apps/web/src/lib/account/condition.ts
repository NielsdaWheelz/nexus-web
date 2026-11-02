"use client";
/** The account's one standing condition: a total order over admission, sync status, local
 * writing, the sync failure, connectivity and a waiting shell update. Only `Update`, `SignIn`,
 * `Refused` and `SyncLocal` ask a person for anything; `Lagging` and `Offline` heal. A failed
 * commit that has not stopped is no condition: its owner speaks. Each condition has one sentence,
 * which its account row and its slip both say. Must render inside an open authored account. */
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { SyncFailure, SyncStatus } from "@nexus/authored/types";
import { staleBuild } from "@/lib/api/failure";
import { useAuthoredAccountId, useAuthoredStore } from "@/lib/authored/provider";
import { LAGGING_AFTER_MS } from "@/lib/authored/status";
import { subscribeAdmission, updateWaiting } from "@/lib/native/admission";
import { useRemoteAdmission } from "@/lib/native/admissionHooks";
import type { RemoteAdmission } from "@/lib/native/contracts";
import { getWritingRuntime, writingStoreStopped } from "@/lib/notes/runtime";
import { useConnectivity } from "@/lib/renderEnvironment/connectivity";

export type Condition = "Stopped" | "SyncLocal" | "Update" | "SignIn" | "Refused" | "Lagging" | "UpdateReady" | "Offline";
/** The attention dot's shape: solid asks a person to open the account, hollow heals by itself. */
export type Mark = "Solid" | "Hollow";
export const MARK: Readonly<Record<Condition, Mark>> = {
  Stopped: "Solid", SyncLocal: "Solid", Update: "Solid", SignIn: "Solid", Refused: "Solid",
  Lagging: "Hollow", UpdateReady: "Solid", Offline: "Hollow",
};

interface Facts {
  readonly admission: RemoteAdmission;
  readonly status: SyncStatus;
  readonly failure: SyncFailure;
  readonly lagging: boolean;
  readonly writing: { readonly saving: boolean; readonly error: unknown | null };
  readonly online: boolean;
  readonly updateWaiting: boolean;
}

function conditionOf({ admission, status, failure, lagging, writing, online, updateWaiting }: Facts): Condition | null {
  if (writing.error !== null && writingStoreStopped(writing.error)) return "Stopped";
  if (status === "local_error" && writing.error === null && !writing.saving) return "SyncLocal";
  if (admission === "UpdateRequired" || status === "update_required") return "Update";
  if (admission === "SignInRequired" || status === "sign_in_required") return "SignIn";
  if (failure?.kind === "Refused") return "Refused";
  if (lagging) return "Lagging";
  if (updateWaiting) return "UpdateReady";
  if (!online) return "Offline";
  return null;
}

/** Whether a `Retrying` failure has held for `LAGGING_AFTER_MS`. Its own timer flips it, so it
 * holds even while nothing else renders. */
export function useLagging(failure: SyncFailure): boolean {
  const lagsAt = failure?.kind === "Retrying" ? failure.since + LAGGING_AFTER_MS : null;
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (lagsAt === null) return;
    const timer = setTimeout(() => setNow(lagsAt), lagsAt - Date.now());
    return () => clearTimeout(timer);
  }, [lagsAt]);
  return lagsAt !== null && now >= lagsAt;
}

export function useCondition(): Condition | null {
  const store = useAuthoredStore();
  const accountId = useAuthoredAccountId();
  const runtime = useMemo(() => getWritingRuntime(accountId), [accountId]);
  const writing = useSyncExternalStore(runtime.subscribe, runtime.snapshot, runtime.snapshot);
  const admission = useRemoteAdmission();
  const online = useConnectivity() === "Online";
  const waiting = useSyncExternalStore(subscribeAdmission, updateWaiting, updateWaiting);
  const [sync, setSync] = useState<{ status: SyncStatus; failure: SyncFailure }>({ status: "preparing", failure: null });
  useEffect(() => store.sync_status((status, _detail, failure) => setSync({ status, failure })), [store]);
  const lagging = useLagging(sync.failure);
  return conditionOf({ admission, status: sync.status, failure: sync.failure, lagging, writing, online, updateWaiting: waiting });
}

/** A condition's one sentence. `Update` reads the remedy now, so a caller re-reads it on
 * `subscribeAdmission`. While a commit has failed, no line claims the writing is kept. */
export function conditionLine(condition: Condition, commitFailed: boolean): { readonly fact: string; readonly reason?: string } {
  const kept = (fact: string, reason: string) => commitFailed ? { fact } : { fact, reason };
  switch (condition) {
    case "Stopped": return { fact: "local notes stopped." };
    case "SyncLocal": return { fact: "notes can’t sync here." };
    case "Update": return { fact: staleBuild() };
    case "SignIn": return { fact: "sign in to keep syncing." };
    case "Refused": return kept("notes can’t sync.", "they’re safe on this device.");
    case "Lagging": return kept("notes aren’t syncing.", "they’re safe on this device.");
    case "UpdateReady": return { fact: "app update ready.", reason: "finish writing, then close all nexus tabs and reopen." };
    case "Offline": return kept("you’re offline.", "changes stay on this device.");
  }
}
