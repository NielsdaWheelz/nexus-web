"use client";

import { useEffect, useRef } from "react";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { putWorkspaceSession } from "@/lib/workspace/sessionSync";
import { workspaceStatesEqual } from "@/lib/workspace/workspaceRestore";
import type { WorkspaceState } from "@/lib/workspace/schema";

const WORKSPACE_SESSION_SYNC_DEBOUNCE_MS = 1000;

// Persist workspace changes after mount. Restore is server-side now (the store is seeded
// with the restored state, see store.tsx + bootstrap.server.ts), so there is no fetch and
// no restore phase here — only capture (debounced PUT) and flush (keepalive on page hide).
export function useWorkspaceSession(state: WorkspaceState, mounted: boolean): void {
  const stateRef = useRef(state);
  const lastSavedRef = useRef(state);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  stateRef.current = state;

  // CAPTURE — debounced PUT of the current state. lastSavedRef starts at the seeded
  // (server-restored) state, so seeding never triggers a write; only real edits do.
  useEffect(() => {
    if (!mounted) {
      return;
    }
    if (workspaceStatesEqual(state, lastSavedRef.current)) {
      return;
    }
    const timer = setTimeout(() => {
      debounceRef.current = null;
      const snapshot = stateRef.current;
      lastSavedRef.current = snapshot;
      void putWorkspaceSession(snapshot).catch((error) => {
        handleUnauthenticatedApiError(error);
      });
    }, WORKSPACE_SESSION_SYNC_DEBOUNCE_MS);
    debounceRef.current = timer;
    return () => {
      // An obsolete capture cannot write after its host or state is replaced.
      // Page hide flushes explicitly while this lifecycle still owns the state.
      clearTimeout(timer);
      if (debounceRef.current === timer) {
        debounceRef.current = null;
      }
    };
  }, [mounted, state]);

  // FLUSH — keepalive PUT of any pending write on page hide / background.
  useEffect(() => {
    const flush = () => {
      if (!debounceRef.current) {
        return;
      }
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
      const snapshot = stateRef.current;
      lastSavedRef.current = snapshot;
      void putWorkspaceSession(snapshot, true);
    };
    const flushOnVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        flush();
      }
    };

    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", flushOnVisibilityChange);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", flushOnVisibilityChange);
    };
  }, []);
}
