"use client";

// User links, mentions and embeds are local authored facts and render from the
// device store online and offline. Server facts render in their own section,
// which may fail without hiding local writing.
import { useCallback, useEffect, useRef, useState } from "react";
import { Sparkles } from "lucide-react";
import { FeedbackNotice, FeedbackStatus, type FeedbackContent } from "@/components/feedback/Feedback";
import useCollectionReadFeedback from "@/components/collections/useCollectionReadFeedback";
import LocalOutline from "@/components/notes/LocalOutline";
import Button from "@/components/ui/Button";
import ResourceOutlineList from "@/components/resources/ResourceOutlineList";
import ResourceOutlineRow from "@/components/resources/ResourceOutlineRow";
import ContextualActionMenu from "@/components/resources/ContextualActionMenu";
import { useChangeStamp } from "@/lib/api/changes";
import { apiTransportFeedback, isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { fetchDiscoveryScanStatus, requestDiscoveryScan, type DiscoveryScanStatus } from "@/lib/connectionDiscovery";
import { useAuthoredPages, useAuthoredQuery } from "@/lib/notes/hooks";
import { formatResourceRef, type ResourceRef } from "@/lib/resourceGraph/resourceRef";
import { CONNECTION_DISCOVERY_SOURCE_SCHEMES } from "@/lib/resources/resourceCapabilities";
import { assumeCanonicalResourceRef } from "@/lib/sharing/targets";
import { useIntervalPoll } from "@/lib/useIntervalPoll";
import RemoteConnections, { useRemoteConnections } from "./RemoteConnections";
import { useConnectionAttachments } from "./useConnectionAttachments";
import styles from "./ConnectionsSurface.module.css";

function scanErrorMessage(error: unknown, operation: "ScanStatus" | "StartScan"): FeedbackContent {
  if (!isApiError(error) || isSameSystemApiDefect(error)) throw error;
  const title = operation === "ScanStatus" ? "Scan status couldn’t be checked" : "scan request not confirmed";
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
  const section = useRef<HTMLElement>(null);
  const attachments = useConnectionAttachments(selfRef);
  const metadata = useChangeStamp("Metadata");
  const [refreshTick, setRefreshTick] = useState(0);
  const reload = useCallback(() => setRefreshTick((value) => value + 1), []);
  const remote = useRemoteConnections(selfRef, `connections:${selfRef}`, `${refreshKey}:${refreshTick}:${metadata}`);
  const readFeedback = useCollectionReadFeedback({
    list: remote, unit: { singular: "connection", plural: "connections" }, waiting: false, outcome: null,
    returnFocus: () => section.current,
  });
  const self = useAuthoredQuery({ kind: "resource", ref: selfRef });
  const linked = useAuthoredQuery({ kind: "adjacency", ref: selfRef, cursor: null, limit: 1 });
  const mentions = useAuthoredPages({ kind: "backlinks", ref: selfRef, cursor: null, limit: 100 });
  const embedded = self.data?.rows[0]?.resource.embedded_refs ?? [];
  const localError = self.error ?? linked.error ?? mentions.error;
  const scannable = (CONNECTION_DISCOVERY_SOURCE_SCHEMES as readonly string[]).includes(resourceRef.scheme);
  const scan = useDiscoveryScan({ selfRef, enabled: scannable, onSettled: reload });
  const scanning = scan.phase !== "idle";
  const empty = linked.data?.rows.length === 0 && mentions.data?.rows.length === 0 && self.data !== null &&
    embedded.length === 0 && remote.complete && remote.running === null && remote.items.length === 0;

  if (scan.defectState) throw scan.defectState.error;
  return (
    <section ref={section} tabIndex={-1} className={styles.section} aria-label="Connections"
      {...attachments.dropProps}>
      <div className={styles.header}>
        <h2 className={styles.title}>Connections</h2>
        <div className={styles.headerActions}>
          <ContextualActionMenu resourceRef={assumeCanonicalResourceRef(selfRef)} title="connections" subjectKey={`connections:${selfRef}`} label="more actions for connections" sections={[]} />
          {attachments.control}
          {scannable ? <Button type="button" iconOnly aria-label="Find connections" onClick={() => void scan.start()} disabled={scanning} aria-busy={scanning} icon={<Sparkles size={14} aria-hidden="true" />} /> : null}
        </div>
      </div>

      {scan.feedback ? <FeedbackNotice content={scan.feedback} announcement="Polite" actions={scan.canRetry ? [{ label: "retry scan", onClick: () => void scan.retry(), busy: scanning }] : undefined} /> : null}
      {scanning && scan.feedback === null ? <FeedbackStatus content={{ tone: "Neutral", title: "finding connections…" }} announcement="Polite" /> : null}
      {attachments.attaching ? <FeedbackStatus content={{ tone: "Neutral", title: "uploading and linking…", message: "closing this pane keeps the submitted upload running." }} announcement="Polite" /> : null}
      {localError ? <FeedbackNotice content={{ tone: "Warning", title: "couldn’t read connections on this device" }} announcement="Polite"
        actions={[{ label: "retry", onClick: () => { self.retry(); linked.retry(); mentions.retry(); } }]} /> : null}
      {empty ? <FeedbackStatus content={{ tone: "Neutral", title: "no connections yet" }} announcement="None" /> : null}
      <LocalOutline rootRef={selfRef} ancestors={[selfRef]} occurrencePrefix={`connections:${selfRef}`} />
      {mentions.data?.rows.length ? <section aria-label="mentioned in">
        <h3 className={styles.subtitle}>mentioned in</h3>
        <ResourceOutlineList scope={`mentions:${selfRef}`} ariaLabel="mentioned in" ancestorRef={selfRef}>
          {mentions.data.rows.map(({ resource }) => <ResourceOutlineRow key={resource.ref} resourceRef={resource.ref}
            occurrenceKey={`connections:${selfRef}/mention:${resource.ref}`} incoming={null} />)}
        </ResourceOutlineList>
        {mentions.data.next_cursor !== null ? <Button type="button" onClick={mentions.more}>show more</Button> : null}
      </section> : null}
      {embedded.length ? <section aria-label="embedded in this note">
        <h3 className={styles.subtitle}>embedded in this note</h3>
        <ResourceOutlineList scope={`embeds:${selfRef}`} ariaLabel="embedded in this note" ancestorRef={selfRef}>
          {embedded.map((ref) => <ResourceOutlineRow key={ref} resourceRef={ref} occurrenceKey={`connections:${selfRef}/embed:${ref}`} incoming={null} />)}
        </ResourceOutlineList>
      </section> : null}
      <RemoteConnections ownerRef={selfRef} occurrencePrefix={`connections:${selfRef}`} list={remote} onChanged={reload} />
      {readFeedback.notice}
      {readFeedback.announcement}
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
      setFeedback(scanErrorMessage(error, operation));
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
