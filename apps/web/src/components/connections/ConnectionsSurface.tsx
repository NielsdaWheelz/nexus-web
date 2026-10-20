"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Sparkles } from "lucide-react";
import { FeedbackNotice, FeedbackStatus, type FeedbackContent } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import ResourceOutlineList from "@/components/resources/ResourceOutlineList";
import ResourceOutlineRow from "@/components/resources/ResourceOutlineRow";
import { useChangeStamp } from "@/lib/api/changes";
import { apiTransportFeedback, isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { usePaneFreeServerList } from "@/lib/api/useServerList";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import {
  queryConnections,
  subscribeLinkMutations,
  type ConnectionOut,
} from "@/lib/resourceGraph/links";
import { formatResourceRef, type ResourceRef } from "@/lib/resourceGraph/resourceRef";
import { CONNECTION_DISCOVERY_SOURCE_SCHEMES } from "@/lib/resources/resourceCapabilities";
import { ResourceComposer } from "@/components/resources/ResourceDisclosure";
import ContextualActionMenu from "@/components/resources/ContextualActionMenu";
import { fetchDiscoveryScanStatus, requestDiscoveryScan, type DiscoveryScanStatus } from "@/lib/connectionDiscovery";
import { assumeCanonicalResourceRef } from "@/lib/sharing/targets";
import { useIntervalPoll } from "@/lib/useIntervalPoll";
import { useConnectionAttachments } from "./useConnectionAttachments";
import styles from "./ConnectionsSurface.module.css";

type ConnectionOperation = "Load" | "ScanStatus" | "StartScan";

function connectionErrorMessage(error: unknown, operation: ConnectionOperation): FeedbackContent {
  if (!isApiError(error) || isSameSystemApiDefect(error)) throw error;
  const title = operation === "Load" ? "couldn’t refresh connections" : operation === "ScanStatus" ? "Scan status couldn’t be checked" : "scan request not confirmed";
  const transport = apiTransportFeedback(error, title);
  if (transport !== null) return transport;
  if (!["E_NOT_FOUND", "E_FORBIDDEN", "E_INVALID_REQUEST"].includes(error.code)) throw error;
  return { tone: "Danger", title, message: "This item or connection is no longer available. Refresh Connections.", requestId: error.requestId };
}

export default function ConnectionsSurface({ resourceRef, refreshKey = 0 }: {
  resourceRef: ResourceRef;
  refreshKey?: number;
}) {
  const selfRef = formatResourceRef(resourceRef);
  const attachments = useConnectionAttachments(selfRef);
  const metadata = useChangeStamp("Notes", "Metadata");
  const [adding,setAdding] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  const reload = useCallback(() => setRefreshTick((value) => value + 1), []);
  useEffect(() => subscribeLinkMutations(reload), [reload]);
  const list = usePaneFreeServerList<ConnectionOut>({
    key: selfRef,
    stale: `${refreshKey}:${refreshTick}:${metadata}`,
    pageSize: 100,
    drain: false,
    active: true,
    id: (connection) => connection.edge_id,
    fetchPage: async (cursor, limit, signal) => {
      const page = await queryConnections({ refs: [selfRef], direction: "both", rollup: "owner", limit: Math.min(limit, 100), cursor }, signal);
      return { items: page.items, next_cursor: page.next_cursor };
    },
  });
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
          <ContextualActionMenu resourceRef={assumeCanonicalResourceRef(selfRef)} title="connections" subjectKey={`connections:${selfRef}`} label="more actions for connections" sections={[{id:"Pane",actions:[{kind:"command",id:"Resource.AddItem",label:"add item",onSelect:()=>setAdding(true)}]}]} />
          {attachments.control}
          {scannable ? <Button type="button" variant="ghost" size="sm" iconOnly loading={scanning} aria-label="Find connections" title="Find connections" onClick={() => void scan.start()}><Sparkles size={14} aria-hidden="true" /></Button> : null}
        </div>
      </div>

      {scan.feedback ? <FeedbackNotice content={scan.feedback} announcement="Polite" actions={scan.canRetry ? [{ label: "retry scan", onClick: () => void scan.retry(), busy: scanning }] : undefined} /> : null}
      {scanning && scan.feedback === null ? <FeedbackStatus content={{ tone: "Neutral", title: "finding connections…" }} announcement="Polite" /> : null}
      {attachments.attaching ? <FeedbackStatus content={{ tone: "Neutral", title: "uploading and linking…", message: "closing this pane keeps the submitted upload running." }} announcement="Polite" /> : null}
      {loading && loadError === null ? <FeedbackStatus content={{ tone: "Neutral", title: list.status === "ready" ? "refreshing connections…" : "loading connections…" }} announcement="None" /> : null}
      {loadError ? <FeedbackNotice content={connectionErrorMessage(loadError, "Load")} announcement="Assertive" actions={[{ label: "retry refresh", onClick: list.retry, busy: list.running !== null }]} /> : null}
      {list.status === "ready" && !loading && list.items.length === 0 ? <FeedbackStatus content={{ tone: "Neutral", title: "no connections yet" }} announcement="None"  /> : null}
      <ResourceOutlineList scope={`connections:${selfRef}`} ariaLabel="Connections" ancestorRef={selfRef}>
        {list.items.map((connection) => <ResourceOutlineRow key={connection.edge_id} item={connection.other} occurrenceKey={`${selfRef}/${connection.edge_id}`} connection={connection} incoming={{ kind: "edge", edge_id: connection.edge_id, origin: connection.origin, mutation: connection.mutation, creation: connection.creation }} onChanged={reload} />)}
      </ResourceOutlineList>
      {list.status === "ready" && !list.complete ? <Button type="button" variant="ghost" size="sm" disabled={loading} loading={list.running === "More"} onClick={list.more}>Load more</Button> : null}
      {adding ? <ResourceComposer source={{kind:"resource",ref:selfRef}} occurrenceKey={`connections:${selfRef}`} label="add item" onSaved={reload} /> : null}
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
      setFeedback({ tone: "Info", title: "scan didn’t run", message: "connection discovery isn’t available for this item right now." });
      setFailureOperation(null);
    } else {
      setFeedback(null);
    }
    onSettled();
    return true;
  }, [onSettled]);
  const failed = useCallback((error: unknown, operation: "ScanStatus" | "StartScan") => {
    setPhase("idle");
    if (handleUnauthenticatedApiError(error)) return;
    try {
      setFeedback(connectionErrorMessage(error, operation));
      setFailureOperation(isApiError(error) && ["E_NETWORK", "E_UPSTREAM", "E_UPSTREAM_TIMEOUT", "E_RATE_LIMITED"].includes(error.code) ? operation : null);
    }
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
    if (phase !== "idle") return;
    setPhase("requesting");
    try {
      const state = await (operation === "StartScan" ? requestDiscoveryScan(selfRef) : fetchDiscoveryScanStatus(selfRef));
      if (settle(state)) return;
      setFeedback(null);
      setFailureOperation(null);
      deadlineRef.current = Date.now() + DISCOVERY_SCAN_TIMEOUT_MS;
      setPhase("polling");
    } catch (error) { failed(error, operation); }
  }, [failed, phase, selfRef, settle]);
  return { phase, feedback, canRetry: failureOperation !== null, defectState, start: () => begin("StartScan"), retry: () => begin(failureOperation ?? "StartScan") };
}
