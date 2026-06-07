"use client";

import ContextRow from "@/components/ui/ContextRow";
import ContributorCreditList from "@/components/contributors/ContributorCreditList";
import type { SearchResultRowViewModel } from "@/lib/search/types";
import styles from "./SearchResultRow.module.css";

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

export default function SearchResultRow({ row }: SearchResultRowProps) {
  return (
    <ContextRow
      className={styles.row}
      mainClassName={styles.main}
      href={row.href}
      title={<span className={styles.primaryText}>{renderSnippetContent(row)}</span>}
      titleClassName={styles.title}
      description={row.typeLabel}
      descriptionClassName={styles.type}
      meta={row.sourceMeta}
      metaClassName={styles.meta}
      actions={
        row.contributorCredits.length > 0 ? (
          <ContributorCreditList
            credits={row.contributorCredits}
            className={styles.contributors}
            showRole
          />
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
