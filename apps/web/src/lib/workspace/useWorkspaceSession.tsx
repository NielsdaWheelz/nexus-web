"use client";
/** Local workspace metadata saves independently of remote credentials. The
 * cloud mirror remains best effort; its failures never veto authored commits. */
import { useEffect, useState } from "react";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import { apiFetch, isApiError } from "@/lib/api/client";
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
  const [failure, setFailure] = useState<{ local: boolean; retry(): void } | null>(null);
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
      let localSaved = installedApp;
      try {
        if (!installedApp) { await saveBrowserWorkspace(account.accountId, state); localSaved = true; }
        if (remoteReady() && navigator.onLine) await apiFetch<void>("/api/me/workspace-session", { method: "PUT", body: JSON.stringify(state) });
        saved = state;
        if (live) setFailure(null);
      } catch (error) {
        if (localSaved && isApiError(error) && [0, 401, 426].includes(error.status)) { saved = state; if (live) setFailure(null); }
        else if (live) setFailure({ local: !localSaved, retry: () => { void save(); } });
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
  return <>{nativeFailure}{failure ? <FeedbackNotice announcement="Polite" content={{ tone: "Warning", title: failure.local ? "workspace changes weren’t saved on this device" : "workspace cloud copy couldn’t be updated", message: failure.local ? "keep this page open and retry." : "your workspace remains saved on this device." }} actions={[{ label: "retry", onClick: failure.retry }]} /> : null}</>;
}
