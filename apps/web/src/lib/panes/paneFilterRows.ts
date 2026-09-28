export interface PaneFilterRowsUnit {
  readonly singular: string;
  readonly plural: string;
}

export type PaneFilterRowsStatus =
  | {
      readonly kind: "Partial";
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
    }
  | {
      readonly kind: "Failed";
      readonly visibleCount: number;
      readonly loadedCount: number;
      readonly unit: PaneFilterRowsUnit;
    };

function requireNonNegativeInteger(label: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
}

export function validatePaneFilterRowsStatus(status: PaneFilterRowsStatus): void {
  requireNonNegativeInteger("Pane Filter visible row count", status.visibleCount);
  switch (status.kind) {
    case "Partial":
    case "Retained":
    case "Failed":
      requireNonNegativeInteger("Pane Filter loaded row count", status.loadedCount);
      if (status.visibleCount > status.loadedCount) {
        throw new Error("Pane Filter visible row count exceeds loaded rows.");
      }
      return;
    case "Complete":
      requireNonNegativeInteger("Pane Filter total row count", status.totalCount);
      if (status.visibleCount > status.totalCount) {
        throw new Error("Pane Filter visible row count exceeds total rows.");
      }
      return;
  }
}

export function paneFilterRowsStatusMessage(
  status: PaneFilterRowsStatus,
  query: string,
): string {
  const unit =
    status.visibleCount === 1 ? status.unit.singular : status.unit.plural;
  const matching = query.trim().length > 0 ? " matching" : "";
  switch (status.kind) {
    case "Partial":
      return `${status.visibleCount}${matching} ${unit} among ${status.loadedCount} loaded; loading remaining ${status.unit.plural}.`;
    case "Complete":
      return `${status.visibleCount}${matching} ${unit} of ${status.totalCount} total.`;
    case "Retained":
      return `${status.visibleCount}${matching} ${unit} among ${status.loadedCount} retained from the previous view; ${status.cause === "Updating" ? "updating" : "update failed"}.`;
    case "Failed":
      return status.loadedCount === 0
        ? "Results unavailable."
        : `${status.visibleCount}${matching} ${unit} among ${status.loadedCount} loaded; loading failed.`;
  }
}

/** A terse visual status for persistent collection controls. */
export function paneCollectionRowsStatusMessage(
  status: PaneFilterRowsStatus,
  query: string,
): string {
  const unit =
    status.visibleCount === 1 ? status.unit.singular : status.unit.plural;
  switch (status.kind) {
    case "Partial":
      return query.trim()
        ? `${status.visibleCount} matches in ${status.loadedCount} loaded; loading more`
        : `${status.visibleCount} ${unit} in ${status.loadedCount} loaded; loading more`;
    case "Complete":
      if (status.visibleCount === status.totalCount) {
        return `${status.visibleCount}${query.trim() ? " matching" : ""} ${unit}`;
      }
      return `${status.visibleCount} of ${status.totalCount} ${status.unit.plural}`;
    case "Retained":
      return status.cause === "Updating"
        ? "updating; showing previous results"
        : "update failed; showing previous results";
    case "Failed":
      return status.loadedCount === 0
        ? "results unavailable"
        : `${status.loadedCount} loaded; loading failed`;
  }
}
