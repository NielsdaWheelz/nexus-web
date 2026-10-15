"use client";

import { useCallback, useMemo, useState } from "react";
import { truncatePaneSearchQuery } from "@/lib/panes/paneChrome";

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

/** The default view needs no repeated count when its header describes the same committed rows. */
export function paneFilterRowsStatusVisible({
  status,
  identityCount,
  atDefaultView,
}: {
  readonly status: PaneFilterRowsStatus;
  readonly identityCount: number | null;
  readonly atDefaultView: boolean;
}): boolean {
  return (
    status.kind !== "Complete" ||
    !atDefaultView ||
    identityCount === null ||
    status.visibleCount !== status.totalCount ||
    status.totalCount !== identityCount
  );
}

/** The spoken status: full sentences. */
export function paneFilterRowsStatusMessage(
  status: PaneFilterRowsStatus,
  query: string,
): string {
  const unit =
    status.visibleCount === 1 ? status.unit.singular : status.unit.plural;
  const shown = `${status.visibleCount}${query.trim() ? " matching" : ""} ${unit}`;
  switch (status.kind) {
    case "Partial":
      return `${shown} among ${status.loadedCount} loaded; this is not the full collection.`;
    case "Complete":
      return `${shown} of ${status.totalCount} total.`;
    case "Retained":
      return `${shown} among ${status.loadedCount} retained from the previous view; ${status.cause === "Updating" ? "updating" : "update failed"}.`;
    case "Failed":
      return status.loadedCount === 0
        ? "Results unavailable."
        : `${shown} among ${status.loadedCount} loaded; loading failed.`;
  }
}

/** The visible status of a persistent collection row: terse. */
export function paneCollectionRowsStatusMessage(
  status: PaneFilterRowsStatus,
  query: string,
): string {
  const unit =
    status.visibleCount === 1 ? status.unit.singular : status.unit.plural;
  switch (status.kind) {
    case "Partial":
      return query.trim()
        ? `${status.visibleCount} matches in ${status.loadedCount} loaded`
        : `${status.visibleCount} ${unit} in ${status.loadedCount} loaded`;
    case "Complete":
      return status.visibleCount === status.totalCount
        ? `${status.visibleCount}${query.trim() ? " matching" : ""} ${unit}`
        : `${status.visibleCount} of ${status.totalCount} ${status.unit.plural}`;
    case "Retained":
      return `${status.cause === "Updating" ? "updating" : "update failed"}; showing previous results`;
    case "Failed":
      return status.loadedCount === 0
        ? "results unavailable"
        : `${status.loadedCount} loaded; loading failed`;
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
  const [state, setState] = useState({ sourceKey, query: "" });
  const query = state.sourceKey === sourceKey ? state.query : "";
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
