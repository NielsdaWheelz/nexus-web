"use client";

import { useEffect, useRef, useState } from "react";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { useAndroidShell } from "@/lib/renderEnvironment/provider";
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
  applyRestoredState: (
    restored: WorkspaceState,
    deepLinkIntent: WorkspaceState,
  ) => WorkspaceState,
  workspacePrimaryMetrics: WorkspacePrimaryMetrics,
): void {
  const androidShell = useAndroidShell();
  const [captureArmed, setCaptureArmed] = useState(false);
  const captureArmedRef = useRef(false);
  const restoreStartedRef = useRef(false);
  const stateRef = useRef(state);
  const lastSavedRef = useRef(state);
  const applyRestoredStateRef = useRef(applyRestoredState);
  const workspacePrimaryMetricsRef = useRef(workspacePrimaryMetrics);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  stateRef.current = state;
  applyRestoredStateRef.current = applyRestoredState;
  workspacePrimaryMetricsRef.current = workspacePrimaryMetrics;

  // (1) RESTORE — fetch the last session after mount and merge it with the
  // current deep-link intent. Capture stays suspended until the fetch resolves,
  // so the initial workspace cannot overwrite the saved session.
  useEffect(() => {
    if (!mounted || restoreStartedRef.current) {
      return;
    }
    restoreStartedRef.current = true;

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
        const metrics = workspacePrimaryMetricsRef.current;
        const ownState =
          own != null ? prepareRestoredState(own, metrics, androidShell) : null;
        const elsewhereState =
          mostRecentElsewhere != null
            ? prepareRestoredState(mostRecentElsewhere, metrics, androidShell)
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
          lastSavedRef.current = applyRestoredStateRef.current(restored, baseline);
        }
      } catch (error) {
        if (handleUnauthenticatedApiError(error)) return;
        // Network or parse failure — proceed without restoring.
      }
      if (!cancelled) {
        captureArmedRef.current = true;
        setCaptureArmed(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [androidShell, mounted]);

  // (2) CAPTURE — debounced PUT of the current state once capture is armed.
  useEffect(() => {
    if (!captureArmed) {
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
      void putWorkspaceSession(getInstallationId(), snapshot).catch((error) => {
        handleUnauthenticatedApiError(error);
      });
    }, WORKSPACE_SESSION_SYNC_DEBOUNCE_MS);
  }, [captureArmed, state]);

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
