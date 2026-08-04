"use client";

import {
  Component,
  createRef,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type ReactNode,
  type KeyboardEvent,
} from "react";
import { Link, Paperclip, Sparkles } from "lucide-react";
import {
  FeedbackNotice,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import ContextEdgeMenu from "@/components/resources/ContextEdgeMenu";
import ResourceActionMenu from "@/components/resources/ResourceActionMenu";
import ResourceTargetListbox, {
  resourceTargetKey,
  resourceTargetOptionId,
} from "@/components/resources/ResourceTargetListbox";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import MachineText from "@/components/ui/MachineText";
import Pill from "@/components/ui/Pill";
import Select from "@/components/ui/Select";
import { isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { useResource } from "@/lib/api/useResource";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { createRandomId } from "@/lib/createRandomId";
import {
  getFileUploadError,
  isMediaIngestionDefect,
  projectUploadReference,
  uploadIngestFile,
} from "@/lib/media/ingestionClient";
import { mediaCaptureErrorMessage } from "@/lib/media/captureFeedback";
import {
  queryConnections,
  type ConnectionOut,
  type EdgeKind,
  type EdgeOrigin,
} from "@/lib/resourceGraph/connections";
import {
  createLink,
  deleteLink,
  type LinkTarget,
} from "@/lib/resourceGraph/links";
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
import { workspaceTargetClickIntent } from "@/lib/panes/targetLinkActivation";
import type { ResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import type {
  WorkspaceTarget,
  WorkspaceTargetDisposition,
} from "@/lib/workspace/targetActivation";
import { SYNAPSE_SOURCE_SCHEMES } from "@/lib/resources/resourceCapabilities";
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
import type {
  ConnectionsComposerController,
  ConnectionsComposerDraft,
  ConnectionsPendingAttachment,
} from "./connectionsComposerController";

/** The endpoint of a connection that is NOT the object being viewed. */
interface Connection {
  edgeId: string;
  ref: string;
  label: string;
  activation: ResourceActivation;
  missing: boolean;
  actionTarget: ResourceActionSubject;
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

export type ConnectionOperation =
  | "Load"
  | "Chat"
  | "Unlink"
  | "Dismiss"
  | "CreateLink"
  | "RecordStance"
  | "ConnectAttachment"
  | "ScanStatus"
  | "StartScan";

function connectionOperationTitle(operation: ConnectionOperation): string {
  switch (operation) {
    case "Load":
      return "Connections couldn’t be loaded";
    case "Chat":
      return "Chat wasn’t started";
    case "Unlink":
      return "Connection wasn’t unlinked";
    case "Dismiss":
      return "Connection wasn’t dismissed";
    case "CreateLink":
      return "Link wasn’t created";
    case "RecordStance":
      return "Stance wasn’t recorded";
    case "ConnectAttachment":
      return "File was saved, but its connection wasn’t created";
    case "ScanStatus":
      return "Scan status couldn’t be checked";
    case "StartScan":
      return "Scan wasn’t started";
  }
}

/** Finite Connections-domain copy adapter; unknown codes remain defects. */
export function connectionErrorMessage(
  error: unknown,
  operation: ConnectionOperation,
): FeedbackContent {
  if (!isApiError(error) || isSameSystemApiDefect(error)) throw error;

  const title = connectionOperationTitle(operation);
  const requestId = error.requestId;
  switch (error.code) {
    case "E_NETWORK":
      return {
        tone: "Danger",
        title,
        message: "Check your connection and retry.",
        requestId,
      };
    case "E_UPSTREAM":
    case "E_UPSTREAM_TIMEOUT":
      return {
        tone: "Danger",
        title,
        message: "Nexus couldn’t complete that request. Wait a moment, then retry.",
        requestId,
      };
    case "E_RATE_LIMITED":
      return {
        tone: "Danger",
        title,
        message: "Wait a moment, then retry.",
        requestId,
      };
    case "E_NOT_FOUND":
      return {
        tone: "Danger",
        title,
        message: "The connection or one of its objects is no longer available. Reload Connections.",
        requestId,
      };
    case "E_FORBIDDEN":
      return {
        tone: "Danger",
        title,
        message: "This account can’t make that change.",
        requestId,
      };
    case "E_BAD_REQUEST":
    case "E_INVALID_REQUEST":
      return {
        tone: "Danger",
        title,
        message: "That request is no longer valid. Review the connection and retry.",
        requestId,
      };
    case "E_LINK_SELF":
      if (operation !== "CreateLink" && operation !== "RecordStance") {
        throw error;
      }
      return {
        tone: "Danger",
        title,
        message: "An item can’t link to itself. Choose another target.",
        requestId,
      };
    case "E_LINK_CAPABILITY":
      if (
        operation !== "CreateLink" &&
        operation !== "RecordStance" &&
        operation !== "ConnectAttachment"
      ) {
        throw error;
      }
      return {
        tone: "Danger",
        title,
        message: "This source or target doesn’t support links. Choose another target.",
        requestId,
      };
    case "E_LINK_TARGET_AMBIGUOUS":
      if (operation !== "CreateLink") throw error;
      return {
        tone: "Danger",
        title,
        message: "That passage matches more than once. Choose a more specific target.",
        requestId,
      };
    case "E_LINK_TARGET_STALE":
      if (operation !== "CreateLink") throw error;
      return {
        tone: "Danger",
        title,
        message: "That passage changed. Search for it again, then retry.",
        requestId,
      };
    case "E_HIGHLIGHT_CONFLICT":
      if (operation !== "CreateLink") throw error;
      return {
        tone: "Danger",
        title,
        message: "The selected passage changed. Select it again, then retry.",
        requestId,
      };
    case "E_IDEMPOTENCY_KEY_REPLAY_MISMATCH":
      if (operation !== "CreateLink") throw error;
      return {
        tone: "Danger",
        title,
        message: "The link request changed. Close Link, then try again.",
        requestId,
      };
    case "E_CONFLICT":
      if (operation !== "Dismiss") throw error;
      return {
        tone: "Danger",
        title,
        message: "This proposal changed. Reload Connections, then retry.",
        requestId,
      };
    default:
      throw error;
  }
}

export default function ConnectionsSurface({
  resourceRef,
  composerController,
  activateTarget,
}: {
  resourceRef: ResourceRef;
  composerController: ConnectionsComposerController;
  activateTarget: (input: {
    target: WorkspaceTarget;
    disposition: WorkspaceTargetDisposition;
  }) => void;
}) {
  const composerId = useId();
  const composerDraft = useSyncExternalStore(
    composerController.subscribe,
    composerController.getSnapshot,
    composerController.getSnapshot,
  );
  const composerOpen = composerDraft.open;
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
  const loadFailure: unknown | null =
    connectionsResource.status === "error"
      ? connectionsResource.error
      : null;

  const connections: Connection[] =
    connectionsResource.status === "ready"
      ? connectionsResource.data.data
          .map((connection) => {
            const href = hrefForResourceActivation(connection.other.activation);
            const unavailable = connection.other.missing || href === null;
            return {
              edgeId: connection.edge_id,
              ref: connection.other.ref,
              label: connection.other.label ?? connection.other.ref,
              activation: connection.other.activation,
              missing: unavailable,
              actionTarget: connection.other.actionTarget,
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
    (connection: Connection, disposition: WorkspaceTargetDisposition) => {
      activateResource(connection.activation, {
        labelHint: connection.label,
        activateTarget,
        disposition,
      });
    },
    [activateTarget],
  );

  if (scan.defectState !== null) throw scan.defectState.error;
  const error =
    loadFailure === null
      ? null
      : connectionErrorMessage(loadFailure, "Load");

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
            onClick={() => composerController.update({ open: !composerOpen })}
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
      {scan.feedback ? (
        <FeedbackNotice
          content={scan.feedback}
          announcement="Assertive"
          actions={[{ label: "Retry", onClick: () => void scan.retry() }]}
        />
      ) : null}
      {scanning ? (
        <p className={styles.scanVoice}>Scanning…</p>
      ) : scanVoice ? (
        <p className={styles.scanVoice}>{scanVoice}</p>
      ) : null}
      <ConnectionComposer
        key={selfRef}
        id={composerId}
        selfRef={selfRef}
        onChanged={reloadConnections}
        active={composerOpen}
        draft={composerDraft}
        controller={composerController}
      />
      {loading ? (
        <FeedbackNotice
          content={{ tone: "Info", title: "Loading connections…" }}
          announcement="Polite"
        />
      ) : null}
      {!loading && error ? (
        <FeedbackNotice
          content={error}
          announcement="Assertive"
          actions={[{ label: "Retry", onClick: reloadConnections }]}
        />
      ) : null}
      {!loading && !error && connections.length === 0 ? (
        <p className={styles.empty}>
          {scannable
            ? "No connections yet. Scan to find resonant material, or link one manually."
            : "No connected objects yet."}
        </p>
      ) : null}
      {connections.length > 0 ? (
        <div className={styles.list}>
          {connections.map((connection) => (
            <ConnectionRow
              key={connection.edgeId}
              connection={connection}
              onOpen={(disposition) =>
                openConnection(connection, disposition)
              }
              onChanged={reloadConnections}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function ConnectionRow({
  connection,
  onOpen,
  onChanged,
}: {
  connection: Connection;
  onOpen: (disposition: WorkspaceTargetDisposition) => void;
  onChanged: () => void;
}) {
  const Icon = resourceIconForUri(connection.ref);

  // The one edge command this connection exposes: a user-authored edge unlinks
  // (deleteLink for a context Link, deleteStance for a stance), a synapse
  // proposal dismisses. Both are edge mutations owned by the separate
  // context-edge control (AC4), never the canonical resource dropdown.
  const edge:
    | {
        readonly action: "Unlink" | "Dismiss";
        readonly operation: "Unlink" | "Dismiss";
        readonly execute: () => Promise<void>;
      }
    | null =
    connection.origin === "user"
      ? {
          action: "Unlink",
          operation: "Unlink",
          execute: async () => {
            if (connection.kind === "context") {
              await deleteLink(connection.edgeId);
            } else {
              await deleteStance(connection.edgeId);
            }
            onChanged();
          },
        }
      : connection.origin === "synapse"
        ? {
            action: "Dismiss",
            operation: "Dismiss",
            execute: async () => {
              await dismissSynapseEdge(connection.edgeId);
              onChanged();
            },
          }
        : null;

  return (
    <div
      className={`${styles.linkRow}${connection.missing ? ` ${styles.missing}` : ""}`}
    >
      <button
        type="button"
        className={styles.linkButton}
        disabled={connection.missing}
        onClick={(event) =>
          onOpen(workspaceTargetClickIntent(event).disposition)
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
      {/* Canonical resource dropdown — Open/Share/Chat/… via the runtime. */}
      <ResourceActionMenu
        target={connection.actionTarget}
        label={`Actions for ${connection.label}`}
      />
      {/* Separate context-edge control (AC4): unlink/dismiss are edge mutations,
          not resource actions, so they publish on their own labelled trigger. */}
      {edge ? (
        <ContextEdgeMenu
          action={edge.action}
          label={`Edit connection ${connection.label}`}
          retryable
          execute={edge.execute}
          presentFailure={(error) =>
            connectionErrorMessage(error, edge.operation)
          }
        />
      ) : null}
    </div>
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

function ConnectionComposer({
  id,
  selfRef,
  onChanged,
  active,
  draft,
  controller,
}: {
  id: string;
  selfRef: string;
  onChanged: () => void;
  active: boolean;
  draft: ConnectionsComposerDraft;
  controller: ConnectionsComposerController;
}) {
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const listboxId = useId();
  const {
    query,
    kind,
    selected,
    activeKey,
    feedback,
    submitting,
    attaching,
    pendingAttachments,
  } = draft;
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const createIntentRef = useRef<{
    key: string;
    clientMutationId: string;
  } | null>(null);

  function presentConnectionFailure(
    error: unknown,
    operation: "CreateLink" | "RecordStance" | "ConnectAttachment",
  ) {
    try {
      controller.update({ feedback: connectionErrorMessage(error, operation) });
    } catch (caughtDefect) {
      setDefect({ error: caughtDefect });
    }
  }

  function presentCaptureFailure(error: unknown) {
    try {
      controller.update({
        feedback: mediaCaptureErrorMessage(error, "AddAttachment"),
      });
    } catch (caughtDefect) {
      setDefect({ error: caughtDefect });
    }
  }

  // Once a target is picked the field shows its label but the picker closes —
  // an empty search key disables `useResourceTargetSearch` entirely.
  const {
    targets: fetchedTargets,
    loading,
    error: searchError,
  } = useResourceTargetSearch({
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
    activeKey &&
    targets.some((target) => resourceTargetKey(target) === activeKey)
      ? activeKey
      : targets[0]
        ? resourceTargetKey(targets[0])
        : null;

  // The composer only mounts when the "＋ Link" disclosure opens it, so focus
  // the first field on mount to keep the keyboard on the reveal (AC-7).
  useEffect(() => {
    if (active) searchInputRef.current?.focus();
  }, [active]);

  const targetRef = selected ? targetRefOf(selected) : null;

  function pickTarget(target: ResourceTarget | undefined) {
    if (!target) return;
    controller.update({
      selected: target,
      query: targetLabel(target),
      activeKey: null,
    });
    controller.update({ feedback: null });
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
      controller.update({ activeKey: resourceTargetKey(targets[next]!) });
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      pickTarget(
        targets.find(
          (target) => resourceTargetKey(target) === effectiveActiveKey,
        ) ?? targets[0],
      );
    }
  }

  async function submitConnection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    controller.update({ feedback: null });
    if (targetRef === null || selected === null) {
      controller.update({
        feedback: {
          tone: "Warning",
          title: "Choose a result from the search.",
        },
      });
      return;
    }
    if (targetRef === selfRef) {
      controller.update({
        feedback: {
          tone: "Warning",
          title: "A resource cannot connect to itself.",
        },
      });
      return;
    }
    if (kind !== "context" && selected.kind === "passage") {
      controller.update({
        feedback: {
          tone: "Warning",
          title: "A stance needs a resource target, not a passage.",
        },
      });
      return;
    }
    controller.update({ submitting: true });
    try {
      if (kind === "context") {
        const intentKey = JSON.stringify({ selfRef, target: toLinkTarget(selected) });
        if (createIntentRef.current?.key !== intentKey) {
          createIntentRef.current = {
            key: intentKey,
            clientMutationId: createRandomId("link"),
          };
        }
        await createLink({
          clientMutationId: createIntentRef.current.clientMutationId,
          source: { kind: "resource", ref: selfRef },
          target: toLinkTarget(selected),
        });
      } else {
        await putStance({ sourceRef: selfRef, targetRef, kind });
      }
      controller.update({ query: "", selected: null, activeKey: null });
      createIntentRef.current = null;
      onChanged();
    } catch (err) {
      if (handleUnauthenticatedApiError(err)) return;
      presentConnectionFailure(
        err,
        kind === "context" ? "CreateLink" : "RecordStance",
      );
    } finally {
      controller.update({ submitting: false });
    }
  }

  async function attachFiles(files: File[]) {
    if (files.length === 0) {
      return;
    }
    controller.update({ feedback: null, attaching: true });
    let changed = false;
    try {
      for (const file of files) {
        const uploadError = getFileUploadError(file);
        if (uploadError) {
          controller.update({
            feedback: { tone: "Danger", title: uploadError },
          });
          continue;
        }
        const accepted: {
          pending: ConnectionsPendingAttachment | null;
          edge: Promise<AttachmentEdgeOutcome> | null;
        } = { pending: null, edge: null };
        let upload;
        try {
          upload = await uploadIngestFile({
            file,
            libraryIds: [],
            onAcceptedIdentity: ({ mediaId, sourceAttemptId }) => {
              const pending: ConnectionsPendingAttachment = {
                clientMutationId: createRandomId("link"),
                mediaId,
                sourceAttemptId,
                label: file.name,
                warning: null,
              };
              accepted.pending = pending;
              controller.update((current) => ({
                pendingAttachments: upsertPending(
                  current.pendingAttachments,
                  pending,
                ),
              }));
              accepted.edge = createAttachmentLink(selfRef, pending).then(
                () => ({ kind: "Fulfilled" as const }),
                (error: unknown) => ({ kind: "Rejected" as const, error }),
              );
            },
          });
        } catch (error) {
          if (accepted.edge && accepted.pending) {
            const edge = await accepted.edge;
            if (edge.kind === "Fulfilled") {
              controller.update((current) => ({
                pendingAttachments: current.pendingAttachments.filter(
                  (item) => item.mediaId !== accepted.pending?.mediaId,
                ),
              }));
              changed = true;
            }
          }
          if (isMediaIngestionDefect(error)) {
            setDefect({ error });
            return;
          }
          if (handleUnauthenticatedApiError(error)) return;
          presentCaptureFailure(error);
          continue;
        }
        if (!accepted.pending || !accepted.edge) {
          setDefect({
            error: new Error(
              "Accepted attachment did not publish its durable identity.",
            ),
          });
          return;
        }
        const { warning } = projectUploadReference({
          result: upload,
          processingFailureFeedback: {
            tone: "Warning",
            title: "Attachment was added, but source processing failed.",
          },
        });
        const pending = { ...accepted.pending, warning };
        controller.update((current) => ({
          pendingAttachments: upsertPending(
            current.pendingAttachments,
            pending,
          ),
        }));
        const edge = await accepted.edge;
        if (edge.kind === "Rejected") {
          if (isSameSystemApiDefect(edge.error)) {
            setDefect({ error: edge.error });
            return;
          }
          if (handleUnauthenticatedApiError(edge.error)) return;
          presentConnectionFailure(edge.error, "ConnectAttachment");
          continue;
        }
        controller.update((current) => ({
          pendingAttachments: current.pendingAttachments.filter(
            (item) => item.mediaId !== pending.mediaId,
          ),
        }));
        changed = true;
        if (warning) controller.update({ feedback: warning });
      }
    } finally {
      if (changed) onChanged();
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
      controller.update({ attaching: false });
    }
  }

  async function retryAttachment(pending: ConnectionsPendingAttachment) {
    controller.update({ feedback: null, attaching: true });
    try {
      await createAttachmentLink(selfRef, pending);
      controller.update((current) => ({
        pendingAttachments: current.pendingAttachments.filter(
          (item) => item.mediaId !== pending.mediaId,
        ),
        ...(pending.warning ? { feedback: pending.warning } : {}),
      }));
      onChanged();
    } catch (error) {
      if (isSameSystemApiDefect(error)) {
        setDefect({ error });
        return;
      }
      if (handleUnauthenticatedApiError(error)) return;
      presentConnectionFailure(error, "ConnectAttachment");
    } finally {
      controller.update({ attaching: false });
    }
  }

  return (
    <ConnectionComposerDefectBoundary
      active={active}
      activeDefect={defect !== null}
      onContinue={() => setDefect(null)}
    >
      <ConnectionComposerProjection defect={defect}>
        <form
          id={id}
          hidden={!active}
          className={styles.composer}
          onSubmit={(event) => void submitConnection(event)}
          onDragOver={(event) => {
            if (event.dataTransfer.types.includes("Files"))
              event.preventDefault();
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
                          (target) =>
                            resourceTargetKey(target) === effectiveActiveKey,
                        )!,
                      )
                    : undefined
                }
                placeholder="Search to link…"
                aria-label="Connection target"
                onChange={(event) => {
                  controller.update({
                    selected: null,
                    query: event.currentTarget.value,
                  });
                  controller.update({ feedback: null });
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
                    onHover={(target) =>
                      controller.update({
                        activeKey: resourceTargetKey(target),
                      })
                    }
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
                controller.update({ kind: nextKind });
                // Passage anchors are Links; Stances require a resource.
                if (nextKind !== "context" && selected?.kind === "passage") {
                  controller.update({ selected: null });
                  controller.update({ feedback: null });
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
          {pendingAttachments.length > 0 ? (
            <ul
              className={styles.pendingAttachments}
              aria-label="Pending attachments"
            >
              {pendingAttachments.map((pending) => (
                <li key={pending.mediaId} className={styles.pendingAttachment}>
                  <span>
                    {pending.label} was saved and still needs its connection.
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={attaching}
                    onClick={() => void retryAttachment(pending)}
                  >
                    Retry attachment
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
          {feedback ? (
            <FeedbackNotice content={feedback} announcement="Assertive" />
          ) : null}
        </form>
      </ConnectionComposerProjection>
    </ConnectionComposerDefectBoundary>
  );
}

function ConnectionComposerProjection({
  defect,
  children,
}: {
  defect: { error: unknown } | null;
  children: ReactNode;
}) {
  if (defect) throw defect.error;
  return children;
}

interface ConnectionComposerDefectBoundaryProps {
  active: boolean;
  activeDefect: boolean;
  onContinue(): void;
  children: ReactNode;
}

class ConnectionComposerDefectBoundary extends Component<
  ConnectionComposerDefectBoundaryProps,
  { hasError: boolean }
> {
  state = { hasError: false };
  private readonly actionRef = createRef<HTMLButtonElement>();

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: unknown) {
    console.error("Connection composer contract defect:", error);
    if (this.props.active) this.actionRef.current?.focus();
  }

  componentDidUpdate(
    previous: Readonly<ConnectionComposerDefectBoundaryProps>,
  ) {
    if (
      this.state.hasError &&
      previous.activeDefect &&
      !this.props.activeDefect
    ) {
      this.setState({ hasError: false });
      return;
    }
    if (this.state.hasError && !previous.active && this.props.active) {
      this.actionRef.current?.focus();
    }
  }

  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <div hidden={!this.props.active} className={styles.composer}>
        <FeedbackNotice
          content={{
            tone: "Danger",
            title: "Connections need attention",
            message:
              "Nexus preserved any accepted file identity. Continue to review its connection.",
          }}
          announcement="Assertive"
        />
        <Button
          ref={this.actionRef}
          type="button"
          size="sm"
          variant="secondary"
          onClick={this.props.onContinue}
        >
          Continue connections
        </Button>
      </div>
    );
  }
}

type AttachmentEdgeOutcome =
  { kind: "Fulfilled" } | { kind: "Rejected"; error: unknown };

function upsertPending(
  current: readonly ConnectionsPendingAttachment[],
  pending: ConnectionsPendingAttachment,
): ConnectionsPendingAttachment[] {
  return [
    ...current.filter((item) => item.mediaId !== pending.mediaId),
    pending,
  ];
}

function createAttachmentLink(
  sourceRef: string,
  pending: ConnectionsPendingAttachment,
): Promise<unknown> {
  return createLink({
    clientMutationId: pending.clientMutationId,
    source: { kind: "resource", ref: sourceRef },
    target: { kind: "resource", ref: `media:${pending.mediaId}` },
  });
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
    void fetchSynapseScanStatus(selfRef)
      .then((status) => {
        if (cancelled || status === "idle") return;
        deadlineRef.current = Date.now() + SYNAPSE_SCAN_TIMEOUT_MS;
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
        try {
          setFeedback(connectionErrorMessage(err, "ScanStatus"));
          setFailureOperation("ScanStatus");
        } catch (caughtDefect) {
          setDefectState({ error: caughtDefect });
        }
      }
    },
  });

  const start = useCallback(async () => {
    setFeedback(null);
    setFailureOperation(null);
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
      try {
        setFeedback(connectionErrorMessage(err, "StartScan"));
        setFailureOperation("StartScan");
      } catch (caughtDefect) {
        setDefectState({ error: caughtDefect });
      }
    }
  }, [onSettled, selfRef]);

  const retryStatus = useCallback(async () => {
    setFeedback(null);
    setFailureOperation(null);
    setPhase("requesting");
    try {
      const status = await fetchSynapseScanStatus(selfRef);
      if (status === "idle") {
        setPhase("idle");
        onSettled();
        return;
      }
      deadlineRef.current = Date.now() + SYNAPSE_SCAN_TIMEOUT_MS;
      setPhase("polling");
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
  }, [onSettled, selfRef]);

  return {
    phase,
    feedback,
    defectState,
    start,
    retry: failureOperation === "ScanStatus" ? retryStatus : start,
  };
}
