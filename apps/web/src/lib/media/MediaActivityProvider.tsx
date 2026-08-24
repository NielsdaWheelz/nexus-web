"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { FeedbackContent } from "@/components/feedback/Feedback";
import { useUnauthenticatedApiHandler } from "@/lib/auth/UnauthenticatedApiBoundary";
import { isAbortError } from "@/lib/errors";
import {
  libraryPlacementUnknownSince,
  useLibraryPlacementRevision,
} from "@/lib/libraries/placementRevision";
import {
  fetchMediaActivity,
  publishMediaActivityInvalidation,
  repairMediaActivity,
  subscribeMediaActivityInvalidations,
  type MediaActivityResponse,
  type MediaRepairScope,
} from "@/lib/media/activityClient";
import {
  removeUploadSession as removeUploadSessionRequest,
  retryUploadSession as retryUploadSessionRequest,
} from "@/lib/media/ingestionClient";
import {
  mediaActivityPollingExpired,
  mediaActivityPollingSchedule,
  type MediaActivityPollingSchedule,
} from "@/lib/media/activityPolling";
import { mediaActivityLoadErrorMessage } from "@/lib/status/mediaActivity";
import { useIntervalPoll } from "@/lib/useIntervalPoll";

const ACTIVITY_POLL_INTERVAL_MS =
  mediaActivityPollingSchedule(0).pollIntervalMs;

type ActivityLoadState =
  | { readonly kind: "Loading" }
  | { readonly kind: "Ready" }
  | { readonly kind: "Failed"; readonly content: FeedbackContent };

interface MediaActivityContextValue {
  readonly snapshot: MediaActivityResponse | null;
  readonly loadState: ActivityLoadState;
  readonly refreshing: boolean;
  readonly activityOpen: boolean;
  readonly automaticRefreshEnded: boolean;
  beginActivityOpening(): void;
  endActivityOpening(): void;
  refreshActivity(): Promise<void>;
  repairActivity(mediaId: string, scope: MediaRepairScope): Promise<void>;
  retryUploadSession(sessionHandle: string, file: File): Promise<void>;
  removeUploadSession(sessionHandle: string): Promise<void>;
}

interface PollingWindow {
  readonly id: number;
  readonly schedule: MediaActivityPollingSchedule;
}

interface PendingRead {
  readonly pollingWindowId: number;
  readonly automatic: boolean;
}

const MediaActivityContext = createContext<MediaActivityContextValue | null>(
  null,
);

export function MediaActivityProvider({ children }: { children: ReactNode }) {
  const handleUnauthenticated = useUnauthenticatedApiHandler();
  const placementChange = useLibraryPlacementRevision();
  const [snapshot, setSnapshot] = useState<MediaActivityResponse | null>(null);
  const [loadState, setLoadState] = useState<ActivityLoadState>({
    kind: "Loading",
  });
  const [refreshing, setRefreshing] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [automaticRefreshEnded, setAutomaticRefreshEnded] = useState(false);
  const [pollingWindow, setPollingWindow] = useState<PollingWindow | null>(null);
  const [defect, setDefect] = useState<{ readonly error: unknown } | null>(null);
  // Child visibility effects run before this provider's mount effect. The
  // provider exists for that commit, so its first visible/open signal must be
  // allowed to start the canonical read immediately.
  const mountedRef = useRef(true);
  const activeCountRef = useRef(0);
  const inFlightRef = useRef<Promise<void> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const dirtyReadRef = useRef<PendingRead | null>(null);
  const readRequestedRef = useRef(false);
  const pollingWindowRef = useRef<PollingWindow | null>(null);
  const nextPollingWindowIdRef = useRef(0);
  const observedPlacementRevisionRef = useRef(placementChange.revision);
  const windowFocusedRef = useRef(true);

  const startPollingWindow = useCallback((): PollingWindow => {
    const next = {
      id: nextPollingWindowIdRef.current + 1,
      schedule: mediaActivityPollingSchedule(Date.now()),
    };
    nextPollingWindowIdRef.current = next.id;
    pollingWindowRef.current = next;
    setPollingWindow(next);
    setAutomaticRefreshEnded(false);
    return next;
  }, []);

  const endPollingWindow = useCallback(
    (pollingWindowId: number, announceEnded: boolean): void => {
      if (pollingWindowRef.current?.id !== pollingWindowId) return;
      pollingWindowRef.current = null;
      setPollingWindow(null);
      setAutomaticRefreshEnded(
        announceEnded && activeCountRef.current > 0,
      );
    },
    [],
  );

  const requestRead = useCallback(
    ({ pollingWindowId, automatic }: PendingRead, dirtyIfBusy: boolean) => {
      readRequestedRef.current = true;
      if (inFlightRef.current !== null) {
        if (dirtyIfBusy) {
          dirtyReadRef.current = { pollingWindowId, automatic: false };
        }
        return inFlightRef.current;
      }

      const request = (async () => {
        let pending: PendingRead | null = { pollingWindowId, automatic };
        while (pending !== null && mountedRef.current) {
          const current: PendingRead = pending;
          dirtyReadRef.current = null;
          const controller = new AbortController();
          abortRef.current = controller;
          try {
            const next = await fetchMediaActivity(controller.signal);
            if (!mountedRef.current || controller.signal.aborted) break;
            activeCountRef.current = next.activeCount;
            setSnapshot(next);
            setLoadState({ kind: "Ready" });
            if (next.activeCount === 0) {
              setAutomaticRefreshEnded(false);
              endPollingWindow(current.pollingWindowId, false);
            }
          } catch (error: unknown) {
            if (!controller.signal.aborted && !isAbortError(error)) {
              if (!handleUnauthenticated(error)) {
                try {
                  const content = mediaActivityLoadErrorMessage(error);
                  if (mountedRef.current) {
                    setLoadState({ kind: "Failed", content });
                  }
                } catch (caughtDefect: unknown) {
                  if (mountedRef.current) {
                    setDefect({ error: caughtDefect });
                  }
                }
              }
              if (current.automatic) {
                endPollingWindow(current.pollingWindowId, true);
              }
            }
          } finally {
            if (abortRef.current === controller) abortRef.current = null;
          }

          if (!mountedRef.current) break;
          pending = dirtyReadRef.current;
        }
      })().finally(() => {
        if (inFlightRef.current === request) inFlightRef.current = null;
        if (mountedRef.current) setRefreshing(false);
      });
      inFlightRef.current = request;
      setRefreshing(true);
      return request;
    },
    [endPollingWindow, handleUnauthenticated],
  );

  const invalidateActivity = useCallback((): Promise<void> => {
    const window = startPollingWindow();
    return requestRead(
      { pollingWindowId: window.id, automatic: false },
      true,
    );
  }, [requestRead, startPollingWindow]);

  const refreshActivity = useCallback((): Promise<void> => {
    const window = startPollingWindow();
    return requestRead(
      { pollingWindowId: window.id, automatic: false },
      true,
    );
  }, [requestRead, startPollingWindow]);

  const repairActivity = useCallback(
    async (mediaId: string, scope: MediaRepairScope): Promise<void> => {
      try {
        await repairMediaActivity(mediaId, scope);
      } catch (error) {
        if (handleUnauthenticated(error)) return;
        throw error;
      }
      publishMediaActivityInvalidation();
      await (inFlightRef.current ?? refreshActivity());
    },
    [handleUnauthenticated, refreshActivity],
  );

  const retryUploadSession = useCallback(
    async (sessionHandle: string, file: File): Promise<void> => {
      try {
        await retryUploadSessionRequest(sessionHandle, file);
      } catch (error) {
        if (handleUnauthenticated(error)) return;
        throw error;
      }
      await (inFlightRef.current ?? refreshActivity());
    },
    [handleUnauthenticated, refreshActivity],
  );

  const removeUploadSession = useCallback(
    async (sessionHandle: string): Promise<void> => {
      try {
        await removeUploadSessionRequest(sessionHandle);
      } catch (error) {
        if (handleUnauthenticated(error)) return;
        throw error;
      }
      await (inFlightRef.current ?? refreshActivity());
    },
    [handleUnauthenticated, refreshActivity],
  );

  const beginActivityOpening = useCallback(() => {
    setActivityOpen(true);
    void invalidateActivity();
  }, [invalidateActivity]);
  const endActivityOpening = useCallback(() => setActivityOpen(false), []);

  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;
    // Defer only to the end of this commit's effect flush. A visible Activity
    // child can claim the same initial observation regardless of parent/child
    // effect order; with no visible child, the provider still owns one mount
    // read. A later genuine opening is never covered by this one-turn gate.
    queueMicrotask(() => {
      if (cancelled || !mountedRef.current || readRequestedRef.current) return;
      void invalidateActivity();
    });
    return () => {
      cancelled = true;
      mountedRef.current = false;
      dirtyReadRef.current = null;
      readRequestedRef.current = false;
      abortRef.current?.abort();
    };
  }, [invalidateActivity]);

  useEffect(
    () =>
      subscribeMediaActivityInvalidations(() => {
        void invalidateActivity();
      }),
    [invalidateActivity],
  );

  useEffect(() => {
    const observed = observedPlacementRevisionRef.current;
    if (placementChange.revision === observed) return;
    observedPlacementRevisionRef.current = placementChange.revision;
    if (!libraryPlacementUnknownSince(observed)) return;
    publishMediaActivityInvalidation();
  }, [placementChange.revision]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void invalidateActivity();
    };
    const onResume = () => void invalidateActivity();
    const onBlur = () => {
      windowFocusedRef.current = false;
    };
    const onFocus = () => {
      if (windowFocusedRef.current) return;
      windowFocusedRef.current = true;
      void invalidateActivity();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    window.addEventListener("pageshow", onResume);
    window.addEventListener("online", onResume);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("pageshow", onResume);
      window.removeEventListener("online", onResume);
    };
  }, [invalidateActivity]);

  useEffect(() => {
    if (pollingWindow === null) return;
    const remainingMs = Math.max(
      0,
      pollingWindow.schedule.expiresAtMs - Date.now(),
    );
    const expiry = window.setTimeout(() => {
      if (mediaActivityPollingExpired(pollingWindow.schedule, Date.now())) {
        endPollingWindow(pollingWindow.id, true);
      }
    }, remainingMs);
    return () => window.clearTimeout(expiry);
  }, [endPollingWindow, pollingWindow]);

  const pollActivity = useCallback((): Promise<void> => {
    const current = pollingWindowRef.current;
    if (current === null) return Promise.resolve();
    return requestRead(
      { pollingWindowId: current.id, automatic: true },
      false,
    );
  }, [requestRead]);

  // justify-polling: Activity is a composed Postgres snapshot and this cut adds
  // no server push plane. Five-second reads run only for known active work and
  // the schedule itself terminates after fifteen minutes or one failed poll.
  useIntervalPoll({
    enabled: snapshot !== null && snapshot.activeCount > 0 && pollingWindow !== null,
    pollIntervalMs: ACTIVITY_POLL_INTERVAL_MS,
    onPoll: pollActivity,
  });

  if (defect !== null) throw defect.error;

  return (
    <MediaActivityContext.Provider
      value={{
        snapshot,
        loadState,
        refreshing,
        activityOpen,
        automaticRefreshEnded,
        beginActivityOpening,
        endActivityOpening,
        refreshActivity,
        repairActivity,
        retryUploadSession,
        removeUploadSession,
      }}
    >
      {children}
    </MediaActivityContext.Provider>
  );
}

export function useMediaActivity(): MediaActivityContextValue {
  const value = useContext(MediaActivityContext);
  if (value === null) throw new Error("MediaActivityProvider is missing");
  return value;
}
