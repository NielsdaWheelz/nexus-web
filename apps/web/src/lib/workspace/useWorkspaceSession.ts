"use client";

// Saves this device's workspace 1 s after the last change, and when the page
// hides with keepalive while the body fits its 64 KiB budget (else as an
// ordinary request). One request at a time; a newer state always follows and
// a success acknowledges exactly the state sent. Transport failures keep a
// Retry notice up; a stale build (426) keeps the update notice up and the
// workspace with it; anything else is a defect for the workspace boundary.
// Hosted HTTP saves own workspace durability (Write). In the installed app,
// useDeviceWorkspaceSave owns that durability (Write); this best-effort cloud
// mirror reports Status and never claims that the current local save completed.
import { installedApp, remoteReady } from "@/lib/native/admission";
import { useRemoteGeneration } from "@/lib/native/admissionHooks";
import { useDeviceWorkspace } from "@/lib/native/workspaceContext";
import { useDeviceWorkspaceSave } from "@/lib/native/workspaceSave";
import { useEffect, useState } from "react";
import { useWorkspaceCondition, type FeedbackContent } from "@/components/feedback/Feedback";
import {
  apiFetch,
  apiTransportFeedback,
  isApiError,
  isStaleBuild,
} from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import type { WorkspaceState } from "@/lib/workspace/model";
import type { WorkspaceStore } from "@/lib/workspace/store";
import { findPaneChromeFocusTarget, findPaneLandmarkFocusTarget } from "@/lib/workspace/paneDom";

const NOTICE = "workspace-session-save";
const TITLE = installedApp ? "workspace cloud copy not confirmed" : "workspace changes not confirmed";

export function useWorkspaceSession(store: WorkspaceStore): void {
  const local = useDeviceWorkspace();
  useDeviceWorkspaceSave(store, local);
  const generation = useRemoteGeneration();
  const [notice, setNotice] = useState<{
    content: FeedbackContent;
    stale: boolean;
    busy: boolean;
    retry: () => void;
  } | null>(null);
  useWorkspaceCondition(NOTICE, notice ? {
    priority: installedApp ? "Status" : "Write",
    content: notice.content,
    announcement: "Polite",
    actions: notice.stale && installedApp ? undefined : [{
      label: notice.stale ? "reload app" : installedApp ? "retry cloud copy" : "retry save",
      busy: notice.busy,
      onClick: notice.stale ? () => window.location.reload() : notice.retry,
    }],
    returnFocus: () => {
      const paneId = store.value().state.active_primary_pane_id;
      return findPaneLandmarkFocusTarget(paneId) ?? findPaneChromeFocusTarget(paneId);
    },
  } : null);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  useEffect(() => {
    let saved: WorkspaceState | null = null; // the initial state counts as unsaved
    let sending: WorkspaceState | null = null;
    let again: boolean | null = null; // asked while sending (keepalive if any asked)
    let scheduled: WorkspaceState | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let live = true;
    const save = (keepalive = false): void => {
      clearTimeout(timer);
      if (!live || !remoteReady()) return;
      const { state } = store.value();
      if (sending) {
        if (state !== sending) again = keepalive || again === true;
        return;
      }
      if (state === saved) return setNotice(null);
      sending = state;
      setNotice((current) => current && !current.stale ? { ...current, busy: true } : current);
      const body = JSON.stringify(state);
      apiFetch<void>("/api/me/workspace-session", {
        method: "PUT",
        body,
        keepalive: keepalive && new Blob([body]).size <= 64 * 1024,
      })
        .then(() => {
          saved = state;
          if (live && store.value().state === state) setNotice(null);
        })
        .catch((error: unknown) => {
          if (!live || handleUnauthenticatedApiError(error)) return;
          // Common transport/admission failures retain this mirror and its
          // independent native local save owner.
          const transport = isApiError(error) && apiTransportFeedback(error, TITLE);
          if (transport) {
            return setNotice({ content: transport, stale: isStaleBuild(error), busy: false, retry: save });
          }
          if (!isApiError(error) || error.code !== "E_AUTH_UNAVAILABLE") {
            live = false;
            return setDefect({ error });
          }
          setNotice({
            content: {
              tone: "Warning",
              title: TITLE,
              message: installedApp
                ? "retry updates the cloud copy. saving on this device is reported separately."
                : "your changes remain in this tab. retry saves the latest workspace.",
              requestId: error.requestId,
            },
            stale: false,
            busy: false,
            retry: save,
          });
        })
        .finally(() => {
          sending = null;
          if (live) setNotice((current) => current?.busy ? { ...current, busy: false } : current);
          const keepaliveAgain = again;
          again = null;
          if (live && keepaliveAgain !== null) save(keepaliveAgain);
        });
    };
    // The 1 s timer re-arms only when the state itself changes.
    const schedule = () => {
      const { state } = store.value();
      if (state === scheduled) return;
      scheduled = state;
      clearTimeout(timer);
      if (state !== saved) timer = setTimeout(save, 1000);
    };
    const flush = () => save(true);
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    const unsubscribe = store.subscribe(schedule);
    schedule();
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      live = false;
      clearTimeout(timer);
      unsubscribe();
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [store, generation]);
  if (defect) throw defect.error;
}
