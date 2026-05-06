"use client";

import ContextRow from "@/components/ui/ContextRow";
import ContributorCreditList from "@/components/contributors/ContributorCreditList";
import type { SearchResultRowViewModel } from "@/lib/search/resultRowAdapter";
import styles from "./SearchResultRow.module.css";

interface SearchResultRowProps {
  row: SearchResultRowViewModel;
}

function renderSnippetContent(row: SearchResultRowViewModel) {
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
  if (
    row.type !== "content_chunk" ||
    !row.mediaId ||
    !row.contextRef ||
    row.contextRef.evidenceSpanIds.length === 0
  ) {
    return null;
  }

  const params = new URLSearchParams({
    scope: `media:${row.mediaId}`,
    context: [
      row.contextRef.type,
      row.contextRef.id,
      row.contextRef.evidenceSpanIds.join(","),
    ].join(":"),
  });
  return `/conversations/new?${params.toString()}`;
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
                Ask with evidence
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
