"use client";

/**
 * The one Imports observer (docs/modules/imports.md). The summary is one server
 * read whose `stale` is a wake counter; its `observed_at` is the only
 * observation token, so the list, the detail and an open history reread
 * exactly when it changes. Reads happen on a wake (visible again, focus after
 * a blur, pageshow, online, a pane opening, an in-tab invalidation, an
 * `Entries` change, Refresh) and every 5 s while the newest read succeeded,
 * work is unfinished, the tab is visible and a pane is open or the last wake is
 * under 15 minutes old.
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
  /** A wake: read now and reopen the polling window. */
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
  const [openPanes, setOpenPanes] = useState(0);
  const [visible, setVisible] = useState(true);
  const [windowOpen, setWindowOpen] = useState(true);
  const summary = usePaneFreeServerValue({
    key: "imports-summary",
    stale: String(wake.count),
    load: fetchImportSummary,
  });
  const refresh = useCallback(
    () => setWake((last) => ({ count: last.count + 1, at: Date.now() })),
    [],
  );
  const paneOpened = useCallback(() => {
    setOpenPanes((count) => count + 1);
    refresh();
    return () => setOpenPanes((count) => count - 1);
  }, [refresh]);

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
      if (shown) refresh();
    };
    const onBlur = () => {
      blurred = true;
    };
    const onFocus = () => {
      if (blurred) refresh();
      blurred = false;
    };
    setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    window.addEventListener("pageshow", refresh);
    window.addEventListener("online", refresh);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("pageshow", refresh);
      window.removeEventListener("online", refresh);
    };
  }, [refresh]);

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
      ready.data.unfinished_work_count > 0 &&
      visible &&
      (openPanes > 0 || windowOpen),
    pollIntervalMs: POLL_MS,
    onPoll: summary.refetch,
  });

  const value = {
    summary,
    observation: ready?.data.observed_at ?? "",
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
