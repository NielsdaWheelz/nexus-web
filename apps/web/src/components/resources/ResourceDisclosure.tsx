"use client";

// One canonical bounded adjacency read feeds the shared editing surface. Supplied
// branches retain their read owner; body knowledge never claims complete links.
// Historical branch provenance labels current relations without granting authority.
import { useContext, useEffect } from "react";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import OutlineSurface from "@/components/notes/OutlineSurface";
import type { Schema } from "@/lib/api/wire";
import { useResourceOutline } from "@/lib/resourceGraph/useResourceOutline";
import { OutlineSessionContext, ResourceBranch } from "./ResourceOutlineList";
import styles from "./ResourceOutline.module.css";

export default function ResourceDisclosure({
  resourceRef,
  occurrencePrefix,
  path = [],
  rootEndpoint = resourceRef,
  supplied,
  readOnly = false,
  historicalBranch = false,
  embeddedInNoteRef = null,
  suppressedEdgeIds = [],
}: {
  resourceRef: string;
  occurrencePrefix: string;
  path?: readonly string[];
  rootEndpoint?: string;
  supplied?: Schema<"OutlineOut"> | null;
  readOnly?: boolean;
  historicalBranch?: boolean;
  embeddedInNoteRef?: string | null;
  suppressedEdgeIds?: readonly string[];
}) {
  const session = useContext(OutlineSessionContext);
  const branch = useContext(ResourceBranch);
  const read = useResourceOutline(resourceRef, supplied);
  const adopt = session?.adoptOutline;
  const {
    source: readSource,
    insertionSource,
    items,
    version,
    complete,
    generation,
    status,
  } = read;
  useEffect(() => {
    adopt?.({
      source: readSource,
      insertionSource,
      items,
      version,
      complete,
      generation,
      status,
    });
  }, [
    adopt,
    readSource,
    insertionSource,
    items,
    version,
    complete,
    generation,
    status,
  ]);
  if (!session)
    throw new Error(
      "a resource disclosure requires its outline surface session",
    );
  const pending = session.pendingOccurrences(resourceRef);
  const acknowledgedOwner =
    pending.find(
      (pending) => pending.acknowledged && pending.sourceRef !== resourceRef,
    )?.sourceRef ?? null;
  const capability = read.insertionSource;
  const source = readOnly ? null : capability;
  const durableOwner =
    capability?.kind === "resource" && capability.ref !== resourceRef
      ? capability.ref
      : acknowledgedOwner;
  const separateOwner = durableOwner !== null && durableOwner !== resourceRef;
  const showLabels =
    separateOwner && (session.outline(durableOwner)?.links.length ?? 0) > 0;
  const childBranch =
    separateOwner && !branch.ancestors.has(durableOwner)
      ? {
          ...branch,
          ancestors: new Map(branch.ancestors).set(
            durableOwner,
            branch.ancestors.get(resourceRef) ?? { kind: "root" as const },
          ),
        }
      : branch;
  const rows = session
    .projectChildren({ endpoint: resourceRef, occurrencePrefix, path, branch })
    .filter((row) => {
      if (suppressedEdgeIds.includes(row.link.link_id)) return false;
      if (
        separateOwner &&
        row.link.connection === null &&
        pending.some(
          (intent) =>
            intent.acknowledged &&
            intent.sourceRef === durableOwner &&
            intent.edgeId === row.link.link_id,
        )
      )
        return false;
      const connection = row.link.connection;
      return !(
        embeddedInNoteRef !== null &&
        connection?.origin === "note_body" &&
        connection.kind === "context" &&
        connection.ordinal === null &&
        connection.source.ref === embeddedInNoteRef &&
        connection.target.ref === resourceRef
      );
    });
  return (
    <>
      {read.status === "loading" ? (
        <p role="status" className={styles.status}>
          loading linked resources…
        </p>
      ) : null}
      {read.error ? (
        <FeedbackNotice
          content={{
            tone: "Warning",
            title: "couldn’t refresh connections",
            requestId: read.error.requestId,
          }}
          announcement="Polite"
          actions={[{ label: "retry refresh", onClick: read.retry }]}
        />
      ) : null}
      <section
        aria-label={separateOwner ? "passage connections" : "linked resources"}
      >
        {showLabels && rows.length > 0 ? (
          <p className={styles.quiet}>passage connections</p>
        ) : null}
        <OutlineSurface
          session={session}
          rows={rows}
          endpoint={resourceRef}
          rootEndpoint={rootEndpoint}
          occurrencePrefix={occurrencePrefix}
          path={path}
          editable={!readOnly}
          historicalBranch={historicalBranch}
          sourceForRow={() =>
            source?.kind === "resource" && source.ref === resourceRef
              ? source
              : null
          }
        />
      </section>
      {read.status === "ready" && read.complete && rows.length === 0 ? (
        <>
          <p className={styles.status}>no linked resources</p>
          {source && !separateOwner ? (
            <button
              type="button"
              className={styles.textButton}
              disabled={session.activeReference !== null}
              onClick={() => {
                if (session.activeReference !== null) return;
                void session.insertNote({
                  destination: {
                    source,
                    position: null,
                    occurrencePrefix,
                    path,
                  },
                });
              }}
            >
              add item
            </button>
          ) : null}
        </>
      ) : null}
      {separateOwner ? (
        <ResourceBranch value={childBranch}>
          <section aria-label="passage items">
            {showLabels && rows.length > 0 ? (
              <p className={styles.quiet}>passage items</p>
            ) : null}
            <ResourceDisclosure
              resourceRef={durableOwner}
              occurrencePrefix={occurrencePrefix}
              path={path}
              rootEndpoint={durableOwner}
              readOnly={readOnly}
              historicalBranch={historicalBranch}
            />
          </section>
        </ResourceBranch>
      ) : null}
      {read.status === "ready" && !read.complete ? (
        <button type="button" className={styles.textButton} onClick={read.more}>
          show more
        </button>
      ) : null}
    </>
  );
}
