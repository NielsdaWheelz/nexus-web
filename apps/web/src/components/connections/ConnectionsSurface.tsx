"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Link, Paperclip, Sparkles } from "lucide-react";
import { FeedbackNotice, useFeedback, type FeedbackContent } from "@/components/feedback/Feedback";
import ContextEdgeMenu from "@/components/resources/ContextEdgeMenu";
import ResourceActionMenu from "@/components/resources/ResourceActionMenu";
import Button from "@/components/ui/Button";
import MachineText from "@/components/ui/MachineText";
import { isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { useResource } from "@/lib/api/useResource";
import { useCursorPagination, type CursorPage } from "@/lib/api/useCursorPagination";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { getFileUploadError, uploadIngestFile } from "@/lib/media/ingestionClient";
import { mediaCaptureErrorMessage } from "@/lib/media/captureFeedback";
import { queryConnections, type ConnectionOut } from "@/lib/resourceGraph/connections";
import { connectionMutationAction, connectionMutationErrorMessage, mutateConnection } from "@/lib/resourceGraph/connectionMutations";
import { subscribeLinkMutations } from "@/lib/resourceGraph/links";
import { formatResourceRef, type ResourceRef } from "@/lib/resourceGraph/resourceRef";
import { activateResource, hrefForResourceActivation } from "@/lib/resources/activation";
import { workspaceTargetClickIntent } from "@/lib/panes/targetLinkActivation";
import type { WorkspaceTarget, WorkspaceTargetDisposition } from "@/lib/workspace/targetActivation";
import { CONNECTION_DISCOVERY_SOURCE_SCHEMES } from "@/lib/resources/resourceCapabilities";
import { resourceIconForUri } from "@/lib/resources/resourceKind";
import { useResourceOverlaysController } from "@/lib/resources/resourceOverlaysController";
import { fetchDiscoveryScanStatus, requestDiscoveryScan, type DiscoveryScanStatus } from "@/lib/connectionDiscovery";
import { useIntervalPoll } from "@/lib/useIntervalPoll";
import ConnectionCreation from "./ConnectionCreation";
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

export default function ConnectionsSurface({ resourceRef, activateTarget, refreshKey = 0 }: {
  resourceRef: ResourceRef;
  refreshKey?: number;
  activateTarget: (input: { target: WorkspaceTarget; disposition: WorkspaceTargetDisposition }) => void;
}) {
  const selfRef = formatResourceRef(resourceRef);
  const { linkComposer } = useResourceOverlaysController();
  const feedback = useFeedback();
  const [refreshTick, setRefreshTick] = useState(0);
  const [attaching, setAttaching] = useState(false);
  const attachingRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const linkButtonRef = useRef<HTMLButtonElement>(null);
  const loadedBoundaryRef = useRef<{ ref: string; edgeId: string } | null>(null);
  const retainedPageRef = useRef<{ ref: string; page: CursorPage<ConnectionOut> } | null>(null);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const reload = useCallback(() => setRefreshTick((value) => value + 1), []);
  useEffect(() => subscribeLinkMutations(reload), [reload]);
  const load = useCallback(async (cursor: string | null, signal: AbortSignal): Promise<CursorPage<ConnectionOut>> => {
    const boundary = cursor === null && loadedBoundaryRef.current?.ref === selfRef
      ? loadedBoundaryRef.current.edgeId : null;
    const data: ConnectionOut[] = [];
    let next = cursor;
    do {
      const page = await queryConnections({ refs: [selfRef], direction: "both", rollup: "owner", limit: 100, cursor: next }, { signal });
      data.push(...page.items);
      next = page.next_cursor;
      // Refresh through the previously visible last row, even when new rows
      // push it onto a later page. If that row was removed, reach the new end.
      if (boundary === null || page.items.some((row) => row.edge_id === boundary)) break;
    } while (next !== null);
    return { data, page: { has_more: next !== null, next_cursor: next } };
  }, [selfRef]);
  const firstPage = useResource<CursorPage<ConnectionOut>>({ cacheKey: `${selfRef}:${refreshKey}:${refreshTick}`, load: (signal) => load(null, signal) });
  if (firstPage.status === "ready") retainedPageRef.current = { ref: selfRef, page: firstPage.data };
  const retained = retainedPageRef.current?.ref === selfRef ? retainedPageRef.current.page : null;
  const pages = useCursorPagination({ firstPage: retained ? { status: "ready", data: retained } : firstPage, initialMoreError: null, loadMorePage: load, loadMoreEnabled: firstPage.status === "ready" });
  const lastLoaded = pages.items.at(-1);
  loadedBoundaryRef.current = lastLoaded ? { ref: selfRef, edgeId: lastLoaded.edge_id } : null;
  const loading = firstPage.status === "loading";
  const loadError = firstPage.status === "error" ? firstPage.error : pages.error;
  const scannable = (CONNECTION_DISCOVERY_SOURCE_SCHEMES as readonly string[]).includes(resourceRef.scheme);
  const scan = useDiscoveryScan({ selfRef, enabled: scannable, onSettled: reload });
  const scanning = scan.phase !== "idle";

  async function attachFiles(files: File[]) {
    if (attachingRef.current) return;
    attachingRef.current = true;
    setAttaching(true);
    try {
      for (const file of files) {
        const invalid = getFileUploadError(file);
        if (invalid) {
          feedback.publish({ kind: "Hud", content: { tone: "Warning", title: "File wasn’t added", message: invalid } });
          continue;
        }
        let uploaded;
        try { uploaded = await uploadIngestFile({ file, libraryIds: [] }); }
        catch (error) {
          if (handleUnauthenticatedApiError(error)) return;
          feedback.publish({ kind: "Persistent", key: `connection-upload:${selfRef}:${file.name}`, announcement: "Polite", content: mediaCaptureErrorMessage(error, "AddAttachment") });
          continue;
        }
        // The app-owned link session retains this saved media and frozen mutation
        // for retries after this pane closes. Undo removes only the link.
        await linkComposer.linkTo({ source: { kind: "resource", ref: selfRef }, sourceRef: selfRef, label: "saved file", target: { kind: "resource", ref: `media:${uploaded.mediaId}` }, targetLabel: file.name, savedFile: true });
      }
    } catch (error) { setDefect({ error }); }
    finally {
      attachingRef.current = false;
      setAttaching(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }
  if (defect) throw defect.error;
  if (scan.defectState) throw scan.defectState.error;
  return (
    <section className={styles.backlinks} aria-label="Connections"
      onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }}
      onDrop={(event) => { const files = Array.from(event.dataTransfer.files); if (files.length) { event.preventDefault(); void attachFiles(files); } }}>
      <div className={styles.header}>
        <h2 className={styles.title}>Connections</h2>
        <div className={styles.headerActions}>
          <Button ref={linkButtonRef} type="button" variant="ghost" size="sm" onClick={() => void linkComposer.openResourceLink(selfRef)}><Link size={14} aria-hidden="true" /> Link…</Button>
          <Button type="button" variant="ghost" size="sm" iconOnly loading={attaching} aria-label="Upload and link file" title="Upload and link file" onClick={() => fileInputRef.current?.click()}><Paperclip size={14} aria-hidden="true" /></Button>
          {scannable ? <Button type="button" variant="ghost" size="sm" iconOnly loading={scanning} aria-label="Find connections" title="Find connections" onClick={() => void scan.start()}><Sparkles size={14} aria-hidden="true" /></Button> : null}
        </div>
      </div>
      {resourceRef.scheme === "conversation" ? <p className={styles.connectionMeta}>Linked items are available to future replies in this chat.</p> : null}
      <input ref={fileInputRef} className={styles.fileInput} type="file" multiple tabIndex={-1} aria-hidden="true" onChange={(event) => void attachFiles(Array.from(event.currentTarget.files ?? []))} />
      {scan.feedback ? <FeedbackNotice content={scan.feedback} announcement="Assertive" actions={[{ label: "Retry", onClick: () => void scan.retry() }]} /> : null}
      {scanning ? <p role="status" className={styles.scanVoice}>Finding connections…</p> : null}
      {attaching ? <p role="status" className={styles.scanVoice}>Uploading and linking… Closing this pane keeps the submitted upload running.</p> : null}
      {loading ? <p role="status" className={styles.empty}>{retained ? "Refreshing connections…" : "Loading connections…"}</p> : null}
      {loadError ? <FeedbackNotice content={connectionErrorMessage(loadError, "Load")} announcement="Assertive" actions={[{ label: "Retry", onClick: firstPage.status === "error" ? firstPage.retry : pages.retry }]} /> : null}
      {firstPage.status === "ready" && pages.items.length === 0 ? <p className={styles.empty}>No connections yet. Link an item to connect it here.</p> : null}
      <div className={styles.list}>
        {pages.items.map((connection) => <ConnectionRow key={connection.edge_id} connection={connection} onChanged={(row) => {
          if (row?.contains(document.activeElement)) linkButtonRef.current?.focus();
          reload();
        }}
          onOpen={(disposition) => activateResource(connection.other.activation, { labelHint: connection.other.label ?? connection.other.ref, activateTarget, disposition })}
          onOpenNote={(disposition) => { if (connection.link_note) activateTarget({ target: { href: `/notes/${connection.link_note.note_block_id}`, labelHint: "Note on link" }, disposition }); }} />)}
      </div>
      {pages.hasMore ? <Button type="button" variant="ghost" size="sm" disabled={firstPage.status !== "ready"} loading={pages.loadingMore} onClick={pages.loadMore}>Load more</Button> : null}
    </section>
  );
}

function ConnectionRow({ connection, onOpen, onOpenNote, onChanged }: {
  connection: ConnectionOut;
  onOpen: (disposition: WorkspaceTargetDisposition) => void;
  onOpenNote: (disposition: WorkspaceTargetDisposition) => void;
  onChanged: (row: HTMLDivElement | null) => void;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const endpoint = connection.other;
  const Icon = resourceIconForUri(endpoint.ref);
  const missing = endpoint.missing || hrefForResourceActivation(endpoint.activation) === null;
  const machine = connection.origin === "discovery" || connection.origin === "assistant";
  const reason = connection.mutation?.kind === "detach_context"
    ? connection.origin === "citation" ? "Chat context · citation" : "Chat context · system"
    : machine ? "Machine-created link" : connection.origin === "user" ? "Linked by you" : connection.origin === "citation" ? connection.direction === "incoming" ? "Cited by" : "Cites" : connection.origin === "system" ? "Added to chat" : connection.origin === "document_embed" ? "Attachment" : connection.origin === "link_note" ? "Note on link" : "Note attachment";
  const excerpt = connection.snapshot?.excerpt;
  const mutation = connection.mutation;
  const action = mutation ? connectionMutationAction(mutation) : null;
  return (
    <div ref={rowRef} className={`${styles.linkRow}${missing ? ` ${styles.missing}` : ""}`}>
      <button type="button" className={styles.linkButton} disabled={missing} onClick={(event) => onOpen(workspaceTargetClickIntent(event).disposition)}>
        <Icon size={14} aria-hidden="true" />
        <span className={styles.connectionText}>
          <span>{endpoint.label ?? endpoint.ref}</span>
          <span className={styles.connectionMeta}>{missing ? "Unavailable · " : ""}{reason}{connection.origin === "discovery" ? " · Connection discovery" : connection.origin === "assistant" ? " · Assistant" : ""}</span>
          {typeof excerpt === "string" && excerpt ? machine ? <MachineText variant="inline" as="span" origin={{ label: connection.origin === "discovery" ? "Connection discovery" : "Assistant" }} className={styles.rationale}>{excerpt}</MachineText> : <span className={styles.rationale}>{excerpt}</span> : null}
          {connection.mutation?.kind === "dismiss_discovery" ? <span className={styles.connectionMeta}>Dismissing hides this link and prevents rediscovery of this pair.</span> : null}
        </span>
      </button>
      <ResourceActionMenu actionSubject={endpoint.actionSubject} label={`Actions for ${endpoint.label}`} />
      {action && mutation ? <ContextEdgeMenu action={action} label={`Edit connection ${endpoint.label}`} retryable execute={async () => { await mutateConnection(connection.edge_id, mutation); onChanged(rowRef.current); }} presentFailure={connectionMutationErrorMessage} /> : null}
      {connection.creation ? <div className={styles.creation}><ConnectionCreation creation={connection.creation} /></div> : null}
      {connection.link_note ? <button type="button" className={styles.linkNote} onClick={(event) => onOpenNote(workspaceTargetClickIntent(event).disposition)} aria-label={`Open note on link ${endpoint.label ?? endpoint.ref}`}>
        <span className={styles.connectionMeta}>Note on link</span>
        <span>{connection.link_note.preview ?? "Open note"}</span>
      </button> : null}
    </div>
  );
}

const DISCOVERY_SCAN_POLL_MS = 2000;
const DISCOVERY_SCAN_TIMEOUT_MS = 45_000;

/**
 * The manual-scan lifecycle for a scannable ref: request → bounded status poll
 * → settle. `onSettled` fires once per finished scan — idle status reached,
 * the request short-circuiting to idle, or the 45s deadline lapsing.
 */
function useDiscoveryScan({
  selfRef,
  enabled,
  onSettled,
}: {
  selfRef: string;
  enabled: boolean;
  onSettled: () => void;
}): {
  phase: "idle" | "requesting" | "polling";
  feedback: FeedbackContent | null;
  defectState: { error: unknown } | null;
  start: () => Promise<void>;
  retry: () => Promise<void>;
} {
  const [phase, setPhase] = useState<"idle" | "requesting" | "polling">("idle");
  const [feedback, setFeedback] = useState<FeedbackContent | null>(null);
  const [failureOperation, setFailureOperation] = useState<
    "ScanStatus" | "StartScan" | null
  >(null);
  const [defectState, setDefectState] = useState<{ error: unknown } | null>(null);
  const deadlineRef = useRef(0);

  // A tab switch unmounts the section mid-scan; one status read on mount
  // resumes the poll (with a fresh deadline) when a scan is still in flight.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void fetchDiscoveryScanStatus(selfRef)
      .then((status) => {
        if (cancelled || status === "idle") return;
        deadlineRef.current = Date.now() + DISCOVERY_SCAN_TIMEOUT_MS;
        setPhase("polling");
      })
      .catch((err) => {
        // Best-effort resume probe; a manual scan surfaces real errors.
        if (cancelled || handleUnauthenticatedApiError(err)) return;
        try {
          connectionErrorMessage(err, "ScanStatus");
        } catch (caughtDefect) {
          setDefectState({ error: caughtDefect });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, selfRef]);

  // justify-polling: scans run on the background worker with no SSE plane
  // (discovery worker); the poll is user-initiated, 2s, and self-bounds at the
  // 45s scan deadline.
  useIntervalPoll({
    enabled: phase === "polling",
    pollIntervalMs: DISCOVERY_SCAN_POLL_MS,
    onPoll: async () => {
      try {
        const status = await fetchDiscoveryScanStatus(selfRef);
        if (status !== "idle" && Date.now() < deadlineRef.current) return;
        setPhase("idle");
        onSettled();
      } catch (err) {
        setPhase("idle");
        if (handleUnauthenticatedApiError(err)) return;
        try {
          setFeedback(connectionErrorMessage(err, "ScanStatus"));
          setFailureOperation("ScanStatus");
        } catch (caughtDefect) {
          setDefectState({ error: caughtDefect });
        }
      }
    },
  });

  // One begin: read the scan status (by starting a scan, or by reading the
  // status of one already running) and either settle or poll to the deadline.
  const begin = useCallback(
    async (
      read: () => Promise<DiscoveryScanStatus>,
      operation: "StartScan" | "ScanStatus",
    ) => {
      setFeedback(null);
      setFailureOperation(null);
      setPhase("requesting");
      try {
        const status = await read();
        if (status === "idle") {
          // Engine disabled or the scan already finished: nothing to poll.
          setPhase("idle");
          onSettled();
          return;
        }
        deadlineRef.current = Date.now() + DISCOVERY_SCAN_TIMEOUT_MS;
        setPhase("polling");
      } catch (err) {
        setPhase("idle");
        if (handleUnauthenticatedApiError(err)) return;
        try {
          setFeedback(connectionErrorMessage(err, operation));
          setFailureOperation(operation);
        } catch (caughtDefect) {
          setDefectState({ error: caughtDefect });
        }
      }
    },
    [onSettled],
  );

  const start = useCallback(
    () => begin(async () => (await requestDiscoveryScan(selfRef)).status, "StartScan"),
    [begin, selfRef],
  );

  const retryStatus = useCallback(
    () => begin(() => fetchDiscoveryScanStatus(selfRef), "ScanStatus"),
    [begin, selfRef],
  );

  return {
    phase,
    feedback,
    defectState,
    start,
    retry: failureOperation === "ScanStatus" ? retryStatus : start,
  };
}
