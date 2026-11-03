"use client";

import {UNKNOWN_OUTCOME_REASON} from "@/lib/api/failure";
import * as Icon from "@/lib/ui/icons";

// User links, mentions and embeds are local authored facts and render from the
// device store online and offline. Server facts render in their own section,
// which may fail without hiding local writing. Until anything has shown, the body
// is a ruling; a local storage failure says so until its rows have shown, and a
// defect in any local read throws to the boundary.
import { useCallback, useEffect, useRef, useState } from "react";
import { Fact } from "@/components/feedback/Fact";
import { Hold, useOutcome } from "@/components/feedback/Feedback";
import { Ruling } from "@/components/feedback/Ruling";
import type { CommandVerb } from "@/components/feedback/stage";
import AuthoredReadFailure from "@/components/notes/AuthoredReadFailure";
import LocalOutline from "@/components/notes/LocalOutline";
import Button from "@/components/ui/Button";
import ResourceOutlineList from "@/components/resources/ResourceOutlineList";
import ResourceOutlineRow from "@/components/resources/ResourceOutlineRow";
import ContextualActionMenu from "@/components/resources/ContextualActionMenu";
import { useChangeStamp } from "@/lib/api/changes";
import { outcomeUnknown } from "@/lib/api/client";
import { modeledApiError, useThrowLater } from "@/lib/api/serverState";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { fetchDiscoveryScanStatus, requestDiscoveryScan, type DiscoveryScanStatus } from "@/lib/connectionDiscovery";
import { useAuthoredPages, useAuthoredQuery } from "@/lib/notes/hooks";
import { isAuthoredStorageFailure } from "@/lib/notes/runtime";
import { formatResourceRef, type ResourceRef } from "@/lib/resourceGraph/resourceRef";
import { CONNECTION_DISCOVERY_SOURCE_SCHEMES } from "@/lib/resources/resourceCapabilities";
import { assumeCanonicalResourceRef } from "@/lib/sharing/targets";
import { useIntervalPoll } from "@/lib/useIntervalPoll";
import RemoteConnections, { useRemoteConnections } from "./RemoteConnections";
import { useConnectionAttachments } from "./useConnectionAttachments";
import styles from "./ConnectionsSurface.module.css";

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
  const self = useAuthoredQuery({ kind: "resource", ref: selfRef });
  const linked = useAuthoredQuery({ kind: "adjacency", ref: selfRef, cursor: null, limit: 1 });
  const mentions = useAuthoredPages({ kind: "backlinks", ref: selfRef, cursor: null, limit: 100 });
  const embedded = self.data?.rows[0]?.resource.embedded_refs ?? [];
  const scannable = (CONNECTION_DISCOVERY_SOURCE_SCHEMES as readonly string[]).includes(resourceRef.scheme);
  const scan = useDiscoveryScan({ selfRef, enabled: scannable, onSettled: reload });
  const scanning = scan.phase !== "idle";
  const local = [self, linked, mentions];
  for (const read of local) if (read.error !== null && !isAuthoredStorageFailure(read.error)) throw read.error;
  const unread = local.find(read => read.error !== null && read.data === null);
  const empty = linked.data?.rows.length === 0 && mentions.data?.rows.length === 0 && self.data !== null &&
    embedded.length === 0 && remote.complete && remote.items.length === 0;
  const shown = Boolean(linked.data?.rows.length || mentions.data?.rows.length || embedded.length || remote.items.length);
  const opening = !shown && unread === undefined && remote.status !== "failed"
    && (local.some(read => read.data === null && read.pending) || remote.status === "loading");

  return (
    <section ref={section} tabIndex={-1} className={styles.section} aria-label="Connections"
      {...attachments.dropProps}>
      <div className={styles.header}>
        <h2 className={styles.title}>Connections</h2>
        <div className={styles.headerActions}>
          <ContextualActionMenu navigation={null} resourceRef={assumeCanonicalResourceRef(selfRef)} title="connections" subjectKey={`connections:${selfRef}`} label="more actions for connections" sections={[]} />
          {attachments.control}
          {scannable ? <Button type="button" iconOnly aria-label="Find connections" onClick={scan.start} disabled={scanning} aria-busy={scanning} icon={<Icon.Search size={14} aria-hidden="true" />} /> : null}
        </div>
      </div>

      {scan.held}
      {unread ? <AuthoredReadFailure {...unread} noun="connections"
        retry={() => {self.retry(); linked.retry(); mentions.retry();}}/> : null}
      {opening ? <Ruling /> : empty ? <Fact line={{ fact: "no connections yet." }} /> : null}
      <LocalOutline rootRef={selfRef} occurrencePrefix={`connections:${selfRef}`} />
      {mentions.data?.rows.length ? <section aria-label="mentioned in">
        <h3 className={styles.subtitle}>mentioned in</h3>
        <ResourceOutlineList scope={`mentions:${selfRef}`} ariaLabel="mentioned in" ancestorRef={selfRef}>
          {mentions.data.rows.map(({ resource }) => <ResourceOutlineRow key={resource.ref} resource={resource}
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
    </section>
  );
}

const DISCOVERY_SCAN_POLL_MS = 2000;
const DISCOVERY_SCAN_TIMEOUT_MS = 45_000;
type ScanCommand = "StartScan" | "ScanStatus";

/** The native job status owns liveness; only its explicit outcome proves success. What a scan
 * command leaves unknown holds: a start whose answer was lost, or a scan still running past the
 * watch. Held, its verb stays where it was; a later answer that settles the scan withdraws it. */
function useDiscoveryScan({ selfRef, enabled, onSettled }: {
  selfRef: string; enabled: boolean; onSettled: () => void;
}) {
  const { say, fail } = useOutcome();
  const [phase, setPhase] = useState<"idle" | "requesting" | "polling">("idle");
  const [held, setHeld] = useState<{ kind: "Unsure" | "Waiting"; attempt: number } | null>(null);
  const deadline = useRef(0);
  const hold = (kind: "Unsure" | "Waiting") => setHeld(current => ({ kind, attempt: current?.kind === kind ? current.attempt + 1 : 0 }));
  // `retry` sends a new scan; `check` only reads its status.
  const verb = (command: ScanCommand): CommandVerb => command === "StartScan"
    ? { label: "retry", commandKey: `Connections.Scan.start:${selfRef}`, run: () => void latest.current("StartScan") }
    : { label: "check", commandKey: `Connections.Scan.check:${selfRef}`, run: () => void latest.current("ScanStatus") };
  const settle = (state: DiscoveryScanStatus) => {
    if (state.status === "pending" || state.status === "running") return false;
    setPhase("idle");
    setHeld(null);
    if (state.status === "failed" || state.outcome === "terminal_failed") say({ fact: "the scan didn’t finish." }, [verb("StartScan")]);
    else if (state.outcome === "skipped" || state.outcome === null) say({ fact: "the scan ended without changes." });
    onSettled();
    return true;
  };
  const failed = (error: unknown, command: ScanCommand) => {
    setPhase("idle");
    if (handleUnauthenticatedApiError(error)) return;
    if (command === "StartScan" && outcomeUnknown(error)) hold("Unsure");
    else fail(error, command === "StartScan" ? "couldn’t start the scan." : "couldn’t check the scan.", verb(command));
  };
  const begin = async (command: ScanCommand) => {
    if (phase !== "idle") return;
    setPhase("requesting");
    try {
      const state = await (command === "StartScan" ? requestDiscoveryScan(selfRef) : fetchDiscoveryScanStatus(selfRef));
      if (settle(state)) return;
      setHeld(null);
      deadline.current = Date.now() + DISCOVERY_SCAN_TIMEOUT_MS;
      setPhase("polling");
    } catch (error) { failed(error, command); }
  };
  const latest = useRef(begin);
  latest.current = begin;
  const throwLater = useThrowLater();
  // A scan already running resumes its watch; one that ended before this visit is no news. This
  // read is auxiliary: a modeled failure says nothing, and a defect throws to the boundary.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void fetchDiscoveryScanStatus(selfRef).then((state) => {
      if (cancelled || state.status === "idle" || state.status === "failed") return;
      deadline.current = Date.now() + DISCOVERY_SCAN_TIMEOUT_MS;
      setPhase("polling");
    }, (error: unknown) => { if (!cancelled) modeledApiError(error, throwLater); });
    return () => { cancelled = true; };
  }, [enabled, selfRef, throwLater]);
  // justify-polling: user-requested background work has no SSE plane; poll at
  // 2s for at most 45s, then hold the scan as still running, with a status read.
  useIntervalPoll({ enabled: phase === "polling", pollIntervalMs: DISCOVERY_SCAN_POLL_MS, onPoll: async () => {
    try {
      if (settle(await fetchDiscoveryScanStatus(selfRef)) || Date.now() < deadline.current) return;
      setPhase("idle");
      hold("Waiting");
    } catch (error) { failed(error, "ScanStatus"); }
  } });
  return {
    phase,
    start: () => void begin("StartScan"),
    held: held && <Hold id={`Connections.Scan:${selfRef}:${held.kind}`} attempt={held.attempt}
      line={held.kind === "Unsure" ? { fact: "not sure the scan started.", reason: UNKNOWN_OUTCOME_REASON } : { fact: "still finding connections." }}
      verbs={[{ ...verb(held.kind === "Unsure" ? "StartScan" : "ScanStatus"), busy: phase !== "idle" }]} />,
  };
}
