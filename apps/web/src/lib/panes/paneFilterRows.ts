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

/** The spoken status: full sentences. */
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
      return status.loadedCount === 0
        ? `No ${status.unit.plural} loaded yet; results are incomplete.`
        : `${textActive ? `${matches} among ` : ""}${status.loadedCount} loaded ${status.loadedCount === 1 ? status.unit.singular : status.unit.plural}; results are incomplete.`;
    case "Complete":
      return `${status.visibleCount}${textActive ? " matching" : ""} ${unit} of ${status.totalCount} total.`;
    case "Failed":
      return status.loadedCount === 0
        ? "Results unavailable."
        : `Loading failed; ${textActive ? `${matches} among ` : ""}${status.loadedCount} loaded ${status.loadedCount === 1 ? status.unit.singular : status.unit.plural}.`;
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
