"use client";

/**
 * The one Imports observer (docs/modules/imports.md). The summary is one
 * server read whose `stale` is a wake counter; the server stamps every read
 * with `observed_at`, and that stamp is the only observation token: the list,
 * the detail and the history refetch exactly when it changes. Reads happen on a
 * wake, an in-tab invalidation, Refresh, or a 5 s poll while work is active.
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
import {
  usePaneFreeServerValue,
  type ServerValue,
} from "@/lib/api/serverState";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import {
  fetchImportSummary,
  publishImportsInvalidation,
  subscribeImportsInvalidations,
  type ImportSummary,
} from "@/lib/imports/api";
import { removeUploadSession, retryUploadSession } from "@/lib/imports/ingest";
import {
  libraryPlacementUnknownSince,
  useLibraryPlacementRevision,
} from "@/lib/libraries/placementRevision";
import { useIntervalPoll } from "@/lib/useIntervalPoll";

const POLL_MS = 5_000;
/** A closed pane keeps polling this long after the last wake. */
const CLOSED_PANE_WINDOW_MS = 15 * 60_000;

export type UploadCommand =
  | {
      readonly kind: "RetryUpload";
      readonly handle: string;
      readonly file: File;
      readonly expectedGeneration: number;
    }
  | { readonly kind: "RemoveUpload"; readonly handle: string };

interface ImportsContextValue {
  readonly summary: ServerValue<ImportSummary>;
  /** The `observed_at` of the newest successful summary read ("" before). */
  readonly observation: string;
  /** The `pendingKey`s of upload commands in flight. */
  readonly pending: ReadonlySet<string>;
  /** A wake: read now and open the polling window. */
  refresh(): void;
  /** An open pane polls without a window; opening it is a wake. */
  setPaneOpen(open: boolean): void;
  /** Rejects with the command's failure for the caller to report. */
  dispatchUpload(command: UploadCommand): Promise<void>;
}

const ImportsContext = createContext<ImportsContextValue | null>(null);

/** One command against one import is pending at most once (contract D7). */
export function pendingKey(command: Pick<UploadCommand, "kind" | "handle">) {
  return `${command.handle}|${command.kind}`;
}

export function ImportsProvider({ children }: { children: ReactNode }) {
  const [wake, setWake] = useState(() => ({ count: 0, at: Date.now() }));
  const [paneOpen, setPaneOpenState] = useState(false);
  const [visible, setVisible] = useState(true);
  const [windowOpen, setWindowOpen] = useState(true);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  // A second click in the same tick must see the first one's key.
  const pendingRef = useRef(pending);
  const summary = usePaneFreeServerValue({
    key: "imports-summary",
    stale: String(wake.count),
    load: fetchImportSummary,
  });
  const refresh = useCallback(
    () => setWake((last) => ({ count: last.count + 1, at: Date.now() })),
    [],
  );

  useEffect(() => subscribeImportsInvalidations(refresh), [refresh]);

  // A placement whose libraries became unknown may have changed what Imports
  // shows (an upload retried from Imports publishes one).
  const placement = useLibraryPlacementRevision();
  const seenPlacement = useRef(placement.revision);
  useEffect(() => {
    const seen = seenPlacement.current;
    seenPlacement.current = placement.revision;
    if (placement.revision !== seen && libraryPlacementUnknownSince(seen)) {
      publishImportsInvalidation();
    }
  }, [placement.revision]);

  // Wakes: visible again, focus after a blur, pageshow, back online. A tab
  // opened in the background reports its state once rather than assuming.
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

  // The closed-pane window opens at every wake and lapses 15 minutes later.
  useEffect(() => {
    setWindowOpen(true);
    const timer = window.setTimeout(
      () => setWindowOpen(false),
      wake.at + CLOSED_PANE_WINDOW_MS - Date.now(),
    );
    return () => window.clearTimeout(timer);
  }, [wake.at]);

  // justify-polling: Imports is a composed projection with no push plane. Poll
  // only known active work on a visible document, while the pane is open or
  // its closed-pane window lasts, and only while the newest read succeeded; a
  // failed read stops polling until the next wake or Refresh.
  const ready = summary.status === "ready" ? summary : null;
  useIntervalPoll({
    enabled:
      ready !== null &&
      ready.error === null &&
      ready.data.active_count > 0 &&
      visible &&
      (paneOpen || windowOpen),
    pollIntervalMs: POLL_MS,
    onPoll: summary.refetch,
  });

  const setPaneOpen = useCallback(
    (open: boolean) => {
      setPaneOpenState(open);
      if (open) refresh();
    },
    [refresh],
  );

  const dispatchUpload = useCallback(async (command: UploadCommand) => {
    const key = pendingKey(command);
    if (pendingRef.current.has(key)) return;
    const settle = (next: Set<string>) => {
      pendingRef.current = next;
      setPending(next);
    };
    settle(new Set(pendingRef.current).add(key));
    try {
      if (command.kind === "RetryUpload") {
        await retryUploadSession({
          sessionHandle: command.handle,
          file: command.file,
          expectedGeneration: command.expectedGeneration,
        });
      } else {
        await removeUploadSession(command.handle);
      }
    } catch (error) {
      if (!handleUnauthenticatedApiError(error)) throw error;
    } finally {
      const next = new Set(pendingRef.current);
      next.delete(key);
      settle(next);
    }
  }, []);

  const observation = ready?.data.observed_at ?? "";
  const value = {
    summary,
    observation,
    pending,
    refresh,
    setPaneOpen,
    dispatchUpload,
  };
  return <ImportsContext value={value}>{children}</ImportsContext>;
}

export function useImports(): ImportsContextValue {
  const value = useContext(ImportsContext);
  if (value === null) throw new Error("ImportsProvider is missing");
  return value;
}
