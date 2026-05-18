"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getInstallationId } from "@/lib/workspace/deviceId";
import {
  getWorkspaceSession,
  isColdOpen,
  isNonTrivialSession,
  prepareRestoredState,
  putWorkspaceSession,
  workspaceStatesEqual,
  type WorkspaceSessionOffer,
} from "@/lib/workspace/sessionSync";
import type { WorkspaceStateV4 } from "@/lib/workspace/schema";

const WORKSPACE_SESSION_SYNC_DEBOUNCE_MS = 1000;

export function useWorkspaceSession(
  state: WorkspaceStateV4,
  mounted: boolean,
  applyRestoredState: (state: WorkspaceStateV4) => void
): {
  restoreOffer: WorkspaceSessionOffer | null;
  reopenSession: () => void;
  dismissOffer: () => void;
} {
  const [restoreOffer, setRestoreOffer] = useState<WorkspaceSessionOffer | null>(
    null
  );
  const captureArmedRef = useRef(false);
  const stateRef = useRef(state);
  const lastSavedRef = useRef(state);
  const offerBaselineRef = useRef<WorkspaceStateV4 | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  stateRef.current = state;

  // (1) RESTORE — on cold open, fetch a session before arming capture.
  useEffect(() => {
    if (!mounted) {
      return;
    }
    if (!isColdOpen()) {
      captureArmedRef.current = true;
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const { own, mostRecentElsewhere } = await getWorkspaceSession(
          getInstallationId()
        );
        if (cancelled) {
          return;
        }
        const ownState = own != null ? prepareRestoredState(own) : null;
        if (ownState && isNonTrivialSession(ownState)) {
          offerBaselineRef.current = stateRef.current;
          setRestoreOffer({ source: "own", state: ownState });
          return;
        }
        const elsewhereState =
          mostRecentElsewhere != null
            ? prepareRestoredState(mostRecentElsewhere)
            : null;
        if (elsewhereState && isNonTrivialSession(elsewhereState)) {
          offerBaselineRef.current = stateRef.current;
          setRestoreOffer({ source: "other-device", state: elsewhereState });
          return;
        }
        captureArmedRef.current = true;
      } catch {
        if (!cancelled) {
          captureArmedRef.current = true;
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [mounted]);

  // (2) USER-MUTATION auto-dismiss — the user changed the workspace while an
  // offer was showing, so they have moved on.
  useEffect(() => {
    if (
      restoreOffer &&
      offerBaselineRef.current &&
      !workspaceStatesEqual(state, offerBaselineRef.current)
    ) {
      setRestoreOffer(null);
      captureArmedRef.current = true;
    }
  }, [state, restoreOffer]);

  // (3) CAPTURE — debounced PUT of the current state once capture is armed.
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

  // (4) FLUSH — keepalive PUT of any pending write on page hide / background.
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

  const reopenSession = useCallback(() => {
    if (!restoreOffer) {
      return;
    }
    applyRestoredState(restoreOffer.state);
    captureArmedRef.current = true;
    setRestoreOffer(null);
  }, [restoreOffer, applyRestoredState]);

  const dismissOffer = useCallback(() => {
    captureArmedRef.current = true;
    setRestoreOffer(null);
  }, []);

  return { restoreOffer, reopenSession, dismissOffer };
}
