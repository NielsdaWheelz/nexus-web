"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { Link, Paperclip, Sparkles, Trash2, X } from "lucide-react";
import {
  FeedbackNotice,
  toFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import ResourceTargetListbox, {
  resourceTargetKey,
  resourceTargetOptionId,
} from "@/components/resources/ResourceTargetListbox";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import MachineText from "@/components/ui/MachineText";
import Pill from "@/components/ui/Pill";
import Select from "@/components/ui/Select";
import { useResource } from "@/lib/api/useResource";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { createRandomId } from "@/lib/createRandomId";
import {
  getFileUploadError,
  isFailedSourceIngest,
  uploadIngestFile,
} from "@/lib/media/ingestionClient";
import {
  queryConnections,
  type ConnectionOut,
  type EdgeKind,
  type EdgeOrigin,
} from "@/lib/resourceGraph/connections";
import { createLink, deleteLink, type LinkTarget } from "@/lib/resourceGraph/links";
import { deleteStance, putStance } from "@/lib/resourceGraph/stances";
import {
  formatResourceRef,
  type ResourceRef,
} from "@/lib/resourceGraph/resourceRef";
import {
  activateResource,
  hrefForResourceActivation,
  type ResourceActivation,
} from "@/lib/resources/activation";
import { SYNAPSE_SOURCE_SCHEMES } from "@/lib/resources/resourceCapabilities.generated";
import { resourceIconForUri } from "@/lib/resources/resourceKind";
import { useResourceTargetSearch } from "@/lib/resources/useResourceTargetSearch";
import type { ResourceTarget } from "@/lib/resources/resourceTargets";
import {
  dismissSynapseEdge,
  fetchSynapseScanStatus,
  requestSynapseScan,
} from "@/lib/synapse";
import { useIntervalPoll } from "@/lib/useIntervalPoll";
import styles from "./ConnectionsSurface.module.css";

/** The endpoint of a connection that is NOT the object being viewed. */
interface Connection {
  edgeId: string;
  ref: string;
  label: string;
  activation: ResourceActivation;
  href: string | null;
  missing: boolean;
  kind: EdgeKind;
  origin: ConnectionOut["origin"];
  rationale: string | null;
  createdAt: string;
}

/**
 * Human assertions read as the record; synapse proposals trail them. Newest
 * first within each group (ISO timestamps compare lexicographically).
 */
function compareConnections(a: Connection, b: Connection): number {
  const aProposed = a.origin === "synapse" ? 1 : 0;
  const bProposed = b.origin === "synapse" ? 1 : 0;
  if (aProposed !== bProposed) return aProposed - bProposed;
  return b.createdAt.localeCompare(a.createdAt);
}

const CONNECTION_PANEL_ORIGINS: EdgeOrigin[] = [
  "user",
  "note_body",
  "highlight_note",
  "citation",
  "synapse",
  "document_embed",
];
const CONNECTION_PANEL_KINDS: EdgeKind[] = [
  "context",
  "supports",
  "contradicts",
];

export default function ConnectionsSurface({
  resourceRef,
  onOpenRoute,
}: {
  resourceRef: ResourceRef;
  onOpenRoute?: (href: string, openInNewPane: boolean) => void;
}) {
  const composerId = useId();
  const [composerOpen, setComposerOpen] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  const selfRef = formatResourceRef(resourceRef);
  const connectionsResource = useResource<{ data: ConnectionOut[] }>({
    cacheKey: `${selfRef}:${refreshTick}`,
    load: async (signal) => ({
      data: (
        await queryConnections(
          {
            refs: [selfRef],
            direction: "both",
            rollup: "owner",
            filters: {
              origins: CONNECTION_PANEL_ORIGINS,
              kinds: CONNECTION_PANEL_KINDS,
            },
            limit: 100,
          },
          { signal },
        )
      ).items,
    }),
  });
  const loading = connectionsResource.status === "loading";
  const error: FeedbackContent | null =
    connectionsResource.status === "error"
      ? toFeedback(connectionsResource.error, {
          fallback: "Connections could not be loaded.",
        })
      : null;

  const connections: Connection[] =
    connectionsResource.status === "ready"
      ? connectionsResource.data.data
          .map((connection) => {
            const href = hrefForResourceActivation(connection.other.activation);
            return {
              edgeId: connection.edge_id,
              ref: connection.other.ref,
              label: connection.other.label ?? connection.other.ref,
              activation: connection.other.activation,
              href,
              missing: connection.other.missing || href === null,
              kind: connection.kind,
              origin: connection.origin,
              rationale:
                connection.snapshot?.excerpt &&
                typeof connection.snapshot.excerpt === "string"
                  ? connection.snapshot.excerpt
                  : null,
              createdAt: connection.created_at,
            };
          })
          .sort(compareConnections)
      : [];

  const reloadConnections = useCallback(() => {
    setRefreshTick((value) => value + 1);
  }, []);

  const scannable = (SYNAPSE_SOURCE_SCHEMES as readonly string[]).includes(
    resourceRef.scheme,
  );
  const [scanVoice, setScanVoice] = useState<string | null>(null);
  const scanBaselineRef = useRef<number | null>(null);
  const connectionsCountRef = useRef(0);
  if (connectionsResource.status === "ready") {
    connectionsCountRef.current = connections.length;
  }

  useEffect(() => {
    scanBaselineRef.current = null;
    setScanVoice(null);
  }, [selfRef]);

  const handleScanSettled = useCallback(() => {
    // Snapshot the pre-reload count; the post-reload ready state reports the
    // delta as the scan-voice line.
    scanBaselineRef.current = connectionsCountRef.current;
    reloadConnections();
  }, [reloadConnections]);

  const scan = useSynapseScan({
    selfRef,
    enabled: scannable,
    onSettled: handleScanSettled,
  });
  const scanning = scan.phase !== "idle";

  useEffect(() => {
    if (
      connectionsResource.status !== "ready" ||
      scanBaselineRef.current === null
    ) {
      return;
    }
    const found =
      connectionsResource.data.data.length - scanBaselineRef.current;
    scanBaselineRef.current = null;
    setScanVoice(
      found > 0
        ? `${found} new connection${found === 1 ? "" : "s"} found.`
        : "No new connections found.",
    );
  }, [connectionsResource]);

  const openConnection = useCallback(
    (connection: Connection, openInNewPane: boolean) => {
      activateResource(connection.activation, {
        labelHint: connection.label,
        openInNewPane: (href) => onOpenRoute?.(href, true),
        navigate: (href) => onOpenRoute?.(href, false),
        newPane: openInNewPane,
      });
    },
    [onOpenRoute],
  );

  return (
    <section className={styles.backlinks} aria-label="Connections">
      <div className={styles.header}>
        <h2 className={styles.title}>Connections</h2>
        <div className={styles.headerActions}>
          <button
            type="button"
            className={styles.composerToggle}
            aria-expanded={composerOpen}
            aria-controls={composerId}
            onClick={() => setComposerOpen((open) => !open)}
          >
            ＋ Link
          </button>
          {scannable ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              iconOnly
              loading={scanning}
              aria-label="Find connections"
              title="Find connections"
              onClick={() => {
                setScanVoice(null);
                void scan.start();
              }}
            >
              <Sparkles size={14} aria-hidden="true" />
            </Button>
          ) : null}
        </div>
      </div>
      {scan.feedback ? <FeedbackNotice feedback={scan.feedback} /> : null}
      {scanning ? (
        <p className={styles.scanVoice}>Scanning…</p>
      ) : scanVoice ? (
        <p className={styles.scanVoice}>{scanVoice}</p>
      ) : null}
      {composerOpen ? (
        <ConnectionComposer
          id={composerId}
          selfRef={selfRef}
          onChanged={reloadConnections}
          autoFocus
        />
      ) : null}
      {loading ? (
        <FeedbackNotice severity="info" title="Loading connections..." />
      ) : null}
      {!loading && error ? <FeedbackNotice feedback={error} /> : null}
      {!loading && !error && connections.length === 0 ? (
        <p className={styles.empty}>
          {scannable
            ? "No connections yet. Scan to find resonant material, or link one manually."
            : "No connected objects yet."}
        </p>
      ) : null}
      {connections.length > 0 ? (
        <div className={styles.list}>
          {connections.map((connection) => {
            const Icon = resourceIconForUri(connection.ref);
            return (
              <div
                key={connection.edgeId}
                className={`${styles.linkRow}${connection.missing ? ` ${styles.missing}` : ""}`}
              >
                <button
                  type="button"
                  className={styles.linkButton}
                  disabled={connection.missing}
                  onClick={(event) =>
                    openConnection(connection, event.shiftKey)
                  }
                >
                  <Icon size={14} aria-hidden="true" />
                  <span className={styles.connectionText}>
                    <span>{connection.label}</span>
                    <span className={styles.connectionMeta}>
                      {connection.origin === "synapse" ? (
                        <Pill
                          tone="accent"
                          className={styles.synapseMarker}
                          role="img"
                          aria-label="Synapse connection"
                        >
                          ✦
                        </Pill>
                      ) : null}
                      {connection.kind}
                    </span>
                    {connection.origin === "synapse" && connection.rationale ? (
                      <MachineText
                        variant="inline"
                        as="span"
                        origin={{ label: "Synapse" }}
                        className={styles.rationale}
                      >
                        {connection.rationale}
                      </MachineText>
                    ) : null}
                  </span>
                </button>
                {connection.origin === "user" ? (
                  <DeleteConnectionButton
                    edgeId={connection.edgeId}
                    kind={connection.kind}
                    label={connection.label}
                    onChanged={reloadConnections}
                  />
                ) : connection.origin === "synapse" ? (
                  <DismissConnectionButton
                    edgeId={connection.edgeId}
                    label={connection.label}
                    onChanged={reloadConnections}
                  />
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}

function toLinkTarget(target: ResourceTarget): LinkTarget {
  return target.kind === "resource"
    ? { kind: "resource", ref: target.item.ref }
    : { kind: "passage", candidate_ref: target.candidateRef };
}

function targetLabel(target: ResourceTarget): string {
  return target.kind === "resource" ? target.item.label : target.label;
}

function targetRefOf(target: ResourceTarget): string {
  return target.kind === "resource" ? target.item.ref : target.candidateRef;
}

/** One attach-then-Link attempt for a single uploaded file. Ingested media is
 * never rolled back — only the Link half is retryable, per the file's own row. */
interface AttachmentRow {
  id: string;
  fileName: string;
  mediaId: string | null;
  error: FeedbackContent | null;
  linking: boolean;
}

function ConnectionComposer({
  id,
  selfRef,
  onChanged,
  autoFocus = false,
}: {
  id: string;
  selfRef: string;
  onChanged: () => void;
  autoFocus?: boolean;
}) {
  const listboxId = useId();
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<EdgeKind>("context");
  const [selected, setSelected] = useState<ResourceTarget | null>(null);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<FeedbackContent | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const [attachments, setAttachments] = useState<AttachmentRow[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  // Once a target is picked the field shows its label but the picker closes —
  // an empty search key disables `useResourceTargetSearch` entirely.
  const { targets: fetchedTargets, loading, error: searchError } =
    useResourceTargetSearch({
      purpose: "link",
      query: selected ? "" : query,
      sourceRef: selfRef,
    });

  // A stance (supports/contradicts) requires a *direct* resource target: its
  // `PutStanceRequest.target_ref` has no passage-materialization union the way a
  // Link's target does. The shared `purpose="link"` search may emit passage
  // candidates regardless of `kind`, so filter them out of the listbox for a
  // stance kind — the impossible combination is never selectable up front.
  const targets =
    kind === "context"
      ? fetchedTargets
      : fetchedTargets.filter((target) => target.kind === "resource");

  // Derived during render (never via an effect) so an in-flight Arrow move
  // can't be clobbered by a stale "initialize" effect: an explicit `activeKey`
  // wins while it still names a live target, otherwise the first target is
  // active by default.
  const effectiveActiveKey =
    activeKey && targets.some((target) => resourceTargetKey(target) === activeKey)
      ? activeKey
      : (targets[0] ? resourceTargetKey(targets[0]) : null);

  // The composer only mounts when the "＋ Link" disclosure opens it, so focus
  // the first field on mount to keep the keyboard on the reveal (AC-7).
  useEffect(() => {
    if (autoFocus) searchInputRef.current?.focus();
  }, [autoFocus]);

  const targetRef = selected ? targetRefOf(selected) : null;

  function pickTarget(target: ResourceTarget | undefined) {
    if (!target) return;
    setSelected(target);
    setQuery(targetLabel(target));
    setActiveKey(null);
    setFeedback(null);
  }

  function onSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (selected || targets.length === 0) return;
    if (
      event.key === "ArrowDown" ||
      event.key === "ArrowUp" ||
      event.key === "Home" ||
      event.key === "End"
    ) {
      event.preventDefault();
      const current = targets.findIndex(
        (target) => resourceTargetKey(target) === effectiveActiveKey,
      );
      const start = current >= 0 ? current : 0;
      const last = targets.length - 1;
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? last
            : event.key === "ArrowDown"
              ? Math.min(last, start + 1)
              : Math.max(0, start - 1);
      setActiveKey(resourceTargetKey(targets[next]!));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      pickTarget(
        targets.find((target) => resourceTargetKey(target) === effectiveActiveKey) ??
          targets[0],
      );
    }
  }

  async function submitConnection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFeedback(null);
    if (targetRef === null || selected === null) {
      setFeedback({
        severity: "warning",
        title: "Choose a result from the search.",
      });
      return;
    }
    if (targetRef === selfRef) {
      setFeedback({
        severity: "warning",
        title: "A resource cannot connect to itself.",
      });
      return;
    }
    if (kind !== "context" && selected.kind === "passage") {
      setFeedback({
        severity: "warning",
        title: "A stance needs a resource target, not a passage.",
      });
      return;
    }
    setSubmitting(true);
    try {
      if (kind === "context") {
        await createLink({
          source: { kind: "resource", ref: selfRef },
          target: toLinkTarget(selected),
        });
      } else {
        await putStance({ sourceRef: selfRef, targetRef, kind });
      }
      setQuery("");
      setSelected(null);
      onChanged();
    } catch (err) {
      if (handleUnauthenticatedApiError(err)) return;
      setFeedback(
        toFeedback(err, {
          fallback:
            kind === "context"
              ? "Link could not be created."
              : "Stance could not be recorded.",
        }),
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function linkAttachment(rowId: string, fileName: string, mediaId: string) {
    setAttachments((prev) => [
      ...prev.filter((row) => row.id !== rowId),
      { id: rowId, fileName, mediaId, error: null, linking: true },
    ]);
    try {
      await createLink({
        source: { kind: "resource", ref: selfRef },
        target: { kind: "resource", ref: `media:${mediaId}` },
      });
      setAttachments((prev) => prev.filter((row) => row.id !== rowId));
      onChanged();
    } catch (err) {
      if (handleUnauthenticatedApiError(err)) return;
      setAttachments((prev) =>
        prev.map((row) =>
          row.id === rowId
            ? {
                ...row,
                linking: false,
                error: toFeedback(err, {
                  fallback: "Attachment could not be linked.",
                }),
              }
            : row,
        ),
      );
    }
  }

  async function attachFiles(files: File[]) {
    if (files.length === 0) {
      return;
    }
    setFeedback(null);
    setAttaching(true);
    try {
      for (const file of files) {
        const rowId = createRandomId("attach");
        const uploadError = getFileUploadError(file);
        if (uploadError) {
          setAttachments((prev) => [
            ...prev,
            {
              id: rowId,
              fileName: file.name,
              mediaId: null,
              error: toFeedback(new Error(uploadError), {
                fallback: uploadError,
              }),
              linking: false,
            },
          ]);
          continue;
        }
        let mediaId: string;
        try {
          const result = await uploadIngestFile({ file, libraryIds: [] });
          if (isFailedSourceIngest(result)) {
            throw new Error("Attachment could not be uploaded.");
          }
          mediaId = result.mediaId;
        } catch (err) {
          if (handleUnauthenticatedApiError(err)) return;
          setAttachments((prev) => [
            ...prev,
            {
              id: rowId,
              fileName: file.name,
              mediaId: null,
              error: toFeedback(err, {
                fallback: "Attachment could not be uploaded.",
              }),
              linking: false,
            },
          ]);
          continue;
        }
        await linkAttachment(rowId, file.name, mediaId);
      }
    } finally {
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
      setAttaching(false);
    }
  }

  return (
    <form
      id={id}
      className={styles.composer}
      onSubmit={(event) => void submitConnection(event)}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) event.preventDefault();
      }}
      onDrop={(event) => {
        const files = Array.from(event.dataTransfer.files);
        if (files.length === 0) return;
        event.preventDefault();
        void attachFiles(files);
      }}
    >
      <div className={styles.composerControls}>
        <div className={styles.searchWrap}>
          <Input
            ref={searchInputRef}
            size="sm"
            value={query}
            role="combobox"
            aria-expanded={!selected && targets.length > 0}
            aria-controls={listboxId}
            aria-autocomplete="list"
            aria-activedescendant={
              !selected && effectiveActiveKey
                ? resourceTargetOptionId(
                    listboxId,
                    targets.find(
                      (target) => resourceTargetKey(target) === effectiveActiveKey,
                    )!,
                  )
                : undefined
            }
            placeholder="Search to link…"
            aria-label="Connection target"
            onChange={(event) => {
              setSelected(null);
              setFeedback(null);
              setQuery(event.currentTarget.value);
            }}
            onKeyDown={onSearchKeyDown}
          />
          {!selected && query.trim().length > 0 ? (
            <div className={styles.autocomplete}>
              <ResourceTargetListbox
                id={listboxId}
                ariaLabel="Link targets"
                targets={targets}
                activeKey={effectiveActiveKey}
                loading={loading}
                error={searchError}
                onHover={(target) => setActiveKey(resourceTargetKey(target))}
                onPick={pickTarget}
              />
            </div>
          ) : null}
        </div>
        <Select
          size="sm"
          value={kind}
          aria-label="Connection kind"
          onChange={(event) => {
            const nextKind = event.currentTarget.value as EdgeKind;
            setKind(nextKind);
            // A passage can only anchor a "context" Link; switching to a stance
            // drops an incompatible passage pick so it can't be submitted.
            if (nextKind !== "context" && selected?.kind === "passage") {
              setSelected(null);
              setFeedback(null);
            }
          }}
        >
          <option value="context">context</option>
          <option value="supports">supports</option>
          <option value="contradicts">contradicts</option>
        </Select>
        <Button
          type="submit"
          size="sm"
          variant="secondary"
          loading={submitting}
          leadingIcon={<Link size={14} />}
        >
          {kind === "context" ? "Link" : "Record stance"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          leadingIcon={<Paperclip size={14} />}
          loading={attaching}
          onClick={() => fileInputRef.current?.click()}
        >
          Attach
        </Button>
        <input
          ref={fileInputRef}
          className={styles.fileInput}
          type="file"
          multiple
          accept="application/pdf,application/epub+zip,.pdf,.epub"
          aria-label="Attach files"
          tabIndex={-1}
          onChange={(event) =>
            void attachFiles(Array.from(event.currentTarget.files ?? []))
          }
        />
      </div>
      {feedback ? <FeedbackNotice feedback={feedback} /> : null}
      {attachments.length > 0 ? (
        <ul className={styles.attachments}>
          {attachments.map((row) => (
            <li key={row.id} className={styles.attachmentRow}>
              <span className={styles.attachmentName}>{row.fileName}</span>
              {row.error ? (
                <>
                  <FeedbackNotice feedback={row.error} />
                  {row.mediaId ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      loading={row.linking}
                      onClick={() =>
                        void linkAttachment(row.id, row.fileName, row.mediaId!)
                      }
                    >
                      Retry
                    </Button>
                  ) : null}
                </>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </form>
  );
}

function DeleteConnectionButton({
  edgeId,
  kind,
  label,
  onChanged,
}: {
  edgeId: string;
  kind: EdgeKind;
  label: string;
  onChanged: () => void;
}) {
  const [deleting, setDeleting] = useState(false);
  const [feedback, setFeedback] = useState<FeedbackContent | null>(null);

  async function deleteConnection() {
    setDeleting(true);
    setFeedback(null);
    try {
      if (kind === "context") {
        await deleteLink(edgeId);
      } else {
        await deleteStance(edgeId);
      }
      onChanged();
    } catch (err) {
      if (handleUnauthenticatedApiError(err)) return;
      setFeedback(
        toFeedback(err, { fallback: "Connection could not be deleted." }),
      );
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className={styles.deleteWrap}>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        iconOnly
        loading={deleting}
        aria-label={`Delete connection to ${label}`}
        onClick={() => void deleteConnection()}
      >
        <Trash2 size={14} aria-hidden="true" />
      </Button>
      {feedback ? <FeedbackNotice feedback={feedback} /> : null}
    </div>
  );
}

function DismissConnectionButton({
  edgeId,
  label,
  onChanged,
}: {
  edgeId: string;
  label: string;
  onChanged: () => void;
}) {
  const [dismissing, setDismissing] = useState(false);
  const [feedback, setFeedback] = useState<FeedbackContent | null>(null);

  async function dismissConnection() {
    setDismissing(true);
    setFeedback(null);
    try {
      await dismissSynapseEdge(edgeId);
      onChanged();
    } catch (err) {
      if (handleUnauthenticatedApiError(err)) return;
      setFeedback(
        toFeedback(err, { fallback: "Connection could not be dismissed." }),
      );
    } finally {
      setDismissing(false);
    }
  }

  return (
    <div className={styles.deleteWrap}>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        iconOnly
        loading={dismissing}
        aria-label={`Dismiss connection to ${label}`}
        title="Dismiss — won't be suggested again"
        onClick={() => void dismissConnection()}
      >
        <X size={14} aria-hidden="true" />
      </Button>
      {feedback ? <FeedbackNotice feedback={feedback} /> : null}
    </div>
  );
}

const SYNAPSE_SCAN_POLL_MS = 2000;
const SYNAPSE_SCAN_TIMEOUT_MS = 45_000;

/**
 * The manual-scan lifecycle for a scannable ref: request → bounded status poll
 * → settle. `onSettled` fires once per finished scan — idle status reached,
 * the request short-circuiting to idle, or the 45s deadline lapsing.
 */
function useSynapseScan({
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
  start: () => Promise<void>;
} {
  const [phase, setPhase] = useState<"idle" | "requesting" | "polling">("idle");
  const [feedback, setFeedback] = useState<FeedbackContent | null>(null);
  const deadlineRef = useRef(0);

  // A tab switch unmounts the section mid-scan; one status read on mount
  // resumes the poll (with a fresh deadline) when a scan is still in flight.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void fetchSynapseScanStatus(selfRef)
      .then((status) => {
        if (cancelled || status === "idle") return;
        deadlineRef.current = Date.now() + SYNAPSE_SCAN_TIMEOUT_MS;
        setPhase("polling");
      })
      .catch((err) => {
        // Best-effort resume probe; a manual scan surfaces real errors.
        if (!cancelled) handleUnauthenticatedApiError(err);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, selfRef]);

  // justify-polling: scans run on the background worker with no SSE plane
  // (synapse spec N5); the poll is user-initiated, 2s, and self-bounds at the
  // 45s scan deadline.
  useIntervalPoll({
    enabled: phase === "polling",
    pollIntervalMs: SYNAPSE_SCAN_POLL_MS,
    onPoll: async () => {
      try {
        const status = await fetchSynapseScanStatus(selfRef);
        if (status !== "idle" && Date.now() < deadlineRef.current) return;
        setPhase("idle");
        onSettled();
      } catch (err) {
        setPhase("idle");
        if (handleUnauthenticatedApiError(err)) return;
        setFeedback(
          toFeedback(err, { fallback: "Scan status could not be checked." }),
        );
      }
    },
  });

  const start = useCallback(async () => {
    setFeedback(null);
    setPhase("requesting");
    try {
      const scan = await requestSynapseScan(selfRef);
      if (scan.status === "idle") {
        // Engine disabled or the scan already finished: nothing to poll.
        setPhase("idle");
        onSettled();
        return;
      }
      deadlineRef.current = Date.now() + SYNAPSE_SCAN_TIMEOUT_MS;
      setPhase("polling");
    } catch (err) {
      setPhase("idle");
      if (handleUnauthenticatedApiError(err)) return;
      setFeedback(toFeedback(err, { fallback: "Scan could not be started." }));
    }
  }, [onSettled, selfRef]);

  return { phase, feedback, start };
}
