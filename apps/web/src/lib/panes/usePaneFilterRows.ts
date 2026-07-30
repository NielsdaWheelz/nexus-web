import { useCallback, useMemo, useState, type ReactNode } from "react";
import type {
  PaneFilterRowsPublication,
  PaneFilterRowsStatus,
} from "@/lib/panes/paneSearch";

function requireNonNegativeInteger(label: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
}

function assertUnreachableRowStatus(status: never): never {
  throw new Error(
    `Unreachable Pane Filter row status: ${JSON.stringify(status)}`,
  );
}

export default function usePaneFilterRows({
  sourceKey,
  inputLabel,
  placeholder,
  getRowStatus,
  activeDomainControlCount,
  filters,
  controls,
}: {
  readonly sourceKey: string;
  readonly inputLabel: string;
  readonly placeholder: string;
  readonly getRowStatus: (query: string) => PaneFilterRowsStatus;
  readonly activeDomainControlCount: number;
  readonly filters?: ReactNode;
  readonly controls?: ReactNode;
}): {
  readonly query: string;
  readonly publication: PaneFilterRowsPublication;
} {
  const [queryState, setQueryState] = useState({ sourceKey, query: "" });
  if (queryState.sourceKey !== sourceKey) {
    setQueryState({ sourceKey, query: "" });
  }
  const query = queryState.sourceKey === sourceKey ? queryState.query : "";
  const onQueryChange = useCallback(
    (nextQuery: string) => setQueryState({ sourceKey, query: nextQuery }),
    [sourceKey],
  );
  const onDismiss = useCallback(
    () => setQueryState({ sourceKey, query: "" }),
    [sourceKey],
  );

  const publication = useMemo<PaneFilterRowsPublication>(() => {
    const rowStatus = getRowStatus(query);
    requireNonNegativeInteger(
      "Pane Filter active domain control count",
      activeDomainControlCount,
    );
    requireNonNegativeInteger(
      "Pane Filter visible row count",
      rowStatus.visibleCount,
    );
    switch (rowStatus.kind) {
      case "Partial":
        requireNonNegativeInteger(
          "Pane Filter loaded row count",
          rowStatus.loadedCount,
        );
        break;
      case "Complete":
        requireNonNegativeInteger(
          "Pane Filter total row count",
          rowStatus.totalCount,
        );
        break;
      default:
        assertUnreachableRowStatus(rowStatus);
    }
    return {
      kind: "FilterRows",
      query,
      inputLabel,
      placeholder,
      onQueryChange,
      onDismiss,
      rowStatus,
      activeDomainControlCount,
      filters,
      controls,
    };
  }, [
    activeDomainControlCount,
    controls,
    filters,
    getRowStatus,
    inputLabel,
    onDismiss,
    onQueryChange,
    placeholder,
    query,
  ]);
  return useMemo(() => ({ query, publication }), [publication, query]);
}
