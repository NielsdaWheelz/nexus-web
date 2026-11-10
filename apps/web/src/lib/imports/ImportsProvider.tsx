"use client";

/**
 * The Imports summary observer (docs/modules/imports.md). Wakes and polls read
 * the observation clock; manual refresh and mutations also advance the strict
 * collection revision. Collections coalesce clock advances through revalidate.
 * The visible shell shares one summary. Presented busy consumers accelerate it;
 * mounting a retained pane alone grants no observation demand.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useChangeStamp } from "@/lib/api/changes";
import {
  usePaneFreeServerValue,
  type ServerValue,
} from "@/lib/api/serverState";
import {
  fetchImportSummary,
  subscribeImportsInvalidations,
  type ImportSummary,
} from "@/lib/imports/api";
import { useIntervalPoll } from "@/lib/useIntervalPoll";
import { PASSIVE_OBSERVATION_MS, WORK_OBSERVATION_MS } from "@/lib/api/observationPolicy";
import { useObservationDemand } from "@/lib/api/useObservationDemand";

interface ImportsContextValue {
  readonly summary: ServerValue<ImportSummary>;
  /** The `observed_at` of the newest successful summary read ("" before one). */
  readonly observation: string;
  /** Manual refresh/mutation invalidation, independent of the observation clock. */
  readonly revision: string;
  /** Strictly refresh collections and wake the summary. */
  refresh(): void;
  /**
   * A presented pane or continuation accelerates a busy summary; release on hide.
   */
  retainObserver(): () => void;
}

const ImportsContext = createContext<ImportsContextValue | null>(null);

export function ImportsProvider({ children }: { children: ReactNode }) {
  const demand = useObservationDemand(true);
  const [revision, setRevision] = useState(0);
  const [observers, setObservers] = useState(0);
  const summary = usePaneFreeServerValue({ key: "imports-summary", enabled: demand,
    stale: "", load: fetchImportSummary });
  const latest = useRef({ demand, summary });
  latest.current = { demand, summary };
  const observe = useCallback(() => {
    const now = latest.current;
    if (now.demand && now.summary.status === "ready" && now.summary.error === null) now.summary.revalidate({ passive: true });
  }, []);
  const refresh = useCallback(() => {
    setRevision(last => last + 1);
    const now = latest.current;
    if (now.demand) void now.summary.refetch().catch(() => { /* The read owner retains failures and rethrows defects. */ });
  }, []);
  const retainObserver = useCallback(() => {
    setObservers(count => count + 1);
    observe();
    return () => setObservers(count => count - 1);
  }, [observe]);

  useEffect(() => subscribeImportsInvalidations(refresh), [refresh]);

  // A change to what libraries hold (a removal, a library deletion) may have
  // changed what Imports shows.
  const entries = useChangeStamp("Entries");
  const seenEntries = useRef(entries);
  useEffect(() => {
    if (entries === seenEntries.current) return;
    seenEntries.current = entries;
    refresh();
  }, [entries, refresh]);

  useEffect(() => {
    if (!demand) return;
    // Demand admission owns its read; focus and online are separate repair wakes.
    window.addEventListener("focus", observe);
    window.addEventListener("online", observe);
    return () => { window.removeEventListener("focus", observe); window.removeEventListener("online", observe); };
  }, [demand, observe]);

  // justify-polling: Imports is a composed projection with no push plane. A
  // failed read stops polling until the next wake or Refresh.
  const ready = summary.status === "ready" ? summary : null;
  useIntervalPoll({
    enabled: demand && ready !== null && ready.error === null && !ready.refreshing,
    pollIntervalMs: observers > 0 && ready !== null && ready.data.work_in_flight ? WORK_OBSERVATION_MS : PASSIVE_OBSERVATION_MS,
    onPoll: () => summary.refetch().catch(() => { /* The read owner retains its failure. */ }),
  });

  const value = {
    summary,
    observation: ready?.data.observed_at ?? "",
    revision: String(revision),
    refresh,
    retainObserver,
  };
  return <ImportsContext value={value}>{children}</ImportsContext>;
}

export function useImports(): ImportsContextValue {
  const value = useContext(ImportsContext);
  if (value === null) throw new Error("ImportsProvider is missing");
  return value;
}
