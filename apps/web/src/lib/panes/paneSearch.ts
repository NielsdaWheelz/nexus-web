import type { FindController } from "@/lib/find/useFind";
import type { PaneFilterRowsStatus } from "@/lib/panes/paneFilterRows";

/** The pane search row's input cap, for filter and find alike. */
const PANE_SEARCH_QUERY_MAX_CODEPOINTS = 256;

export interface PaneFilterRowsPublication {
  readonly kind: "FilterRows";
  readonly query: string;
  readonly inputLabel: string;
  readonly placeholder: string;
  readonly onQueryChange: (query: string) => void;
  readonly onDismiss: () => void;
  readonly rowStatus: PaneFilterRowsStatus;
}

/** Find publishes its controller; the bar and the results list drive it directly. */
export interface PaneFindPublication {
  readonly kind: "Find";
  readonly find: FindController;
}

/**
 * A pane with nothing to search publishes nothing. A pane whose search source
 * is still loading publishes `Resolving`, naming the control it will become,
 * so the header's local action set keeps one shape across that window instead
 * of growing an entry when the source lands. Only publish it where the loaded
 * answer is certain to be a search: a resolving action that later disappears
 * is the same reflow in reverse.
 */
export interface PaneSearchResolvingPublication {
  readonly kind: "Resolving";
  readonly control: "Find" | "Filter";
}

/** What every search renderer consumes; a resolving pane has none of it yet. */
export type PaneReadySearchPublication =
  PaneFilterRowsPublication | PaneFindPublication;

export type PaneSearchPublication =
  | PaneSearchResolvingPublication
  | PaneReadySearchPublication;

export function truncatePaneSearchQuery(query: string): string {
  return Array.from(query)
    .slice(0, PANE_SEARCH_QUERY_MAX_CODEPOINTS)
    .join("");
}

function areFilterRowsStatusesEqual(
  left: PaneFilterRowsStatus,
  right: PaneFilterRowsStatus,
): boolean {
  if (
    left.kind !== right.kind ||
    left.visibleCount !== right.visibleCount ||
    left.unit.singular !== right.unit.singular ||
    left.unit.plural !== right.unit.plural
  ) {
    return false;
  }
  switch (left.kind) {
    case "Partial":
      return right.kind === "Partial" && left.loadedCount === right.loadedCount;
    case "Complete":
      return right.kind === "Complete" && left.totalCount === right.totalCount;
    case "Retained":
      return (
        right.kind === "Retained" &&
        left.loadedCount === right.loadedCount &&
        left.cause === right.cause
      );
    case "Failed":
      return right.kind === "Failed" && left.loadedCount === right.loadedCount;
  }
}

export function arePaneSearchPublicationsEqual(
  left: PaneSearchPublication | undefined,
  right: PaneSearchPublication | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right || left.kind !== right.kind) return false;
  if (left.kind === "Resolving" || right.kind === "Resolving") {
    return (
      left.kind === "Resolving" &&
      right.kind === "Resolving" &&
      left.control === right.control
    );
  }
  if (left.kind === "Find")
    return right.kind === "Find" && left.find === right.find;
  return (
    right.kind === "FilterRows" &&
    left.query === right.query &&
    left.inputLabel === right.inputLabel &&
    left.placeholder === right.placeholder &&
    left.onQueryChange === right.onQueryChange &&
    left.onDismiss === right.onDismiss &&
    areFilterRowsStatusesEqual(left.rowStatus, right.rowStatus)
  );
}
