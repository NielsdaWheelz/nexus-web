"use client";
/** Local workspace metadata saves independently of remote credentials. The cloud mirror
 * is best effort: a local failure alone presents. A 5xx of any code leaves the state unsaved,
 * so the next change, hide or admission generation sends it again; nothing resends on a clock.
 * A modeled refusal is dropped, and any other defect throws to the boundary. */
import { useEffect, useState } from "react";
import { Hold } from "@/components/feedback/Feedback";
import { apiFetch, isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { isAbortError } from "@/lib/errors";
import { useAuthenticatedAccount } from "@/lib/account/authenticatedAccount";
import { installedApp, remoteReady } from "@/lib/native/admission";
import { useRemoteGeneration } from "@/lib/native/admissionHooks";
import { useDeviceWorkspace } from "@/lib/native/workspaceContext";
import { useDeviceWorkspaceSave } from "@/lib/native/workspaceSave";
import { saveBrowserWorkspace } from "@/lib/authored/binding";
import type { WorkspaceState } from "./model";
import type { WorkspaceStore } from "./store";
export function useWorkspaceSession(store: WorkspaceStore) {
  const account = useAuthenticatedAccount();
  const local = useDeviceWorkspace();
  const nativeFailure = useDeviceWorkspaceSave(store, local);
  const generation = useRemoteGeneration();
  const [failure, setFailure] = useState<{ retry(): void; busy: boolean; attempt: number } | null>(null);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  if (defect !== null) throw defect.error;
  useEffect(() => {
    let live = true;
    let saved: WorkspaceState | null = null;
    let sending = false;
    let again = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const save = async () => {
      clearTimeout(timer);
      if (!live) return;
      if (sending) { again = true; return; }
      const state = store.value().state;
      if (state === saved) return;
      sending = true;
      setFailure(previous => previous ? { ...previous, busy: true } : null);
      let localSaved = installedApp;
      try {
        if (!installedApp) { await saveBrowserWorkspace(account.accountId, state); localSaved = true; }
        if (remoteReady() && navigator.onLine) await apiFetch<void>("/api/me/workspace-session", { method: "PUT", body: JSON.stringify(state) });
        saved = state;
        if (live) setFailure(null);
      } catch (error) {
        if (localSaved) {
          if (isApiError(error) ? isSameSystemApiDefect(error) && error.status < 500 : !isAbortError(error)) setDefect({ error });
          if (!isApiError(error) || error.status < 500) saved = state;
          if (live) setFailure(null);
        } else if (live) setFailure(previous => ({ retry: () => { void save(); }, busy: false, attempt: previous === null ? 0 : previous.attempt + 1 }));
      } finally {
        sending = false;
        if (live && again) { again = false; void save(); }
      }
    };
    const schedule = () => { clearTimeout(timer); timer = setTimeout(() => { void save(); }, 200); };
    const unsubscribe = store.subscribe(schedule);
    schedule();
    const hidden = () => { if (document.visibilityState === "hidden") void save(); };
    const flush = () => { void save(); };
    window.addEventListener("pagehide", flush); document.addEventListener("visibilitychange", hidden);
    return () => { live = false; clearTimeout(timer); unsubscribe(); window.removeEventListener("pagehide", flush); document.removeEventListener("visibilitychange", hidden); };
  }, [account.accountId, generation, store]);
  return <>{nativeFailure}{failure ? <Hold id="workspace-session" attempt={failure.attempt}
    line={{ fact: "workspace changes aren’t saved on this device.", reason: "this tab still has them." }}
    verbs={[{ label: "retry", commandKey: "retry workspace save", run: failure.retry, busy: failure.busy }]} /> : null}</>;
}
