"use client";

/**
 * The Imports summary observer (docs/modules/imports.md). Wakes and polls read
 * the observation clock; manual refresh and mutations also advance the strict
 * collection revision. Collections coalesce clock advances through revalidate.
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

const POLL_MS = 5_000;
/** With no pane open, polling lasts this long after the last wake. */
const CLOSED_PANE_WINDOW_MS = 15 * 60_000;

interface ImportsContextValue {
  readonly summary: ServerValue<ImportSummary>;
  /** The `observed_at` of the newest successful summary read ("" before one). */
  readonly observation: string;
  /** Manual refresh/mutation invalidation, independent of the observation clock. */
  readonly revision: string;
  /** Strictly refresh collections and wake the summary. */
  refresh(): void;
  /**
   * A mounted Imports pane: polling needs no window while any pane is open, and
   * opening one wakes. Returns the close.
   */
  paneOpened(): () => void;
}

const ImportsContext = createContext<ImportsContextValue | null>(null);

export function ImportsProvider({ children }: { children: ReactNode }) {
  const [wake, setWake] = useState(() => ({ count: 0, at: Date.now() }));
  const [revision, setRevision] = useState(0);
  const [openPanes, setOpenPanes] = useState(0);
  const [visible, setVisible] = useState(true);
  const [windowOpen, setWindowOpen] = useState(true);
  const summary = usePaneFreeServerValue({
    key: "imports-summary",
    stale: String(wake.count),
    load: fetchImportSummary,
  });
  const observe = useCallback(
    () => setWake((last) => ({ count: last.count + 1, at: Date.now() })),
    [],
  );
  const refresh = useCallback(() => {
    setRevision((last) => last + 1);
    observe();
  }, [observe]);
  const paneOpened = useCallback(() => {
    setOpenPanes((count) => count + 1);
    observe();
    return () => setOpenPanes((count) => count - 1);
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

  // A tab opened in the background reports its visibility once rather than
  // assuming it.
  useEffect(() => {
    let blurred = false;
    const onVisibility = () => {
      const shown = document.visibilityState === "visible";
      setVisible(shown);
      if (shown) observe();
    };
    const onBlur = () => {
      blurred = true;
    };
    const onFocus = () => {
      if (blurred) observe();
      blurred = false;
    };
    setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    window.addEventListener("pageshow", observe);
    window.addEventListener("online", observe);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("pageshow", observe);
      window.removeEventListener("online", observe);
    };
  }, [observe]);

  useEffect(() => {
    setWindowOpen(true);
    const timer = window.setTimeout(
      () => setWindowOpen(false),
      wake.at + CLOSED_PANE_WINDOW_MS - Date.now(),
    );
    return () => window.clearTimeout(timer);
  }, [wake.at]);

  // justify-polling: Imports is a composed projection with no push plane. A
  // failed read stops polling until the next wake or Refresh.
  const ready = summary.status === "ready" ? summary : null;
  useIntervalPoll({
    enabled:
      ready !== null &&
      ready.error === null &&
      !ready.refreshing &&
      ready.data.unfinished_work_count > 0 &&
      visible &&
      (openPanes > 0 || windowOpen),
    pollIntervalMs: POLL_MS,
    onPoll: summary.refetch,
  });

  const value = {
    summary,
    observation: ready?.data.observed_at ?? "",
    revision: String(revision),
    refresh,
    paneOpened,
  };
  return <ImportsContext value={value}>{children}</ImportsContext>;
}

export function useImports(): ImportsContextValue {
  const value = useContext(ImportsContext);
  if (value === null) throw new Error("ImportsProvider is missing");
  return value;
}
