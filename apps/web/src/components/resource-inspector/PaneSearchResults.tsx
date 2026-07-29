"use client";

import Button from "@/components/ui/Button";
import EmphasisSegments from "@/components/ui/EmphasisSegments";
import ResourceList from "@/components/ui/ResourceList";
import ResourceRow from "@/components/ui/ResourceRow";
import type {
  PaneFindResultRow,
  PaneSearchPublication,
} from "@/lib/panes/paneSearch";
import styles from "./PaneSearchResults.module.css";

type FindPublication = Extract<
  PaneSearchPublication,
  { kind: "FindOccurrences" }
>;

function rowAccessibleName({
  row,
  index,
  count,
  active,
}: {
  readonly row: PaneFindResultRow;
  readonly index: number;
  readonly count: number;
  readonly active: boolean;
}): string {
  const location = row.context.join(", ");
  const snippet = row.snippet.map((segment) => segment.text).join("");
  return [
    active ? "Current match" : "Go to match",
    `${index + 1} of ${count}`,
    location,
    snippet,
  ]
    .filter(Boolean)
    .join(": ");
}

function ResultContext({ context }: { readonly context: readonly string[] }) {
  return context.map((part, index) => (
    <span key={`${index}:${part}`}>
      {index > 0 ? (
        <span className={styles.contextSeparator} aria-hidden="true">
          {" / "}
        </span>
      ) : null}
      {part}
    </span>
  ));
}

export default function PaneSearchResults({
  publication,
}: {
  readonly publication: FindPublication;
}) {
  const { result } = publication;

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
            : "No matches found so far."}
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
      return (
        <div className={styles.results}>
          {result.completeness === "Partial" ? (
            <p className={styles.partialNotice}>
              Showing matches found so far.
            </p>
          ) : null}
          <ResourceList ariaLabel="Search results">
            {result.rows.map((row, index) => {
              const active = row.key === result.activeKey;
              return (
                <ResourceRow
                  key={row.key}
                  primary={{
                    kind: "button",
                    label: rowAccessibleName({
                      row,
                      index,
                      count: result.rows.length,
                      active,
                    }),
                    onActivate: () => publication.onActivate(row.key),
                  }}
                  title={
                    <EmphasisSegments
                      segments={row.snippet}
                      emphasisClassName={styles.mark}
                    />
                  }
                  supporting={
                    row.context.length > 0 ? (
                      <ResultContext context={row.context} />
                    ) : undefined
                  }
                  selected={active}
                  rootProps={{ "aria-current": active ? "true" : undefined }}
                />
              );
            })}
          </ResourceList>
        </div>
      );
  }
}
