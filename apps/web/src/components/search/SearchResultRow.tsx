"use client";

import ContributorCreditList from "@/components/contributors/ContributorCreditList";
import ResourceRow from "@/components/ui/ResourceRow";
import { hrefForResourceActivation } from "@/lib/resources/activation";
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
  const href = hrefForResourceActivation(row.activation);
  if (!href) {
    throw new Error("Search result missing activation href");
  }
  return (
    <ResourceRow
      primary={{ kind: "link", href, paneTitleHint: row.paneTitleHint }}
      title={<span className={styles.primaryText}>{renderSnippetContent(row)}</span>}
      description={<span className={styles.type}>{row.typeLabel}</span>}
      meta={<span className={styles.meta}>{row.sourceMeta}</span>}
      contributors={
        row.contributorCredits.length > 0 ? (
          <ContributorCreditList
            credits={row.contributorCredits}
            className={styles.contributors}
            showRole
          />
        ) : undefined
      }
      expanded={
        row.noteBody ? (
          <div className={styles.noteBody}>{row.noteBody}</div>
        ) : undefined
      }
    />
  );
}
