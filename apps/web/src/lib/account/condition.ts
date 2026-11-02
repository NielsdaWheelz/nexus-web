"use client";
/** The account's one standing condition: a total order over admission, sync status, local
 * writing, the sync failure, connectivity and the shell update. Only `Update`, `SignIn`,
 * `Refused` and `SyncLocal` ask a person for anything; `Lagging` and `Offline` heal. A failed
 * commit that has not stopped is no condition: its owner speaks. Must render inside an open
 * authored account. */
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { SyncFailure, SyncStatus } from "@nexus/authored/types";
import { useAuthoredAccountId, useAuthoredStore } from "@/lib/authored/provider";
import { observeShellUpdate } from "@/lib/authored/shell";
import { LAGGING_AFTER_MS } from "@/lib/authored/status";
import { installedApp } from "@/lib/native/admission";
import { useRemoteAdmission } from "@/lib/native/admissionHooks";
import type { RemoteAdmission } from "@/lib/native/contracts";
import { getWritingRuntime, writingStoreStopped } from "@/lib/notes/runtime";
import { useConnectivity } from "@/lib/renderEnvironment/connectivity";

export type Condition = "Stopped" | "SyncLocal" | "Update" | "SignIn" | "Refused" | "Lagging" | "UpdateReady" | "Offline";

interface Facts {
  readonly admission: RemoteAdmission;
  readonly status: SyncStatus;
  readonly failure: SyncFailure;
  readonly writing: { readonly saving: boolean; readonly error: unknown | null };
  readonly online: boolean;
  readonly updateWaiting: boolean;
}

function conditionOf({ admission, status, failure, writing, online, updateWaiting }: Facts, now: number): Condition | null {
  if (writing.error !== null && writingStoreStopped(writing.error)) return "Stopped";
  if (status === "local_error" && writing.error === null && !writing.saving) return "SyncLocal";
  if (admission === "UpdateRequired" || status === "update_required") return "Update";
  if (admission === "SignInRequired" || status === "sign_in_required") return "SignIn";
  if (failure?.kind === "Refused") return "Refused";
  if (failure?.kind === "Retrying" && now - failure.since >= LAGGING_AFTER_MS) return "Lagging";
  if (updateWaiting) return "UpdateReady";
  if (!online) return "Offline";
  return null;
}

export function useCondition(): Condition | null {
  const store = useAuthoredStore();
  const accountId = useAuthoredAccountId();
  const runtime = useMemo(() => getWritingRuntime(accountId), [accountId]);
  const writing = useSyncExternalStore(runtime.subscribe, runtime.snapshot, runtime.snapshot);
  const admission = useRemoteAdmission();
  const online = useConnectivity() === "Online";
  const [sync, setSync] = useState<{ status: SyncStatus; failure: SyncFailure }>({ status: "preparing", failure: null });
  useEffect(() => store.sync_status((status, _detail, failure) => setSync({ status, failure })), [store]);
  const [updateWaiting, setUpdateWaiting] = useState(false);
  useEffect(() => {
    if (installedApp || !("serviceWorker" in navigator)) return;
    return observeShellUpdate(setUpdateWaiting);
  }, []);
  const [now, setNow] = useState(Date.now);
  const lagsAt = sync.failure?.kind === "Retrying" ? sync.failure.since + LAGGING_AFTER_MS : null;
  useEffect(() => {
    if (lagsAt === null) return;
    const timer = setTimeout(() => setNow(lagsAt), lagsAt - Date.now());
    return () => clearTimeout(timer);
  }, [lagsAt]);
  return conditionOf({ admission, status: sync.status, failure: sync.failure, writing, online, updateWaiting }, now);
}
