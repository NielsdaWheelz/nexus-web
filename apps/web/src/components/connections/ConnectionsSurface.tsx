"use client";

import {admissionReason, UNKNOWN_OUTCOME_REASON} from "@/lib/api/failure";
import * as Icon from "@/lib/ui/icons";

// User links, mentions and embeds are local authored facts and render from the
// device store online and offline. Server facts render in their own section,
// which may fail without hiding local writing. Until anything has shown, the body
// is a ruling; a local storage failure says so until its rows have shown, and a
// defect in any local read throws to the boundary.
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Fact } from "@/components/feedback/Fact";
import { Hold, useOutcome, useResendFeedback } from "@/components/feedback/Feedback";
import { Ruling } from "@/components/feedback/Ruling";
import type { CommandVerb } from "@/components/feedback/stage";
import AuthoredReadFailure from "@/components/notes/AuthoredReadFailure";
import LocalOutline from "@/components/notes/LocalOutline";
import Button from "@/components/ui/Button";
import ResourceOutlineList from "@/components/resources/ResourceOutlineList";
import ResourceOutlineRow from "@/components/resources/ResourceOutlineRow";
import ContextualActionMenu from "@/components/resources/ContextualActionMenu";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { useResourceDraft } from "@/lib/resourceGraph/useResourceDraft";
import { resolvePaneRouteModel } from "@/lib/panes/paneRouteModel";
import { usePaneVisitWorkScope } from "@/lib/workspace/paneReturnMemento";
import { useLatestWorkspace } from "@/lib/workspace/store";
import { useChangeStamp } from "@/lib/api/changes";
import { outcomeUnknown } from "@/lib/api/client";
import { modeledApiError } from "@/lib/api/serverState";
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
  const scanReasonId = useId();
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
          {scannable ? <Button type="button" iconOnly aria-label="Find connections" onClick={scan.start} aria-disabled={scan.blocked || undefined} aria-busy={scan.busy || undefined} aria-describedby={scan.reason ? scanReasonId : undefined} icon={<Icon.Search size={14} aria-hidden="true" />} /> : null}
        </div>
      </div>

      {scan.reason ? <span id={scanReasonId} className="sr-only">{scan.reason}</span> : null}
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

type ScanState = {
  phase: "idle" | "requesting" | "polling";
  operation: { command: ScanCommand } | null;
  held: { kind: "Unsure" | "Waiting"; attempt: number } | null;
  deadline: number;
  defect: { error: unknown } | null;
};

/** A visit retains unknown starts while its companion is closed. Acknowledged starts settle
 * their own intent; passive status has no command identity and cannot settle an unknown start.
 * Reopening reveals recovery; the existing visit guard owns deliberate departure. */
function useDiscoveryScan({ selfRef, enabled, onSettled }: {
  selfRef: string; enabled: boolean; onSettled: () => void;
}) {
  const { say, fail } = useOutcome();
  const resendFeedback = useResendFeedback();
  const { ctx } = useActionRuntime();
  const account = ctx.sessionSignal();
  const scope = usePaneVisitWorkScope();
  const workspace = useLatestWorkspace();
  const owned = () => !account.aborted && workspace().state.panes.some(pane => [pane.current_visit, ...pane.history.back, ...pane.history.forward]
    .some(visit => visit.id === scope.visitId && resolvePaneRouteModel(visit.href).routeKey === scope.routeKey));
  const owner = useResourceDraft<ScanState>(`Connections.Scan:${selfRef}`, () => ({ phase: "idle", operation: null, held: null, deadline: 0, defect: null }),
    value => ({ changed: false, unconfirmed: value.operation?.command === "StartScan" || value.held?.kind === "Unsure", stopsBrowserWork: false }));
  const mounted = useRef(false);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const { phase, held } = owner.value;
  const hold = (kind: "Unsure" | "Waiting") => owner.set(current => ({ ...current, phase: "idle", operation: null,
    held: { kind, attempt: current.held?.kind === kind ? current.held.attempt + 1 : 0 } }));
  const controls = useRef({ start: false, check: false });
  const verb = (command: ScanCommand): CommandVerb => ({
    label: command === "StartScan" ? "retry" : "check", commandKey: `Connections.Scan:${selfRef}:${command}`,
    run: () => void begin(command), busy: phase !== "idle",
  });
  const start = verb("StartScan");
  const check = verb("ScanStatus");
  const startFeedback = resendFeedback({ line: { fact: "not sure the scan started.", reason: UNKNOWN_OUTCOME_REASON }, resend: start });
  const checkFeedback = resendFeedback({ line: { fact: "still finding connections." }, resend: check });
  const primary = startFeedback.verbs?.[0];
  const statusPrimary = checkFeedback.verbs?.[0];
  controls.current = {
    start: primary !== undefined && "commandKey" in primary && primary.commandKey === start.commandKey && !primary.busy && !primary.disabledReason,
    check: statusPrimary !== undefined && "commandKey" in statusPrimary && statusPrimary.commandKey === check.commandKey && !statusPrimary.busy && !statusPrimary.disabledReason,
  };
  const settle = (state: DiscoveryScanStatus) => {
    if (state.status === "pending" || state.status === "running") return false;
    const unsure = owner.read().held?.kind === "Unsure";
    owner.set(current => ({ ...current, phase: "idle", operation: null, held: unsure ? current.held : null }));
    if (!unsure && mounted.current) {
      if (state.status === "failed" || state.outcome === "terminal_failed") say({ fact: "the scan didn’t finish." }, [verb("StartScan")]);
      else if (state.outcome === "skipped") say({ fact: "the scan ended without changes." });
      else if (state.outcome === null) say({ fact: "no scan result is available." });
    }
    if (mounted.current) onSettled();
    return true;
  };
  const defect = (failure: { error: unknown }) => owner.set(current => ({ ...current, defect: failure }));
  const failed = (error: unknown, command: ScanCommand) => {
    owner.set(current => ({ ...current, phase: "idle", operation: null }));
    if (handleUnauthenticatedApiError(error)) return;
    const failure = modeledApiError(error, defect);
    if (failure === null) return;
    if (command === "StartScan" && (outcomeUnknown(failure) || owner.read().held?.kind === "Unsure")) hold("Unsure");
    else if (mounted.current) fail(failure, command === "StartScan" ? "couldn’t start the scan." : "couldn’t check the scan.", verb(command));
  };
  async function begin(command: ScanCommand) {
    if (!mounted.current || !owned() || owner.read().phase !== "idle" || !(command === "StartScan" ? controls.current.start : controls.current.check)) return;
    const operation = { command };
    owner.set(current => ({ ...current, phase: "requesting", operation }));
    const current = () => owned() && owner.read().operation === operation;
    try {
      const state = await (command === "StartScan" ? requestDiscoveryScan(selfRef) : fetchDiscoveryScanStatus(selfRef));
      if (!current()) return;
      if (command === "StartScan") owner.set(value => ({ ...value, held: null }));
      if (settle(state)) return;
      owner.set(value => ({ ...value, operation: null, phase: "polling", deadline: Date.now() + DISCOVERY_SCAN_TIMEOUT_MS }));
    } catch (error) { if (current()) failed(error, command); }
  }
  // An auxiliary read resumes only an active job; old outcomes are no news and cannot answer a
  // pending start. Its snapshot fence also prevents a late read from replacing deliberate work.
  useEffect(() => {
    if (!enabled || owner.read().phase !== "idle") return;
    let cancelled = false;
    const snapshot = owner.read();
    void fetchDiscoveryScanStatus(selfRef).then(state => {
      if (cancelled || !owned() || owner.read() !== snapshot || state.status === "idle" || state.status === "failed") return;
      owner.set(current => ({ ...current, phase: "polling", deadline: Date.now() + DISCOVERY_SCAN_TIMEOUT_MS }));
    }, (error: unknown) => { if (!cancelled && owned()) modeledApiError(error, defect); });
    return () => { cancelled = true; };
    // The retained cell and exact source belong to this mount; updates must not restart its read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, selfRef]);
  // justify-polling: user-requested background work has no SSE plane; poll at
  // 2s for at most 45s, then hold the scan as still running, with a status read.
  useIntervalPoll({ enabled: phase === "polling", pollIntervalMs: DISCOVERY_SCAN_POLL_MS, onPoll: async () => {
    const snapshot = owner.read();
    if (!owned() || snapshot.phase !== "polling") return;
    try {
      const state = await fetchDiscoveryScanStatus(selfRef);
      if (!owned() || owner.read() !== snapshot) return;
      if (settle(state) || Date.now() < snapshot.deadline) return;
      if (snapshot.held?.kind === "Unsure") owner.set(current => ({ ...current, phase: "idle" }));
      else hold("Waiting");
    } catch (error) { if (owned() && owner.read() === snapshot) failed(error, "ScanStatus"); }
  } });
  if (owner.value.defect) throw owner.value.defect.error;
  return {
    start: () => void begin("StartScan"), blocked: !controls.current.start,
    busy: phase !== "idle" || primary?.busy === true,
    reason: primary?.disabledReason ?? (!controls.current.start ? admissionReason() : null),
    held: held && <Hold id={`Connections.Scan:${selfRef}:${held.kind}`} attempt={held.attempt}
      {...(held.kind === "Unsure" ? startFeedback : checkFeedback)} />,
  };
}
