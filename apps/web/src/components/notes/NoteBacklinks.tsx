"use client";

import { useCallback } from "react";
import {
  FeedbackNotice,
  toFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import { useResource } from "@/lib/api/useResource";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { edgesForRefPath, type EdgeOut } from "@/lib/resourceGraph/edges";
import {
  formatResourceRef,
  parseResourceRef,
} from "@/lib/resourceGraph/resourceRef";
import { resourceIconForUri } from "@/lib/resources/resourceKind";
import { isObjectType, resolveObjectRefs, type ObjectRef } from "@/lib/objectRefs";
import styles from "./NoteBacklinks.module.css";

/** The endpoint of a connection that is NOT the object being viewed. */
interface Connection {
  edgeId: string;
  ref: string;
  label: string;
  missing: boolean;
}

export default function NoteBacklinks({ objectRef }: { objectRef: ObjectRef }) {
  const selfRef = formatResourceRef({
    scheme: objectRef.objectType,
    id: objectRef.objectId,
  });
  const edgesResource = useResource<{ data: EdgeOut[] }>({
    cacheKey: selfRef,
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
              }
            : {
                edgeId: edge.id,
                ref: edge.source_ref,
                label: edge.source_label,
                missing: edge.source_missing,
              },
        )
      : [];

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
      <h2 className={styles.title}>Connections</h2>
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
              <button
                key={connection.edgeId}
                type="button"
                className={`${styles.linkRow}${connection.missing ? ` ${styles.missing}` : ""}`}
                disabled={connection.missing}
                onClick={() => void openConnection(connection.ref)}
              >
                <Icon size={14} aria-hidden="true" />
                <span>{connection.label}</span>
              </button>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}
