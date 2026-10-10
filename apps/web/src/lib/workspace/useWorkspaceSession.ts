"use client";

// Saves this device's workspace 1 s after the last change, and with keepalive
// when the page hides. One request at a time; a newer state always follows and
// a success acknowledges exactly the state sent. Transport failures keep a
// Retry notice up; anything else is a defect for the workspace boundary.
import { useEffect, useState } from "react";
import { useFeedback } from "@/components/feedback/Feedback";
import { apiCommand204, isApiError } from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import type { WorkspaceState } from "@/lib/workspace/model";
import type { WorkspaceStore } from "@/lib/workspace/store";

const NOTICE = "workspace-session-save";
const TRANSPORT = [
  "E_NETWORK",
  "E_UPSTREAM",
  "E_UPSTREAM_TIMEOUT",
  "E_AUTH_UNAVAILABLE",
];

export function useWorkspaceSession(store: WorkspaceStore): void {
  const { publish, resolve } = useFeedback();
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
      if (!live) return;
      const { state } = store.value();
      if (sending) {
        if (state !== sending) again = keepalive || again === true;
        return;
      }
      if (state === saved) return resolve(NOTICE);
      sending = state;
      apiCommand204("/api/me/workspace-session", {
        method: "PUT",
        body: JSON.stringify(state),
        keepalive,
      })
        .then(() => {
          saved = state;
          if (live && store.value().state === state) resolve(NOTICE);
        })
        .catch((error: unknown) => {
          if (!live || handleUnauthenticatedApiError(error)) return;
          if (!isApiError(error) || !TRANSPORT.includes(error.code)) {
            live = false;
            return setDefect({ error });
          }
          publish({
            kind: "Persistent",
            key: NOTICE,
            content: {
              tone: "Danger",
              title: "Workspace save wasn’t confirmed",
              message: "Retry to save your latest workspace changes.",
              requestId: error.requestId,
            },
            announcement: "Assertive",
            actions: [{ label: "Retry", onClick: () => save() }],
          });
        })
        .finally(() => {
          sending = null;
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
      resolve(NOTICE);
    };
  }, [store, publish, resolve]);
  if (defect) throw defect.error;
}
