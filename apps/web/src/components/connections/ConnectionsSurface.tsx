"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
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
import Pill from "@/components/ui/Pill";
import Select from "@/components/ui/Select";
import { useResource } from "@/lib/api/useResource";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { isAbortError } from "@/lib/errors";
import {
  getFileUploadError,
  isFailedSourceIngest,
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
        label: connection.label,
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
      {scan.feedback ? <FeedbackNotice feedback={scan.feedback} /> : null}
      {scanning ? (
        <p className={styles.scanVoice}>Scanning…</p>
      ) : scanVoice ? (
        <p className={styles.scanVoice}>{scanVoice}</p>
      ) : null}
      <ConnectionComposer selfRef={selfRef} onChanged={reloadConnections} />
      {loading ? (
        <FeedbackNotice severity="info" title="Loading connections..." />
      ) : null}
      {!loading && error ? <FeedbackNotice feedback={error} /> : null}
      {!loading && !error && connections.length === 0 ? (
        <FeedbackNotice
          severity="neutral"
          title={
            scannable
              ? "No connections yet. Scan to find resonant material, or link one manually."
              : "No connected objects yet."
          }
        />
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
                      <span className={styles.connectionMeta}>
                        {connection.rationale}
                      </span>
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
  selfRef,
  onChanged,
}: {
  selfRef: string;
  onChanged: () => void;
}) {
  const autocompleteId = useId();
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<EdgeKind>("context");
  const [selected, setSelected] = useState<HydratedObjectRef | null>(null);
  const [results, setResults] = useState<HydratedObjectRef[]>([]);
  const [activeResultKey, setActiveResultKey] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<FeedbackContent | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const trimmedQuery = query.trim();
  const rawRef = useMemo(() => parseResourceRef(trimmedQuery), [trimmedQuery]);

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
    try {
      for (const file of files) {
        const uploadError = getFileUploadError(file);
        if (uploadError) {
          throw new Error(uploadError);
        }
        const result = await uploadIngestFile({ file, libraryIds: [] });
        if (isFailedSourceIngest(result)) {
          throw new Error("Attachment could not be uploaded.");
        }
        await createUserEdge({
          sourceRef: selfRef,
          targetRef: `media:${result.mediaId}`,
          kind: "context",
        });
      }
      onChanged();
    } catch (err) {
      if (handleUnauthenticatedApiError(err)) return;
      setFeedback(
        toFeedback(err, { fallback: "Attachment could not be added." }),
      );
    } finally {
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
      setAttaching(false);
    }
  }

  return (
    <form
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
          onChange={(event) => setKind(event.currentTarget.value as EdgeKind)}
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
      {feedback ? <FeedbackNotice feedback={feedback} /> : null}
    </form>
  );
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
