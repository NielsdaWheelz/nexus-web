"use client";

import { useEffect, useRef } from "react";
import { getInstallationId } from "@/lib/workspace/deviceId";
import {
  getWorkspaceSession,
  isNonTrivialSession,
  prepareRestoredState,
  putWorkspaceSession,
  workspaceStatesEqual,
} from "@/lib/workspace/sessionSync";
import type { WorkspaceState } from "@/lib/workspace/schema";
import type { WorkspacePrimaryMetrics } from "@/lib/workspace/paneSizing";

const WORKSPACE_SESSION_SYNC_DEBOUNCE_MS = 1000;

export function useWorkspaceSession(
  state: WorkspaceState,
  mounted: boolean,
  applyRestoredState: (restored: WorkspaceState, urlIntent: WorkspaceState) => void,
  workspacePrimaryMetrics: WorkspacePrimaryMetrics,
): void {
  const captureArmedRef = useRef(false);
  const stateRef = useRef(state);
  const lastSavedRef = useRef(state);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  stateRef.current = state;

  // (1) RESTORE — on a cold open, fetch the last session and apply it
  // silently. Capture stays suspended until the fetch resolves, so the
  // default workspace cannot overwrite the saved session.
  useEffect(() => {
    if (!mounted) {
      return;
    }

    let cancelled = false;
    const baseline = stateRef.current;
    void (async () => {
      try {
        const { own, mostRecentElsewhere } = await getWorkspaceSession(
          getInstallationId()
        );
        if (cancelled) {
          return;
        }
        const ownState =
          own != null ? prepareRestoredState(own, workspacePrimaryMetrics) : null;
        const elsewhereState =
          mostRecentElsewhere != null
            ? prepareRestoredState(mostRecentElsewhere, workspacePrimaryMetrics)
            : null;
        const restored =
          ownState && isNonTrivialSession(ownState)
            ? ownState
            : elsewhereState && isNonTrivialSession(elsewhereState)
              ? elsewhereState
              : null;
        // Skip the restore if the user already changed the workspace while
        // the fetch was in flight.
        if (restored && workspaceStatesEqual(stateRef.current, baseline)) {
          applyRestoredState(restored, baseline);
        }
      } catch {
        // Network or parse failure — proceed without restoring.
      }
      if (!cancelled) {
        captureArmedRef.current = true;
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [mounted, applyRestoredState, workspacePrimaryMetrics]);

  // (2) CAPTURE — debounced PUT of the current state once capture is armed.
  useEffect(() => {
    if (!captureArmedRef.current) {
      return;
    }
    if (workspaceStatesEqual(state, lastSavedRef.current)) {
      return;
    }
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      const snapshot = stateRef.current;
      lastSavedRef.current = snapshot;
      void putWorkspaceSession(getInstallationId(), snapshot).catch(() => {});
    }, WORKSPACE_SESSION_SYNC_DEBOUNCE_MS);
  }, [state]);

  // (3) FLUSH — keepalive PUT of any pending write on page hide / background.
  useEffect(() => {
    const flush = () => {
      if (!captureArmedRef.current || !debounceRef.current) {
        return;
      }
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
      const snapshot = stateRef.current;
      lastSavedRef.current = snapshot;
      void putWorkspaceSession(getInstallationId(), snapshot, true);
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
