"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Sparkles } from "lucide-react";
import { FeedbackNotice, type FeedbackContent } from "@/components/feedback/Feedback";
import ResourceActionMenu from "@/components/resources/ResourceActionMenu";
import Button from "@/components/ui/Button";
import ResourceOutlineList from "@/components/resources/ResourceOutlineList";
import ResourceOutlineRow from "@/components/resources/ResourceOutlineRow";
import { useChangeStamp } from "@/lib/api/changes";
import { isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { usePaneFreeServerList } from "@/lib/api/useServerList";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import {
  queryConnections,
  subscribeLinkMutations,
  type ConnectionOut,
} from "@/lib/resourceGraph/links";
import { formatResourceRef, type ResourceRef } from "@/lib/resourceGraph/resourceRef";
import { CONNECTION_DISCOVERY_SOURCE_SCHEMES } from "@/lib/resources/resourceCapabilities";
import { useLinkComposerHost } from "@/lib/actions/ResourceActionsProvider";
import { fetchDiscoveryScanStatus, requestDiscoveryScan, type DiscoveryScanStatus } from "@/lib/connectionDiscovery";
import { assumeCanonicalResourceRef } from "@/lib/sharing/targets";
import { useIntervalPoll } from "@/lib/useIntervalPoll";
import { useConnectionAttachments } from "./useConnectionAttachments";
import styles from "./ConnectionsSurface.module.css";

type ConnectionOperation = "Load" | "ScanStatus" | "StartScan";

function connectionErrorMessage(error: unknown, operation: ConnectionOperation): FeedbackContent {
  if (!isApiError(error) || isSameSystemApiDefect(error)) throw error;
  const title = operation === "Load" ? "Connections couldn’t be loaded" : operation === "ScanStatus" ? "Scan status couldn’t be checked" : "Scan wasn’t started";
  switch (error.code) {
    case "E_NETWORK":
    case "E_UPSTREAM_TIMEOUT":
      return { tone: "Warning", title: title, message: "Retry the same request when you’re connected.", requestId: error.requestId };
    case "E_UPSTREAM":
    case "E_RATE_LIMITED":
      return { tone: "Danger", title, message: "Wait a moment, then retry.", requestId: error.requestId };
    case "E_NOT_FOUND":
      return { tone: "Danger", title, message: "This connection or one of its items is no longer available. Reload Connections.", requestId: error.requestId };
    case "E_FORBIDDEN":
    case "E_INVALID_REQUEST":
    case "E_CONFLICT":
      return { tone: "Danger", title, message: "This change is no longer available. Reload Connections.", requestId: error.requestId };
    default: throw error;
  }
}

export default function ConnectionsSurface({ resourceRef, refreshKey = 0 }: {
  resourceRef: ResourceRef;
  refreshKey?: number;
}) {
  const selfRef = formatResourceRef(resourceRef);
  const attachments = useConnectionAttachments(selfRef);
  const metadata = useChangeStamp("Notes", "Metadata");
  const linkComposer = useLinkComposerHost();
  const [refreshTick, setRefreshTick] = useState(0);
  const reload = useCallback(() => setRefreshTick((value) => value + 1), []);
  useEffect(() => subscribeLinkMutations(reload), [reload]);
  // A refresh rereads while the rows stay shown, through the last row it showed
  // even when new rows push it onto a later page; if that row is gone, to the end.
  const shownLast = useRef<string | null>(null);
  const list = usePaneFreeServerList<ConnectionOut>({
    key: selfRef,
    stale: `${refreshKey}:${refreshTick}:${metadata}`,
    pageSize: 100,
    drain: false,
    active: true,
    id: (connection) => connection.edge_id,
    fetchPage: async (cursor, limit, signal) => {
      const boundary = cursor === null ? shownLast.current : null;
      const items: ConnectionOut[] = [];
      let next = cursor;
      do {
        const page = await queryConnections({ refs: [selfRef], direction: "both", rollup: "owner", limit: Math.min(limit, 100), cursor: next }, signal);
        items.push(...page.items);
        next = page.next_cursor;
        if (boundary === null || page.items.some((row) => row.edge_id === boundary)) break;
      } while (next !== null);
      return { items, next_cursor: next };
    },
  });
  shownLast.current = list.current ? (list.items.at(-1)?.edge_id ?? null) : null;
  const loading = list.running === "Load" || list.running === "Refetch";
  const loadError = list.failure?.error ?? null;
  const scannable = (CONNECTION_DISCOVERY_SOURCE_SCHEMES as readonly string[]).includes(resourceRef.scheme);
  const scan = useDiscoveryScan({ selfRef, enabled: scannable, onSettled: reload });
  const scanning = scan.phase !== "idle";

  if (scan.defectState) throw scan.defectState.error;
  return (
    <section className={styles.section} aria-label="Connections"
      {...attachments.dropProps}>
      <div className={styles.header}>
        <h2 className={styles.title}>Connections</h2>
        <div className={styles.headerActions}>
          <ResourceActionMenu resourceRef={assumeCanonicalResourceRef(selfRef)} label="Connection actions" />
          {attachments.control}
          {scannable ? <Button type="button" variant="ghost" size="sm" iconOnly loading={scanning} aria-label="Find connections" title="Find connections" onClick={() => void scan.start()}><Sparkles size={14} aria-hidden="true" /></Button> : null}
        </div>
      </div>

      {scan.feedback ? <FeedbackNotice content={scan.feedback} announcement="Assertive" actions={[{ label: "Retry", onClick: () => void scan.retry() }]} /> : null}
      {scanning ? <p role="status" className={styles.voice}>Finding connections…</p> : null}
      {attachments.attaching ? <p role="status" className={styles.voice}>Uploading and linking… Closing this pane keeps the submitted upload running.</p> : null}
      {loading ? <p role="status" className={styles.empty}>{list.status === "ready" ? "Refreshing connections…" : "Loading connections…"}</p> : null}
      {loadError ? <FeedbackNotice content={connectionErrorMessage(loadError, "Load")} announcement="Assertive" actions={[{ label: "Retry", onClick: list.retry }]} /> : null}
      {list.status === "ready" && !loading && list.items.length === 0 ? <p className={styles.empty}>No connections yet. <button type="button" onClick={() => void linkComposer.openResourceLink(selfRef)}>Link an item</button></p> : null}
      <ResourceOutlineList scope={`connections:${selfRef}`} ariaLabel="Connections" ancestorRef={selfRef}>
        {list.items.map((connection) => <ResourceOutlineRow key={connection.edge_id} item={connection.other} occurrenceKey={`${selfRef}/${connection.edge_id}`} connection={connection} onChanged={reload} />)}
      </ResourceOutlineList>
      {list.status === "ready" && !list.complete ? <Button type="button" variant="ghost" size="sm" disabled={loading} loading={list.running === "More"} onClick={list.more}>Load more</Button> : null}
    </section>
  );
}

const DISCOVERY_SCAN_POLL_MS = 2000;
const DISCOVERY_SCAN_TIMEOUT_MS = 45_000;

/** The native job status owns liveness; only its explicit outcome proves success. */
function useDiscoveryScan({ selfRef, enabled, onSettled }: {
  selfRef: string; enabled: boolean; onSettled: () => void;
}) {
  const [phase, setPhase] = useState<"idle" | "requesting" | "polling">("idle");
  const [feedback, setFeedback] = useState<FeedbackContent | null>(null);
  const [failureOperation, setFailureOperation] = useState<"ScanStatus" | "StartScan" | null>(null);
  const [defectState, setDefectState] = useState<{ error: unknown } | null>(null);
  const deadlineRef = useRef(0);
  const settle = useCallback((state: DiscoveryScanStatus) => {
    if (state.status === "pending" || state.status === "running") return false;
    setPhase("idle");
    if (state.status === "failed" || state.outcome === "terminal_failed") {
      setFeedback({ tone: "Warning", title: "Connections weren’t found", message: "The scan failed. You can try again." });
      setFailureOperation("StartScan");
    } else if (state.outcome === "skipped" || state.outcome === null) {
      setFeedback({ tone: "Info", title: "Scan didn’t run", message: "Connection discovery isn’t available for this item right now." });
      setFailureOperation("StartScan");
    } else {
      setFeedback(null);
    }
    onSettled();
    return true;
  }, [onSettled]);
  const failed = useCallback((error: unknown, operation: "ScanStatus" | "StartScan") => {
    setPhase("idle");
    if (handleUnauthenticatedApiError(error)) return;
    try { setFeedback(connectionErrorMessage(error, operation)); setFailureOperation(operation); }
    catch (error) { setDefectState({ error }); }
  }, []);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void fetchDiscoveryScanStatus(selfRef).then((state) => {
      if (cancelled || state.status === "idle") return;
      if (state.status === "failed") { settle(state); return; }
      deadlineRef.current = Date.now() + DISCOVERY_SCAN_TIMEOUT_MS;
      setPhase("polling");
    }).catch((error) => { if (!cancelled) failed(error, "ScanStatus"); });
    return () => { cancelled = true; };
  }, [enabled, failed, selfRef, settle]);
  // justify-polling: user-requested background work has no SSE plane; poll at
  // 2s for at most 45s, then offer another status read without claiming success.
  useIntervalPoll({ enabled: phase === "polling", pollIntervalMs: DISCOVERY_SCAN_POLL_MS, onPoll: async () => {
    try {
      const state = await fetchDiscoveryScanStatus(selfRef);
      if (settle(state)) return;
      if (Date.now() >= deadlineRef.current) {
        setPhase("idle");
        setFeedback({ tone: "Info", title: "Still finding connections", message: "The scan is taking longer than expected. Check its status again." });
        setFailureOperation("ScanStatus");
      }
    } catch (error) { failed(error, "ScanStatus"); }
  } });
  const begin = useCallback(async (operation: "ScanStatus" | "StartScan") => {
    setFeedback(null);
    setFailureOperation(null);
    setPhase("requesting");
    try {
      const state = await (operation === "StartScan" ? requestDiscoveryScan(selfRef) : fetchDiscoveryScanStatus(selfRef));
      if (settle(state)) return;
      deadlineRef.current = Date.now() + DISCOVERY_SCAN_TIMEOUT_MS;
      setPhase("polling");
    } catch (error) { failed(error, operation); }
  }, [failed, selfRef, settle]);
  return { phase, feedback, defectState, start: () => begin("StartScan"), retry: () => begin(failureOperation ?? "StartScan") };
}
