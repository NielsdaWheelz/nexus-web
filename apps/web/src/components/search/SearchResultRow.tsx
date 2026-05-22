"use client";

import ContextRow from "@/components/ui/ContextRow";
import ContributorCreditList from "@/components/contributors/ContributorCreditList";
import type { SearchResultRowViewModel } from "@/lib/search/resultRowAdapter";
import { isObjectType } from "@/lib/objectRefs";
import { setPendingContextParam } from "@/lib/conversations/attachedContext";
import styles from "./SearchResultRow.module.css";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface SearchResultRowProps {
  row: SearchResultRowViewModel;
}

function renderSnippetContent(row: SearchResultRowViewModel) {
  if (row.type === "note_block") {
    return row.primaryText;
  }

  if (row.snippetSegments.length === 0) {
    return row.primaryText;
  }

  return row.snippetSegments.map((segment, idx) =>
    segment.emphasized ? (
      <mark key={`seg-${idx}`} className={styles.segmentMark}>
        {segment.text}
      </mark>
    ) : (
      <span key={`seg-${idx}`}>{segment.text}</span>
    )
  );
}

function buildAskHref(row: SearchResultRowViewModel): string | null {
  if (!row.contextRef) {
    return null;
  }
  if (!isObjectType(row.contextRef.type) || !UUID_RE.test(row.contextRef.id)) {
    return null;
  }
  if (
    row.contextRef.evidenceSpanIds.length > 0 &&
    !row.contextRef.evidenceSpanIds.every((id) => UUID_RE.test(id))
  ) {
    return null;
  }
  if (
    row.contextRef.type === "artifact_part" &&
    (!row.contextRef.artifactId ||
      !UUID_RE.test(row.contextRef.artifactId) ||
      !row.contextRef.sourceVersion ||
      !row.contextRef.locator ||
      !row.contextRef.artifactPartProvenance)
  ) {
    return null;
  }

  const params = new URLSearchParams();
  if (
    row.type === "content_chunk" &&
    row.mediaId &&
    UUID_RE.test(row.mediaId) &&
    row.contextRef.evidenceSpanIds.length > 0
  ) {
    params.set("scope", `media:${row.mediaId}`);
  }
  const next = setPendingContextParam(params, {
    type: row.contextRef.type,
    id: row.contextRef.id,
    ...(row.contextRef.evidenceSpanIds.length > 0
      ? { evidence_span_ids: row.contextRef.evidenceSpanIds }
      : {}),
    artifact_id: row.contextRef.artifactId,
    artifact_key: row.contextRef.artifactKey,
    artifact_version: row.contextRef.artifactVersion,
    source_version: row.contextRef.sourceVersion,
    locator: row.contextRef.locator,
    artifact_part_provenance: row.contextRef.artifactPartProvenance,
  });
  return `/conversations/new?${next.toString()}`;
}

export default function SearchResultRow({ row }: SearchResultRowProps) {
  const askHref = buildAskHref(row);

  return (
    <ContextRow
      className={styles.row}
      mainClassName={styles.main}
      href={row.href}
      title={<span className={styles.primaryText}>{renderSnippetContent(row)}</span>}
      titleClassName={styles.title}
      description={row.typeLabel}
      descriptionClassName={styles.type}
      meta={row.sourceMeta ?? row.scoreLabel}
      metaClassName={styles.meta}
      trailing={<span className={styles.score}>{row.scoreLabel}</span>}
      actions={
        row.contributorCredits.length > 0 || askHref ? (
          <>
            {askHref ? (
              <a className={styles.askLink} href={askHref}>
                {row.type === "content_chunk" ? "Ask with evidence" : "Ask with context"}
              </a>
            ) : null}
            {row.contributorCredits.length > 0 ? (
              <ContributorCreditList
                credits={row.contributorCredits}
                className={styles.contributors}
                showRole
              />
            ) : null}
          </>
        ) : undefined
      }
      actionsClassName={styles.actions}
      expandedContent={
        row.noteBody ? (
          <div className={styles.noteBody}>{row.noteBody}</div>
        ) : undefined
      }
      expandedClassName={styles.expanded}
    />
  );
}
