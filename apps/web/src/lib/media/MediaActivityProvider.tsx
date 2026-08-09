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
import { isAbortError } from "@/lib/errors";
import { useUnauthenticatedApiHandler } from "@/lib/auth/UnauthenticatedApiBoundary";
import {
  fetchMediaActivity,
  repairMediaActivity,
  subscribeMediaActivityChanges,
  type MediaActivityResponse,
  type MediaRepairScope,
} from "@/lib/media/activityClient";
import { mediaActivityLoadErrorMessage } from "@/lib/status/mediaActivity";
import {
  mediaActivityPollingExpired,
  mediaActivityPollingSchedule,
} from "@/lib/media/activityPolling";
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
}

const MediaActivityContext = createContext<MediaActivityContextValue | null>(
  null,
);

export function MediaActivityProvider({ children }: { children: ReactNode }) {
  const handleUnauthenticated = useUnauthenticatedApiHandler();
  const [snapshot, setSnapshot] = useState<MediaActivityResponse | null>(null);
  const [loadState, setLoadState] = useState<ActivityLoadState>({
    kind: "Loading",
  });
  const [refreshing, setRefreshing] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [automaticRefreshEnded, setAutomaticRefreshEnded] = useState(false);
  const [defect, setDefect] = useState<{ readonly error: unknown } | null>(null);
  const mountedRef = useRef(true);
  const inFlightRef = useRef<Promise<void> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const refreshActivity = useCallback((): Promise<void> => {
    if (inFlightRef.current !== null) return inFlightRef.current;
    const controller = new AbortController();
    abortRef.current = controller;
    setRefreshing(true);
    const request = fetchMediaActivity(controller.signal)
      .then((next) => {
        if (!mountedRef.current || controller.signal.aborted) return;
        setSnapshot(next);
        setLoadState({ kind: "Ready" });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || isAbortError(error)) return;
        if (handleUnauthenticated(error)) return;
        try {
          const content = mediaActivityLoadErrorMessage(error);
          if (mountedRef.current) setLoadState({ kind: "Failed", content });
        } catch (caughtDefect: unknown) {
          if (mountedRef.current) setDefect({ error: caughtDefect });
        }
      })
      .finally(() => {
        if (inFlightRef.current === request) inFlightRef.current = null;
        if (abortRef.current === controller) abortRef.current = null;
        if (mountedRef.current) setRefreshing(false);
      });
    inFlightRef.current = request;
    return request;
  }, [handleUnauthenticated]);

  const repairActivity = useCallback(
    async (mediaId: string, scope: MediaRepairScope): Promise<void> => {
      try {
        await repairMediaActivity(mediaId, scope);
      } catch (error) {
        if (handleUnauthenticated(error)) return;
        throw error;
      }
      await refreshActivity();
    },
    [handleUnauthenticated, refreshActivity],
  );

  const beginActivityOpening = useCallback(() => setActivityOpen(true), []);
  const endActivityOpening = useCallback(() => setActivityOpen(false), []);

  useEffect(() => {
    mountedRef.current = true;
    void refreshActivity();
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, [refreshActivity]);

  useEffect(
    () =>
      subscribeMediaActivityChanges(() => {
        void refreshActivity();
      }),
    [refreshActivity],
  );

  useEffect(() => {
    if (!activityOpen) return;
    setAutomaticRefreshEnded(false);
    void refreshActivity();
    const schedule = mediaActivityPollingSchedule(Date.now());
    const expiry = window.setTimeout(() => {
      if (mediaActivityPollingExpired(schedule, Date.now())) {
        setAutomaticRefreshEnded(true);
      }
    }, schedule.expiresAtMs - Date.now());
    return () => window.clearTimeout(expiry);
  }, [activityOpen, refreshActivity]);

  // justify-polling: Activity is a composed Postgres snapshot with no global
  // push plane. Five seconds keeps one-user job progress legible; the opening
  // expires after fifteen minutes and single-flight refresh prevents overlap.
  useIntervalPoll({
    enabled: activityOpen && !automaticRefreshEnded,
    pollIntervalMs: ACTIVITY_POLL_INTERVAL_MS,
    onPoll: refreshActivity,
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
