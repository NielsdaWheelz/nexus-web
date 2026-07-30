"use client";

import Button from "@/components/ui/Button";
import CollectionView from "@/components/collections/CollectionView";
import { presentPaneFindResult } from "@/lib/collections/presenters/paneFind";
import type { PaneSearchPublication } from "@/lib/panes/paneSearch";
import styles from "./PaneSearchResults.module.css";

type FindPublication = Extract<
  PaneSearchPublication,
  { kind: "FindOccurrences" }
>;

export default function PaneSearchResults({
  publication,
}: {
  readonly publication: FindPublication;
}) {
  const { result } = publication;
  const partialSourceLabel =
    publication.partialSourceLabel ?? "available content";

  switch (result.kind) {
    case "Idle":
      return (
        <p className={styles.message}>
          Enter a search term to see occurrences.
        </p>
      );
    case "Searching":
      return <p className={styles.message}>Searching…</p>;
    case "NoMatches":
      return (
        <p className={styles.message}>
          {result.completeness === "Complete"
            ? "No matches."
            : `No matches in the ${partialSourceLabel}. Results are incomplete.`}
        </p>
      );
    case "TooManyMatches":
      return (
        <p className={styles.message}>
          More than {result.threshold} matches. Refine your search to see
          results.
        </p>
      );
    case "Failed":
      return (
        <div className={styles.failure}>
          <p>Search failed. {result.message}</p>
          <Button variant="secondary" size="sm" onClick={result.onRetry}>
            Retry
          </Button>
        </div>
      );
    case "Ready":
      const rows = result.rows.map((row, index) =>
        presentPaneFindResult({
          row,
          index,
          count: result.rows.length,
          active: row.key === result.activeKey,
          onActivate: publication.onActivate,
        }),
      );
      return (
        <div className={styles.results}>
          {result.completeness === "Partial" ? (
            <p className={styles.partialNotice}>
              Showing matches in the {partialSourceLabel}. Results are
              incomplete.
            </p>
          ) : null}
          <CollectionView
            returnScope="PaneFind.Results"
            rows={rows}
            status="ready"
            ariaLabel="Search results"
            rowActionsAvailable={false}
            surface={false}
          />
        </div>
      );
  }
}
