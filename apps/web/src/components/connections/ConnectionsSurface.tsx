"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Link, Paperclip, Sparkles } from "lucide-react";
import { FeedbackNotice, useFeedback, type FeedbackContent } from "@/components/feedback/Feedback";
import ContextEdgeMenu from "@/components/resources/ContextEdgeMenu";
import ResourceActionMenu from "@/components/resources/ResourceActionMenu";
import Button from "@/components/ui/Button";
import MachineText from "@/components/ui/MachineText";
import ResourceList from "@/components/ui/ResourceList";
import ResourceRow from "@/components/ui/ResourceRow";
import { absent, present } from "@/lib/api/presence";
import { isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { useResource } from "@/lib/api/useResource";
import { useCursorPagination, type CursorPage } from "@/lib/api/useCursorPagination";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { getFileUploadError, uploadIngestFile } from "@/lib/media/ingestionClient";
import { mediaCaptureErrorMessage } from "@/lib/media/captureFeedback";
import {
  connectionMutationErrorMessage,
  mutateConnection,
  queryConnections,
  subscribeLinkMutations,
  type ConnectionOut,
} from "@/lib/resourceGraph/links";
import { formatResourceRef, type ResourceRef } from "@/lib/resourceGraph/resourceRef";
import { CONNECTION_DISCOVERY_SOURCE_SCHEMES } from "@/lib/resources/resourceCapabilities";
import { useResourceOverlaysController } from "@/lib/resources/resourceOverlaysController";
import { fetchDiscoveryScanStatus, requestDiscoveryScan, type DiscoveryScanStatus } from "@/lib/connectionDiscovery";
import { assumeCanonicalResourceRef } from "@/lib/sharing/targets";
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

export default function ConnectionsSurface({ resourceRef, refreshKey = 0 }: {
  resourceRef: ResourceRef;
  refreshKey?: number;
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
      const page = await queryConnections({ refs: [selfRef], direction: "both", rollup: "owner", limit: 100, cursor: next }, signal);
      data.push(...page.items);
      next = page.next_cursor;
      // Refresh through the previously visible last row, even when new rows
      // push it onto a later page. If that row was removed, reach the new end.
      if (boundary === null || page.items.some((row) => row.edge_id === boundary)) break;
    } while (next !== null);
    return { items: data, nextCursor: next === null ? absent() : present(next) };
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
    <section className={styles.section} aria-label="Connections"
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
      {scanning ? <p role="status" className={styles.voice}>Finding connections…</p> : null}
      {attaching ? <p role="status" className={styles.voice}>Uploading and linking… Closing this pane keeps the submitted upload running.</p> : null}
      {loading ? <p role="status" className={styles.empty}>{retained ? "Refreshing connections…" : "Loading connections…"}</p> : null}
      {loadError ? <FeedbackNotice content={connectionErrorMessage(loadError, "Load")} announcement="Assertive" actions={[{ label: "Retry", onClick: firstPage.status === "error" ? firstPage.retry : pages.retry }]} /> : null}
      {firstPage.status === "ready" && pages.items.length === 0 ? <p className={styles.empty}>No connections yet. Link an item to connect it here.</p> : null}
      <ResourceList ariaLabel="Connections">
        {pages.items.map((connection) => <ConnectionRow key={connection.edge_id} connection={connection} onChanged={() => {
          const focusedRow = document.activeElement?.closest<HTMLElement>("[data-connection-id]");
          if (focusedRow?.dataset.connectionId === connection.edge_id) linkButtonRef.current?.focus();
          reload();
        }} />)}
      </ResourceList>
      {pages.hasMore ? <Button type="button" variant="ghost" size="sm" disabled={firstPage.status !== "ready"} loading={pages.loadingMore} onClick={pages.loadMore}>Load more</Button> : null}
    </section>
  );
}

function ConnectionRow({ connection, onChanged }: {
  connection: ConnectionOut;
  onChanged: () => void;
}) {
  const endpoint = connection.other;
  const href = endpoint.activation.href;
  const missing = endpoint.missing || href === null;
  const machine = connection.origin === "discovery" || connection.origin === "assistant";
  const reason = connection.mutation?.kind === "detach_context"
    ? connection.origin === "citation" ? "Chat context · citation" : "Chat context · system"
    : machine ? "Machine-created link" : connection.origin === "user" ? "Linked by you" : connection.origin === "citation" ? connection.direction === "incoming" ? "Cited by" : "Cites" : connection.origin === "system" ? "Added to chat" : connection.origin === "document_embed" ? "Attachment" : connection.origin === "link_note" ? "Note on link" : "Note attachment";
  const excerpt = connection.snapshot?.excerpt;
  const mutation = connection.mutation;
  return <ResourceRow
    rootProps={{ "data-connection-id": connection.edge_id }}
    primary={missing ? { kind: "static" } : { kind: "link", href, paneLabelHint: endpoint.label ?? endpoint.ref }}
    title={endpoint.label ?? endpoint.ref}
    supporting={<>{missing ? "Unavailable · " : ""}{reason}{connection.origin === "discovery" ? " · Connection discovery" : connection.origin === "assistant" ? " · Assistant" : ""}</>}
    evidence={typeof excerpt === "string" && excerpt ? machine ? <MachineText variant="inline" as="span" origin={{ label: connection.origin === "discovery" ? "Connection discovery" : "Assistant" }}>{excerpt}</MachineText> : excerpt : undefined}
    actions={<>
      <ResourceActionMenu actionSubject={{ ref: assumeCanonicalResourceRef(endpoint.ref) }} label={`Actions for ${endpoint.label ?? endpoint.ref}`} />
      {mutation ? <ContextEdgeMenu mutationKind={mutation.kind} label={`Edit connection ${endpoint.label ?? endpoint.ref}`} retryable execute={async () => { await mutateConnection(connection.edge_id, mutation); onChanged(); }} presentFailure={connectionMutationErrorMessage} /> : null}
    </>}
    expanded={<>
      {mutation?.kind === "dismiss_discovery" ? <p className={styles.connectionMeta}>Dismissing hides this link and prevents rediscovery of this pair.</p> : null}
      {connection.creation ? <ConnectionCreation creation={connection.creation} /> : null}
      {connection.link_note ? <a className={styles.linkNote} href={`/notes/${connection.link_note.note_block_id}`} aria-label={`Open note on link ${endpoint.label ?? endpoint.ref}`}>
        <span className={styles.connectionMeta}>Note on link</span>
        <span>{connection.link_note.preview ?? "Open note"}</span>
      </a> : null}
    </>}
  />;
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
