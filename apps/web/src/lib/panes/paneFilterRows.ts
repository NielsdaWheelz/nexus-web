"use client";

import { paneFilterText } from "./paneFilterText";
import { useCallback, useMemo, useState } from "react";
import { truncatePaneSearchQuery } from "@/lib/panes/paneChrome";
import { definePaneVisitDataKey, usePaneVisitData } from "@/lib/workspace/paneReturnMemento";

const FILTER = definePaneVisitDataKey<{
  readonly sourceKey: string;
  readonly query: string;
}>("PaneFilterRows.Query");

export interface PaneFilterRowsUnit {
  readonly singular: string;
  readonly plural: string;
}

/**
 * The counts of a locally filtered list. Counts are whole rows and visible
 * never exceeds loaded or total; the one producer of each status owns that.
 */
export type PaneFilterRowsStatus =
  | {
      readonly kind: "Partial" | "Failed";
      readonly visibleCount: number;
      readonly loadedCount: number;
      readonly unit: PaneFilterRowsUnit;
    }
  | {
      readonly kind: "Complete";
      readonly visibleCount: number;
      readonly totalCount: number;
      readonly unit: PaneFilterRowsUnit;
    };

/** The filter's own description, in full sentences. A failed load is the list's to tell, never
 * the filter's: it counts what loaded, and says nothing when nothing did. */
export function paneFilterRowsStatusMessage(
  status: PaneFilterRowsStatus,
  query: string,
): string {
  const unit =
    status.visibleCount === 1 ? status.unit.singular : status.unit.plural;
  const textActive = query.trim() !== "";
  const matches = `${status.visibleCount} ${status.visibleCount === 1 ? "match" : "matches"}`;
  switch (status.kind) {
    case "Partial":
    case "Failed": {
      if (status.loadedCount === 0) return status.kind === "Partial" ? `no ${status.unit.plural} loaded yet.` : "";
      const units = status.loadedCount === 1 ? status.unit.singular : status.unit.plural;
      return textActive ? `${matches} among ${status.loadedCount} loaded ${units}.` : `${status.loadedCount} ${units} loaded so far.`;
    }
    case "Complete":
      return `${status.visibleCount}${textActive ? " matching" : ""} ${unit} of ${status.totalCount}.`;
  }
}

export function matchesPaneFilterQuery(
  query: string,
  fields: readonly string[],
): boolean {
  const needle = paneFilterText(query.trim());
  return (
    needle.length === 0 ||
    fields.some((field) =>
      paneFilterText(field).includes(needle),
    )
  );
}
/** Visit-local filter text; a new source starts empty. */
export function usePaneFilterRows(input: {
  readonly sourceKey: string;
  readonly getRowStatus: (query: string) => PaneFilterRowsStatus;
}) {
  const { sourceKey, getRowStatus } = input;
  const retained = usePaneVisitData(FILTER, () => ({ sourceKey, query }));
  const [state, setState] = useState(retained ?? { sourceKey, query: "" });
  const query: string = state.sourceKey === sourceKey ? state.query : "";
  const onQueryChange = useCallback(
    (next: string) =>
      setState({ sourceKey, query: truncatePaneSearchQuery(next) }),
    [sourceKey],
  );
  const clearQuery = useCallback(
    () => setState({ sourceKey, query: "" }),
    [sourceKey],
  );
  const rowStatus = useMemo(() => getRowStatus(query), [getRowStatus, query]);
  return useMemo(
    () => ({ query, onQueryChange, clearQuery, rowStatus }),
    [query, onQueryChange, clearQuery, rowStatus],
  );
}
