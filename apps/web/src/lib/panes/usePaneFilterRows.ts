import { useCallback, useMemo, useState } from "react";
import type { PaneFilterRowsStatus } from "@/lib/panes/paneFilterRows";
import { validatePaneFilterRowsStatus } from "@/lib/panes/paneFilterRows";
import {
  truncatePaneSearchQuery,
  type PaneFilterRowsPublication,
} from "@/lib/panes/paneSearch";

export default function usePaneFilterRows({
  sourceKey,
  getRowStatus,
}: {
  readonly sourceKey: string;
  readonly getRowStatus: (query: string) => PaneFilterRowsStatus;
}): {
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
  readonly clearQuery: () => void;
  readonly rowStatus: PaneFilterRowsStatus;
} {
  const [queryState, setQueryState] = useState({ sourceKey, query: "" });
  if (queryState.sourceKey !== sourceKey) {
    setQueryState({ sourceKey, query: "" });
  }
  const query = queryState.sourceKey === sourceKey ? queryState.query : "";
  const onQueryChange = useCallback(
    (nextQuery: string) =>
      setQueryState({
        sourceKey,
        query: truncatePaneSearchQuery(nextQuery),
      }),
    [sourceKey],
  );
  const clearQuery = useCallback(
    () => setQueryState({ sourceKey, query: "" }),
    [sourceKey],
  );
  const rowStatus = useMemo(() => {
    const status = getRowStatus(query);
    validatePaneFilterRowsStatus(status);
    return status;
  }, [getRowStatus, query]);
  return useMemo(
    () => ({ query, onQueryChange, clearQuery, rowStatus }),
    [query, onQueryChange, clearQuery, rowStatus],
  );
}

export function usePaneTransientFilterRows({
  sourceKey,
  inputLabel,
  placeholder,
  getRowStatus,
}: {
  readonly sourceKey: string;
  readonly inputLabel: string;
  readonly placeholder: string;
  readonly getRowStatus: (query: string) => PaneFilterRowsStatus;
}): {
  readonly query: string;
  readonly publication: PaneFilterRowsPublication;
} {
  const { query, onQueryChange, clearQuery, rowStatus } = usePaneFilterRows({
    sourceKey,
    getRowStatus,
  });
  const publication = useMemo<PaneFilterRowsPublication>(
    () => ({
      kind: "FilterRows",
      query,
      inputLabel,
      placeholder,
      onQueryChange,
      onDismiss: clearQuery,
      rowStatus,
    }),
    [query, inputLabel, placeholder, onQueryChange, clearQuery, rowStatus],
  );
  return useMemo(() => ({ query, publication }), [query, publication]);
}
