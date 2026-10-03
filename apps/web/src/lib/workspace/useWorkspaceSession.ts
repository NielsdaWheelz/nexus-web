"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useFeedback } from "@/components/feedback/Feedback";
import { isApiError } from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { putWorkspaceSession } from "@/lib/workspace/sessionSync";
import type { WorkspaceState } from "@/lib/workspace/schema";

const WORKSPACE_SESSION_SYNC_DEBOUNCE_MS = 1000;
const WORKSPACE_SESSION_SAVE_FEEDBACK_KEY = "workspace-session-save";

export function useWorkspaceSession(
  state: WorkspaceState,
  mounted: boolean,
  persistInitialState: boolean,
): void {
  const { publish, resolve } = useFeedback();
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const stateRef = useRef(state);
  const acknowledgedRef = useRef<WorkspaceState | null>(
    persistInitialState ? null : state,
  );
  const inFlightRef = useRef<WorkspaceState | null>(null);
  const pendingKeepaliveRef = useRef<boolean | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeRef = useRef(false);
  stateRef.current = state;

  const save = useCallback(
    function save(keepalive = false): void {
      if (!activeRef.current) return;
      if (debounceRef.current !== null) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      const snapshot = stateRef.current;
      if (inFlightRef.current !== null) {
        if (snapshot !== inFlightRef.current) {
          pendingKeepaliveRef.current =
            keepalive || pendingKeepaliveRef.current === true;
        }
        return;
      }
      if (snapshot === acknowledgedRef.current) {
        resolve(WORKSPACE_SESSION_SAVE_FEEDBACK_KEY);
        return;
      }
      inFlightRef.current = snapshot;
      void (async () => {
        try {
          await putWorkspaceSession(snapshot, keepalive);
          if (!activeRef.current) return;
          acknowledgedRef.current = snapshot;
          if (stateRef.current === snapshot)
            resolve(WORKSPACE_SESSION_SAVE_FEEDBACK_KEY);
        } catch (error) {
          if (!activeRef.current) return;
          const unauthenticated = handleUnauthenticatedApiError(error);
          if (
            !unauthenticated &&
            isApiError(error) &&
            (error.code === "E_NETWORK" ||
              error.code === "E_UPSTREAM" ||
              error.code === "E_UPSTREAM_TIMEOUT" ||
              error.code === "E_AUTH_UNAVAILABLE")
          ) {
            publish({
              kind: "Persistent",
              key: WORKSPACE_SESSION_SAVE_FEEDBACK_KEY,
              content: {
                tone: "Danger",
                title: "Workspace save wasn’t confirmed",
                message: "Retry to save your latest workspace changes.",
                requestId: error.requestId,
              },
              announcement: "Assertive",
              actions: [{ label: "Retry", onClick: () => save() }],
            });
          } else {
            activeRef.current = false;
            pendingKeepaliveRef.current = null;
            if (debounceRef.current !== null) clearTimeout(debounceRef.current);
            debounceRef.current = null;
            resolve(WORKSPACE_SESSION_SAVE_FEEDBACK_KEY);
            // justify-defect: unexpected failures and invalid owned saves are not delivery errors.
            if (!unauthenticated) setDefect({ error });
          }
        } finally {
          inFlightRef.current = null;
          const pendingKeepalive = pendingKeepaliveRef.current;
          pendingKeepaliveRef.current = null;
          if (activeRef.current && pendingKeepalive !== null)
            save(pendingKeepalive);
        }
      })();
    },
    [publish, resolve],
  );

  useEffect(() => {
    activeRef.current = true;
    const flush = () => save(true);
    const flushOnVisibilityChange = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", flushOnVisibilityChange);
    return () => {
      activeRef.current = false;
      pendingKeepaliveRef.current = null;
      if (debounceRef.current !== null) clearTimeout(debounceRef.current);
      debounceRef.current = null;
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", flushOnVisibilityChange);
      resolve(WORKSPACE_SESSION_SAVE_FEEDBACK_KEY);
    };
  }, [save, resolve]);

  useEffect(() => {
    if (!mounted || state === acknowledgedRef.current) return;
    const timer = setTimeout(() => {
      debounceRef.current = null;
      save();
    }, WORKSPACE_SESSION_SYNC_DEBOUNCE_MS);
    debounceRef.current = timer;
    return () => {
      clearTimeout(timer);
      if (debounceRef.current === timer) debounceRef.current = null;
    };
  }, [mounted, state, save]);

  if (defect !== null) throw defect.error;
}
