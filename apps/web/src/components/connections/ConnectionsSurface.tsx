"use client";

import {
  Component,
  createRef,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { Link, Paperclip, Sparkles, Trash2, X } from "lucide-react";
import {
  FeedbackNotice,
  toFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import ObjectRefAutocomplete from "@/components/notes/ObjectRefAutocomplete";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import MachineText from "@/components/ui/MachineText";
import Pill from "@/components/ui/Pill";
import Select from "@/components/ui/Select";
import { isSameSystemApiDefect } from "@/lib/api/client";
import { useResource } from "@/lib/api/useResource";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { isAbortError } from "@/lib/errors";
import {
  getFileUploadError,
  isMediaIngestionDefect,
  projectUploadReference,
  uploadIngestFile,
} from "@/lib/media/ingestionClient";
import {
  createUserEdge,
  deleteUserEdge,
  type EdgeKind,
  type EdgeOrigin,
} from "@/lib/resourceGraph/edges";
import {
  queryConnections,
  type ConnectionOut,
} from "@/lib/resourceGraph/connections";
import {
  formatResourceRef,
  parseResourceRef,
} from "@/lib/resourceGraph/resourceRef";
import {
  activateResource,
  hrefForResourceActivation,
  type ResourceActivation,
} from "@/lib/resources/activation";
import { SYNAPSE_SOURCE_SCHEMES } from "@/lib/resources/resourceCapabilities.generated";
import { resourceIconForUri } from "@/lib/resources/resourceKind";
import {
  dismissSynapseEdge,
  fetchSynapseScanStatus,
  requestSynapseScan,
} from "@/lib/synapse";
import { useIntervalPoll } from "@/lib/useIntervalPoll";
import {
  searchObjectRefs,
  type HydratedObjectRef,
  type ObjectRef,
} from "@/lib/objectRefs";
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
  objectRef,
  onOpenRoute,
}: {
  objectRef: ObjectRef;
  onOpenRoute?: (href: string, openInNewPane: boolean) => void;
}) {
  const composerId = useId();
  const [composerOpen, setComposerOpen] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  const selfRef = formatResourceRef({
    scheme: objectRef.objectType,
    id: objectRef.objectId,
  });
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
    objectRef.objectType,
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
            ＋ Connect
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
      <ConnectionComposer
        key={selfRef}
        id={composerId}
        selfRef={selfRef}
        onChanged={reloadConnections}
        active={composerOpen}
      />
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

function ConnectionComposer({
  id,
  selfRef,
  onChanged,
  active,
}: {
  id: string;
  selfRef: string;
  onChanged: () => void;
  active: boolean;
}) {
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const autocompleteId = useId();
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<EdgeKind>("context");
  const [selected, setSelected] = useState<HydratedObjectRef | null>(null);
  const [results, setResults] = useState<HydratedObjectRef[]>([]);
  const [activeResultKey, setActiveResultKey] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<FeedbackContent | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState<
    PendingAttachment[]
  >([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const trimmedQuery = query.trim();
  const rawRef = useMemo(() => parseResourceRef(trimmedQuery), [trimmedQuery]);

  useEffect(() => {
    if (active) searchInputRef.current?.focus();
  }, [active]);

  useEffect(() => {
    if (trimmedQuery.length < 2 || rawRef !== null || selected !== null) {
      setResults([]);
      setActiveResultKey(null);
      return;
    }
    const controller = new AbortController();
    const searchTimer = window.setTimeout(() => {
      void searchObjectRefs(trimmedQuery, 6, { signal: controller.signal })
        .then((objects) => {
          if (!controller.signal.aborted) setResults(objects);
        })
        .catch((err) => {
          if (isAbortError(err) || controller.signal.aborted) return;
          setResults([]);
          setActiveResultKey(null);
        });
    }, 150);
    return () => {
      controller.abort();
      window.clearTimeout(searchTimer);
    };
  }, [rawRef, selected, trimmedQuery]);

  useEffect(() => {
    setActiveResultKey(results[0] ? objectRefKey(results[0]) : null);
  }, [results]);

  const targetRef = selected
    ? formatResourceRef({
        scheme: selected.objectType,
        id: selected.objectId,
      })
    : rawRef !== null
      ? formatResourceRef(rawRef)
      : null;

  async function submitConnection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFeedback(null);
    if (targetRef === null) {
      setFeedback({
        severity: "warning",
        title: "Choose a result or paste a resource ref.",
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
    setSubmitting(true);
    try {
      await createUserEdge({ sourceRef: selfRef, targetRef, kind });
      setQuery("");
      setSelected(null);
      setResults([]);
      onChanged();
    } catch (err) {
      if (handleUnauthenticatedApiError(err)) return;
      setFeedback(
        toFeedback(err, { fallback: "Connection could not be created." }),
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function attachFiles(files: File[]) {
    if (files.length === 0) {
      return;
    }
    setFeedback(null);
    setAttaching(true);
    let changed = false;
    try {
      for (const file of files) {
        const uploadError = getFileUploadError(file);
        if (uploadError) {
          setFeedback({ severity: "error", title: uploadError });
          continue;
        }
        const accepted: {
          pending: PendingAttachment | null;
          edge: Promise<AttachmentEdgeOutcome> | null;
        } = { pending: null, edge: null };
        let upload;
        try {
          upload = await uploadIngestFile({
            file,
            libraryIds: [],
            onAcceptedIdentity: ({ mediaId, sourceAttemptId }) => {
              const pending: PendingAttachment = {
                mediaId,
                sourceAttemptId,
                label: file.name,
                warning: null,
              };
              accepted.pending = pending;
              setPendingAttachments((current) =>
                upsertPending(current, pending),
              );
              accepted.edge = createAttachmentEdge(selfRef, pending).then(
                () => ({ kind: "Fulfilled" as const }),
                (error: unknown) => ({ kind: "Rejected" as const, error }),
              );
            },
          });
        } catch (error) {
          if (accepted.edge && accepted.pending) {
            const edge = await accepted.edge;
            if (edge.kind === "Fulfilled") {
              setPendingAttachments((current) =>
                current.filter(
                  (item) => item.mediaId !== accepted.pending?.mediaId,
                ),
              );
              changed = true;
            }
          }
          if (isMediaIngestionDefect(error)) {
            setDefect({ error });
            return;
          }
          if (handleUnauthenticatedApiError(error)) return;
          setFeedback(
            toFeedback(error, { fallback: "Attachment could not be added." }),
          );
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
            severity: "warning",
            title: "Attachment was added, but source processing failed.",
          },
        });
        const pending = { ...accepted.pending, warning };
        setPendingAttachments((current) => upsertPending(current, pending));
        const edge = await accepted.edge;
        if (edge.kind === "Rejected") {
          if (isSameSystemApiDefect(edge.error)) {
            setDefect({ error: edge.error });
            return;
          }
          if (handleUnauthenticatedApiError(edge.error)) return;
          setFeedback(
            toFeedback(edge.error, {
              fallback:
                "File was saved, but its connection could not be created.",
            }),
          );
          continue;
        }
        setPendingAttachments((current) =>
          current.filter((item) => item.mediaId !== pending.mediaId),
        );
        changed = true;
        if (warning) setFeedback(warning);
      }
    } finally {
      if (changed) onChanged();
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
      setAttaching(false);
    }
  }

  async function retryAttachment(pending: PendingAttachment) {
    setFeedback(null);
    setAttaching(true);
    try {
      await createAttachmentEdge(selfRef, pending);
      setPendingAttachments((current) =>
        current.filter((item) => item.mediaId !== pending.mediaId),
      );
      if (pending.warning) setFeedback(pending.warning);
      onChanged();
    } catch (error) {
      if (isSameSystemApiDefect(error)) {
        setDefect({ error });
        return;
      }
      if (handleUnauthenticatedApiError(error)) return;
      setFeedback(
        toFeedback(error, {
          fallback: "File was saved, but its connection could not be created.",
        }),
      );
    } finally {
      setAttaching(false);
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
                placeholder="Search or paste resource ref"
                aria-label="Connection target"
                onChange={(event) => {
                  setSelected(null);
                  setFeedback(null);
                  setQuery(event.currentTarget.value);
                }}
              />
              <div className={styles.autocomplete}>
                <ObjectRefAutocomplete
                  id={autocompleteId}
                  objects={results}
                  activeObjectKey={activeResultKey}
                  optionIdForObject={(object) =>
                    `${autocompleteId}-option-${objectRefKey(object)}`
                  }
                  onActiveChange={setActiveResultKey}
                  onPick={(object) => {
                    setSelected(object);
                    setQuery(object.label);
                    setResults([]);
                    setActiveResultKey(null);
                    setFeedback(null);
                  }}
                />
              </div>
            </div>
            <Select
              size="sm"
              value={kind}
              aria-label="Connection kind"
              onChange={(event) =>
                setKind(event.currentTarget.value as EdgeKind)
              }
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
              Connect
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
          {feedback ? <FeedbackNotice feedback={feedback} /> : null}
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
          severity="error"
          title="Connections need attention"
          message="Nexus preserved any accepted file identity. Continue to review its connection."
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

interface PendingAttachment {
  mediaId: string;
  sourceAttemptId: string;
  label: string;
  warning: FeedbackContent | null;
}

type AttachmentEdgeOutcome =
  | { kind: "Fulfilled" }
  | { kind: "Rejected"; error: unknown };

function upsertPending(
  current: PendingAttachment[],
  pending: PendingAttachment,
): PendingAttachment[] {
  return [
    ...current.filter((item) => item.mediaId !== pending.mediaId),
    pending,
  ];
}

function createAttachmentEdge(
  sourceRef: string,
  pending: PendingAttachment,
): Promise<unknown> {
  return createUserEdge({
    sourceRef,
    targetRef: `media:${pending.mediaId}`,
    kind: "context",
  });
}

function DeleteConnectionButton({
  edgeId,
  label,
  onChanged,
}: {
  edgeId: string;
  label: string;
  onChanged: () => void;
}) {
  const [deleting, setDeleting] = useState(false);
  const [feedback, setFeedback] = useState<FeedbackContent | null>(null);

  async function deleteConnection() {
    setDeleting(true);
    setFeedback(null);
    try {
      await deleteUserEdge(edgeId);
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

function objectRefKey(object: HydratedObjectRef): string {
  return `${object.objectType}:${object.objectId}`;
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
