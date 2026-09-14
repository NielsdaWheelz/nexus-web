"use client";

import { useCallback, useEffect, useRef } from "react";
import { apiFetch } from "@/lib/api/client";
import { isAbortError } from "@/lib/errors";
import { nexusHistoryCommand, type NexusSelectionRecord } from "./history";

const NEXUS_SELECTION_IDLE_DELAY_MS = 500;
const NEXUS_SELECTION_QUEUE_PRESSURE_LIMIT = 64;

interface QueuedSelection {
  readonly request: NexusSelectionRecord & {
    readonly client_mutation_id: string;
  };
  firstFrame: number | null;
  secondFrame: number | null;
  ready: boolean;
  sending: boolean;
  controller: AbortController | null;
}

/**
 * A durable coordinator publishes its failures as values; it never throws above
 * the boundary that owns its surface. A failed write keeps its frozen entry, so
 * `retry` replays that exact `client_mutation_id` and the backend's replay
 * record counts the selection once.
 */
export type NexusSelectionJournalFailure =
  | {
      readonly kind: "WriteFailed";
      readonly error: unknown;
      readonly retry: () => void;
    }
  | { readonly kind: "DrainDefect"; readonly error: unknown };

interface NexusSelectionJournalOptions {
  readonly foregroundActive: boolean;
  readonly onFailure: (failure: NexusSelectionJournalFailure) => void;
  readonly onQuiescentCommit: () => void;
}

/**
 * Persist accepted Nexus selections after interaction work is quiet.
 *
 * The queue preserves every accepted selection and drains with concurrency one.
 * A pagehide flush sends the same replay-safe mutation ids with `keepalive`, so
 * an ambiguous duplicate converges at the backend instead of double-counting.
 */
export function useNexusSelectionJournal({
  foregroundActive,
  onFailure,
  onQuiescentCommit,
}: NexusSelectionJournalOptions): (selection: NexusSelectionRecord) => void {
  const queueRef = useRef<QueuedSelection[]>([]);
  const idleTimerRef = useRef<number | null>(null);
  const drainingRef = useRef(false);
  const generationRef = useRef(0);
  const pageHidingRef = useRef(false);
  const foregroundActiveRef = useRef(foregroundActive);
  const activeRef = useRef(false);
  const committedSinceRefreshRef = useRef(false);
  const onFailureRef = useRef(onFailure);
  const onQuiescentCommitRef = useRef(onQuiescentCommit);
  const drainRef = useRef<() => Promise<void>>(async () => {});
  const scheduleDrainRef = useRef<() => void>(() => {});
  onFailureRef.current = onFailure;
  onQuiescentCommitRef.current = onQuiescentCommit;

  const cancelFrames = useCallback((entry: QueuedSelection) => {
    if (entry.firstFrame !== null) {
      window.cancelAnimationFrame(entry.firstFrame);
      entry.firstFrame = null;
    }
    if (entry.secondFrame !== null) {
      window.cancelAnimationFrame(entry.secondFrame);
      entry.secondFrame = null;
    }
  }, []);

  const send = useCallback((entry: QueuedSelection, signal?: AbortSignal) => {
    return apiFetch("/api/me/nexus-selections", {
      method: "POST",
      keepalive: true,
      body: JSON.stringify(entry.request),
      signal,
    });
  }, []);

  scheduleDrainRef.current = () => {
    if (
      !activeRef.current ||
      pageHidingRef.current ||
      foregroundActiveRef.current
    ) {
      return;
    }
    if (idleTimerRef.current !== null) {
      window.clearTimeout(idleTimerRef.current);
    }
    if (!queueRef.current.some((entry) => entry.ready && !entry.sending)) {
      idleTimerRef.current = null;
      return;
    }
    const delay =
      queueRef.current.length >= NEXUS_SELECTION_QUEUE_PRESSURE_LIMIT
        ? 0
        : NEXUS_SELECTION_IDLE_DELAY_MS;
    idleTimerRef.current = window.setTimeout(() => {
      idleTimerRef.current = null;
      void drainRef.current().catch((error: unknown) => {
        onFailureRef.current({ kind: "DrainDefect", error });
      });
    }, delay);
  };

  drainRef.current = async () => {
    if (
      drainingRef.current ||
      pageHidingRef.current ||
      foregroundActiveRef.current
    ) {
      return;
    }
    drainingRef.current = true;
    const startedGeneration = generationRef.current;
    try {
      while (
        activeRef.current &&
        !pageHidingRef.current &&
        !foregroundActiveRef.current
      ) {
        const entry = queueRef.current.find(
          (candidate) => candidate.ready && !candidate.sending,
        );
        if (!entry) break;
        entry.sending = true;
        entry.controller = new AbortController();
        let retryAfterForeground = false;
        let committed = false;
        let awaitingExplicitRetry = false;
        try {
          await send(entry, entry.controller.signal);
          committedSinceRefreshRef.current = true;
          committed = true;
        } catch (error) {
          if (isAbortError(error) && foregroundActiveRef.current) {
            retryAfterForeground = true;
          } else {
            awaitingExplicitRetry = true;
            entry.ready = false;
            onFailureRef.current({
              kind: "WriteFailed",
              error,
              retry: () => {
                if (!queueRef.current.includes(entry) || entry.sending) return;
                entry.ready = true;
                scheduleDrainRef.current();
              },
            });
          }
        } finally {
          entry.controller = null;
          entry.sending = false;
          if (committed) {
            queueRef.current = queueRef.current.filter(
              (candidate) => candidate !== entry,
            );
          }
        }
        if (retryAfterForeground) break;
        if (awaitingExplicitRetry) break;
        if (generationRef.current !== startedGeneration) break;
      }
    } finally {
      drainingRef.current = false;
      if (
        activeRef.current &&
        !pageHidingRef.current &&
        !foregroundActiveRef.current &&
        queueRef.current.length === 0 &&
        committedSinceRefreshRef.current
      ) {
        committedSinceRefreshRef.current = false;
        onQuiescentCommitRef.current();
      } else {
        scheduleDrainRef.current();
      }
    }
  };

  const flushForPageExit = useCallback(() => {
    pageHidingRef.current = true;
    generationRef.current += 1;
    if (idleTimerRef.current !== null) {
      window.clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
    for (const entry of queueRef.current) {
      cancelFrames(entry);
      entry.ready = true;
      // The page lifecycle owns termination here. Observe rejection without
      // trying to render feedback into a document that is leaving.
      void send(entry).catch(() => {});
    }
  }, [cancelFrames, send]);

  useEffect(() => {
    activeRef.current = true;
    pageHidingRef.current = false;
    const onPageShow = () => {
      pageHidingRef.current = false;
      scheduleDrainRef.current();
    };
    window.addEventListener("pagehide", flushForPageExit);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      window.removeEventListener("pagehide", flushForPageExit);
      window.removeEventListener("pageshow", onPageShow);
      flushForPageExit();
      activeRef.current = false;
    };
  }, [flushForPageExit]);

  useEffect(() => {
    foregroundActiveRef.current = foregroundActive;
    generationRef.current += 1;
    if (foregroundActive) {
      if (idleTimerRef.current !== null) {
        window.clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }
      for (const entry of queueRef.current) {
        entry.controller?.abort();
      }
      return;
    }
    scheduleDrainRef.current();
  }, [foregroundActive]);

  return useCallback(
    (selection: NexusSelectionRecord) => {
      const entry: QueuedSelection = {
        request: nexusHistoryCommand(selection, crypto.randomUUID()),
        firstFrame: null,
        secondFrame: null,
        ready: false,
        sending: false,
        controller: null,
      };
      queueRef.current.push(entry);
      generationRef.current += 1;
      if (pageHidingRef.current) {
        entry.ready = true;
        void send(entry).catch(() => {});
        return;
      }
      entry.firstFrame = window.requestAnimationFrame(() => {
        entry.firstFrame = null;
        entry.secondFrame = window.requestAnimationFrame(() => {
          entry.secondFrame = null;
          entry.ready = true;
          scheduleDrainRef.current();
        });
      });
    },
    [send],
  );
}
