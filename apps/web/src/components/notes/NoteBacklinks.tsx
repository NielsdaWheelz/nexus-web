"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";
import { Link, Trash2 } from "lucide-react";
import {
  FeedbackNotice,
  toFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import ObjectRefAutocomplete from "@/components/notes/ObjectRefAutocomplete";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import Select from "@/components/ui/Select";
import { useResource } from "@/lib/api/useResource";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { isAbortError } from "@/lib/errors";
import {
  createUserEdge,
  deleteUserEdge,
  edgesForRefPath,
  type EdgeKind,
  type EdgeOut,
} from "@/lib/resourceGraph/edges";
import {
  formatResourceRef,
  parseResourceRef,
} from "@/lib/resourceGraph/resourceRef";
import { resourceIconForUri } from "@/lib/resources/resourceKind";
import {
  isObjectType,
  resolveObjectRefs,
  searchObjectRefs,
  type HydratedObjectRef,
  type ObjectRef,
} from "@/lib/objectRefs";
import styles from "./NoteBacklinks.module.css";

/** The endpoint of a connection that is NOT the object being viewed. */
interface Connection {
  edgeId: string;
  ref: string;
  label: string;
  missing: boolean;
  kind: EdgeKind;
  origin: EdgeOut["origin"];
}

export default function NoteBacklinks({ objectRef }: { objectRef: ObjectRef }) {
  const [refreshTick, setRefreshTick] = useState(0);
  const selfRef = formatResourceRef({
    scheme: objectRef.objectType,
    id: objectRef.objectId,
  });
  const edgesResource = useResource<{ data: EdgeOut[] }>({
    cacheKey: `${selfRef}:${refreshTick}`,
    path: () => edgesForRefPath(selfRef),
  });
  const loading = edgesResource.status === "loading";
  const error: FeedbackContent | null =
    edgesResource.status === "error"
      ? toFeedback(edgesResource.error, {
          fallback: "Connections could not be loaded.",
        })
      : null;

  const connections: Connection[] =
    edgesResource.status === "ready"
      ? edgesResource.data.data.map((edge) =>
          edge.source_ref === selfRef
            ? {
                edgeId: edge.id,
                ref: edge.target_ref,
                label: edge.target_label,
                missing: edge.target_missing,
                kind: edge.kind,
                origin: edge.origin,
              }
            : {
                edgeId: edge.id,
                ref: edge.source_ref,
                label: edge.source_label,
                missing: edge.source_missing,
                kind: edge.kind,
                origin: edge.origin,
              },
        )
      : [];

  const reloadConnections = useCallback(() => {
    setRefreshTick((value) => value + 1);
  }, []);

  const openConnection = useCallback(async (ref: string) => {
    const parsed = parseResourceRef(ref);
    if (!parsed || !isObjectType(parsed.scheme)) return;
    try {
      const [resolved] = await resolveObjectRefs([
        { objectType: parsed.scheme, objectId: parsed.id },
      ]);
      if (resolved?.route) window.location.assign(resolved.route);
    } catch (err) {
      if (handleUnauthenticatedApiError(err)) return;
      console.error("Failed to open connection:", err);
    }
  }, []);

  return (
    <section className={styles.backlinks} aria-label="Connections">
      <div className={styles.header}>
        <h2 className={styles.title}>Connections</h2>
      </div>
      <ConnectionComposer selfRef={selfRef} onChanged={reloadConnections} />
      {loading ? <FeedbackNotice severity="info" title="Loading connections..." /> : null}
      {!loading && error ? <FeedbackNotice feedback={error} /> : null}
      {!loading && !error && connections.length === 0 ? (
        <FeedbackNotice severity="neutral" title="No connected objects yet." />
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
                  onClick={() => void openConnection(connection.ref)}
                >
                  <Icon size={14} aria-hidden="true" />
                  <span className={styles.connectionText}>
                    <span>{connection.label}</span>
                    <span className={styles.connectionMeta}>
                      {connection.kind}
                    </span>
                  </span>
                </button>
                {connection.origin === "user" ? (
                  <DeleteConnectionButton
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
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<EdgeKind>("context");
  const [selected, setSelected] = useState<HydratedObjectRef | null>(null);
  const [results, setResults] = useState<HydratedObjectRef[]>([]);
  const [feedback, setFeedback] = useState<FeedbackContent | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const trimmedQuery = query.trim();
  const rawRef = useMemo(() => parseResourceRef(trimmedQuery), [trimmedQuery]);

  useEffect(() => {
    if (trimmedQuery.length < 2 || rawRef !== null || selected !== null) {
      setResults([]);
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
        });
    }, 150);
    return () => {
      controller.abort();
      window.clearTimeout(searchTimer);
    };
  }, [rawRef, selected, trimmedQuery]);

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
      setFeedback(toFeedback(err, { fallback: "Connection could not be created." }));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className={styles.composer} onSubmit={(event) => void submitConnection(event)}>
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
              objects={results}
              onPick={(object) => {
                setSelected(object);
                setQuery(object.label);
                setResults([]);
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
      setFeedback(toFeedback(err, { fallback: "Connection could not be deleted." }));
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
