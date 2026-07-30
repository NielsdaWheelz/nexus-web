import type { ReactNode } from "react";
import type { EmphasisSegment } from "@/lib/ui/emphasis";

export const PANE_SEARCH_QUERY_MAX_CODEPOINTS = 256;

export type PaneFindResultKey = string & {
  readonly __paneFindResultKey: unique symbol;
};

export type PaneFindSourceKey = string & {
  readonly __paneFindSourceKey: unique symbol;
};

export type PaneFindIdentityValue =
  | null
  | boolean
  | number
  | string
  | readonly PaneFindIdentityValue[]
  | { readonly [key: string]: PaneFindIdentityValue };

export interface PaneFindScopeOption {
  readonly kind: "EntireResource" | "Narrow";
  readonly id: string;
  readonly label: string;
}

export type PaneFindScopeControl =
  | { readonly kind: "EntireResource" }
  | {
      readonly kind: "Selectable";
      readonly selectedId: string;
      readonly options: readonly PaneFindScopeOption[];
      readonly onChange: (id: string) => void;
    };

export interface PaneFindResultRow {
  readonly key: PaneFindResultKey;
  readonly context: readonly string[];
  readonly snippet: readonly EmphasisSegment[];
}

export type PaneFindResult =
  | { readonly kind: "Idle" }
  | { readonly kind: "Searching" }
  | {
      readonly kind: "NoMatches";
      readonly completeness: "Complete" | "Partial";
    }
  | {
      readonly kind: "Ready";
      readonly completeness: "Complete" | "Partial";
      readonly rows: readonly PaneFindResultRow[];
      readonly activeKey: PaneFindResultKey;
    }
  | { readonly kind: "TooManyMatches"; readonly threshold: number }
  | {
      readonly kind: "Failed";
      readonly message: string;
      readonly onRetry: () => void;
    };

interface PaneSearchBase {
  readonly query: string;
  readonly inputLabel: string;
  readonly placeholder: string;
  readonly onQueryChange: (query: string) => void;
  readonly onDismiss: () => void;
}

export type PaneFilterRowsPublication = PaneSearchBase & {
  readonly kind: "FilterRows";
  readonly rowStatus: PaneFilterRowsStatus;
  readonly activeDomainControlCount: number;
  readonly filters?: ReactNode;
  readonly controls?: ReactNode;
};

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
    };

export type PaneFindOccurrencesPublication = PaneSearchBase & {
  readonly kind: "FindOccurrences";
  readonly result: PaneFindResult;
  readonly scope: PaneFindScopeControl;
  readonly matchCase: boolean;
  readonly wholeWord: boolean;
  readonly onMatchCaseChange: (value: boolean) => void;
  readonly onWholeWordChange: (value: boolean) => void;
  readonly onStep: (direction: "Previous" | "Next") => void;
  readonly onActivate: (key: PaneFindResultKey) => void;
  readonly onShowResults: (trigger: HTMLButtonElement | null) => void;
  readonly resultsExpanded: boolean;
  readonly returnToReadingPosition:
    | { readonly kind: "Unavailable" }
    | {
        readonly kind: "Available";
        readonly onReturn: () => void;
      };
};

export type PaneSearchPublication =
  | PaneFilterRowsPublication
  | PaneFindOccurrencesPublication;

export function truncatePaneSearchQuery(query: string): string {
  return Array.from(query)
    .slice(0, PANE_SEARCH_QUERY_MAX_CODEPOINTS)
    .join("");
}

function canonicalIdentityJson(value: PaneFindIdentityValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new Error("Pane Find identities require canonical finite numbers.");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalIdentityJson).join(",")}]`;
  }
  const entries = Object.entries(value).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  return `{${entries
    .map(
      ([key, child]) =>
        `${JSON.stringify(key)}:${canonicalIdentityJson(child)}`,
    )
    .join(",")}}`;
}

export function createPaneFindSourceKey(
  identity: PaneFindIdentityValue,
): PaneFindSourceKey {
  // justify-type-assertion: this sole constructor encodes the complete
  // structured source identity canonically before applying the opaque brand.
  return canonicalIdentityJson(identity) as PaneFindSourceKey;
}

export function createPaneFindResultKey(input: {
  readonly source: PaneFindIdentityValue;
  readonly locator: PaneFindIdentityValue;
}): PaneFindResultKey {
  // justify-type-assertion: this sole constructor encodes both the frozen
  // source and logical locator canonically before applying the opaque brand.
  return canonicalIdentityJson(input) as PaneFindResultKey;
}

function areScopeControlsEqual(
  left: PaneFindScopeControl,
  right: PaneFindScopeControl,
): boolean {
  if (left === right) return true;
  if (left.kind !== right.kind) return false;
  return (
    left.kind === "EntireResource" ||
    (right.kind === "Selectable" &&
      left.selectedId === right.selectedId &&
      left.options === right.options &&
      left.onChange === right.onChange)
  );
}

function arePaneSearchBasesEqual(
  left: PaneSearchBase,
  right: PaneSearchBase,
): boolean {
  return (
    left.query === right.query &&
    left.inputLabel === right.inputLabel &&
    left.placeholder === right.placeholder &&
    left.onQueryChange === right.onQueryChange &&
    left.onDismiss === right.onDismiss
  );
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
  }
}

export function arePaneSearchPublicationsEqual(
  left: PaneSearchPublication | undefined,
  right: PaneSearchPublication | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right || left.kind !== right.kind) return false;
  if (!arePaneSearchBasesEqual(left, right)) return false;
  if (left.kind === "FilterRows") {
    return (
      right.kind === "FilterRows" &&
      areFilterRowsStatusesEqual(left.rowStatus, right.rowStatus) &&
      left.activeDomainControlCount === right.activeDomainControlCount &&
      left.filters === right.filters &&
      left.controls === right.controls
    );
  }
  if (right.kind !== "FindOccurrences") return false;
  if (
    left.result !== right.result ||
    !areScopeControlsEqual(left.scope, right.scope) ||
    left.matchCase !== right.matchCase ||
    left.wholeWord !== right.wholeWord ||
    left.onMatchCaseChange !== right.onMatchCaseChange ||
    left.onWholeWordChange !== right.onWholeWordChange ||
    left.onStep !== right.onStep ||
    left.onActivate !== right.onActivate ||
    left.onShowResults !== right.onShowResults ||
    left.resultsExpanded !== right.resultsExpanded ||
    left.returnToReadingPosition.kind !==
      right.returnToReadingPosition.kind
  ) {
    return false;
  }
  return (
    left.returnToReadingPosition.kind === "Unavailable" ||
    (right.returnToReadingPosition.kind === "Available" &&
      left.returnToReadingPosition.onReturn ===
        right.returnToReadingPosition.onReturn)
  );
}
