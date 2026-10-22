"use client";

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
    }
  | {
      readonly kind: "Retained";
      readonly visibleCount: number;
      readonly loadedCount: number;
      readonly unit: PaneFilterRowsUnit;
      readonly cause: "Updating" | "Failed";
    };

/** Complete lists show counts only while text or facets filter the view. */
export function paneFilterRowsStatusVisible({
  status,
  filtering,
}: {
  readonly status: PaneFilterRowsStatus;
  readonly filtering: boolean;
}): boolean {
  return status.kind !== "Complete" || filtering;
}

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
    case "Retained":
      return `${status.cause === "Updating" ? "Updating" : "Update failed"}; showing results from the previous view.`;
    case "Failed":
      return status.loadedCount === 0
        ? "Results unavailable."
        : `Loading failed; ${textActive ? `${matches} among ` : ""}${status.loadedCount} loaded ${status.loadedCount === 1 ? status.unit.singular : status.unit.plural}.`;
  }
}

/** The visible status of a persistent collection row: terse. */
export function paneCollectionRowsStatusMessage(
  status: PaneFilterRowsStatus,
  query: string,
): string {
  const unit =
    status.visibleCount === 1 ? status.unit.singular : status.unit.plural;
  const textActive = query.trim() !== "";
  switch (status.kind) {
    case "Partial":
      return status.loadedCount === 0
        ? `no ${status.unit.plural} loaded yet`
        : textActive
          ? `${status.visibleCount} ${status.visibleCount === 1 ? "match" : "matches"} in ${status.loadedCount} loaded; results incomplete`
          : `${status.loadedCount} ${status.loadedCount === 1 ? status.unit.singular : status.unit.plural} loaded; results incomplete`;
    case "Complete":
      return !textActive || status.visibleCount === status.totalCount
        ? `${status.visibleCount}${textActive ? " matching" : ""} ${unit}`
        : `${status.visibleCount} of ${status.totalCount} ${status.totalCount === 1 ? status.unit.singular : status.unit.plural}`;
    case "Retained":
      return `${status.cause === "Updating" ? "updating" : "update failed"}; showing previous results`;
    case "Failed":
      return status.loadedCount === 0
        ? "results unavailable"
        : textActive
          ? `loading failed; ${status.visibleCount} ${status.visibleCount === 1 ? "match" : "matches"} in ${status.loadedCount} loaded`
          : `loading failed; ${status.loadedCount} ${status.loadedCount === 1 ? status.unit.singular : status.unit.plural} loaded`;
  }
}

export function matchesPaneFilterQuery(
  query: string,
  fields: readonly string[],
): boolean {
  const needle = query.trim().normalize("NFC").toLowerCase();
  return (
    needle.length === 0 ||
    fields.some((field) =>
      field.normalize("NFC").toLowerCase().includes(needle),
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
