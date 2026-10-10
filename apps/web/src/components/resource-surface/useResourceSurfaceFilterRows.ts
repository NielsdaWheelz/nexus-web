import { useCallback, useMemo, useState } from "react";
import {
  matchesPaneFilterQuery,
  usePaneTransientFilterRows,
} from "@/lib/panes/paneFilterRows";
import type { ResourceSurface } from "@/lib/resources/resourceItems";
import { resourceSurfaceFilterFields } from "./resourceSurfaceFilterFields";

/**
 * Pane filter over one resource surface's rows. `ready` turns true once the
 * surface for `sourceKey` has reported its rows (or `markReady` says it has
 * none to report); a new `sourceKey` starts over.
 */
export function useResourceSurfaceFilterRows(
  sourceKey: string,
  inputLabel: string,
) {
  const [state, setState] = useState<{
    sourceKey: string;
    ready: boolean;
    fields: readonly (readonly string[])[];
  }>({ sourceKey, ready: false, fields: [] });
  if (state.sourceKey !== sourceKey) {
    setState({ sourceKey, ready: false, fields: [] });
  }
  const filterRows = useMemo(
    () => (state.sourceKey === sourceKey ? state.fields : []),
    [state, sourceKey],
  );
  const ready = state.sourceKey === sourceKey && state.ready;
  const getRowStatus = useCallback(
    (query: string) => {
      const visibleCount = filterRows.filter((fields) =>
        matchesPaneFilterQuery(query, fields),
      ).length;
      const unit = { singular: "item", plural: "items" };
      return ready
        ? {
            kind: "Complete" as const,
            visibleCount,
            totalCount: filterRows.length,
            unit,
          }
        : {
            kind: "Partial" as const,
            visibleCount,
            loadedCount: filterRows.length,
            unit,
          };
    },
    [filterRows, ready],
  );
  const { query, search } = usePaneTransientFilterRows({
    sourceKey,
    inputLabel,
    placeholder: "Filter items",
    getRowStatus,
  });
  const acceptSurface = useCallback(
    (surface: ResourceSurface) =>
      setState({
        sourceKey,
        ready: true,
        fields: surface.orderedItems.map(resourceSurfaceFilterFields),
      }),
    [sourceKey],
  );
  const markReady = useCallback(
    () =>
      setState((current) =>
        current.sourceKey === sourceKey ? { ...current, ready: true } : current,
      ),
    [sourceKey],
  );
  return { ready, query, search, acceptSurface, markReady };
}
