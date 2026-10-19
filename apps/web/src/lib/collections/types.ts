/**
 * Canonical collection row view-model. Per-kind presenters own semantic
 * projection; CollectionRow owns formatting and visual hierarchy.
 */

import type { ResourceRowPrimary } from "@/components/ui/ResourceRow";
import type { EmphasisSegment } from "@/lib/ui/emphasis";
import type { ContributorCredit } from "@/lib/contributors/credits";
import type { CanonicalResourceRef } from "@/lib/sharing/types";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import type { Schema } from "@/lib/api/wire";
import type { Move, MoveOutcome, OrderRevision } from "./order";

/** A complete manual-order scope. Its owner alone commits and reconciles moves. */
export interface OrderPresentation {
  readonly scopeKey: string;
  readonly state:
    | {
        readonly kind: "Ready";
        readonly revision: OrderRevision;
        readonly move: (command: Move) => Promise<MoveOutcome>;
      }
    | {
        readonly kind: "Saving" | "Checking" | "Unconfirmed";
        readonly controls: "Visible" | "Hidden";
      }
    | { readonly kind: "Sorted" | "Filtered" | "Incomplete" | "Refreshing" };
}

/** Source-decoder or source-owned derivation guarantee: integer >= 1. */
export interface PositiveCount {
  readonly value: number;
}

export type CollectionItemKind =
  | "media"
  | "podcast"
  | "podcast_episode"
  | "library"
  | "contributor_work"
  | "note"
  | "conversation"
  | "search_result"
  | "settings_row";

export type CollectionActivity =
  | { readonly kind: "RemainingTime"; readonly modality: "Read" | "Listen"; readonly minutes: number }
  | {
      readonly kind: "Unplayed";
      readonly count: PositiveCount;
    }
  | {
      readonly kind: "PodcastSync";
      readonly status: Extract<Schema<"PodcastSyncStatus">, "Pending" | "Running">;
    };

export type CollectionContext =
  | { readonly kind: "Text"; readonly text: string }
  | { readonly kind: "Snippet"; readonly segments: readonly EmphasisSegment[] };

export type ExceptionalStatus =
  | {
      readonly kind: "MediaProcessing";
      readonly status: "failed";
    }
  | {
      readonly kind: "PodcastSync";
      readonly status: Extract<Schema<"PodcastSyncStatus">, "Failed">;
    };

interface CollectionRowBase {
  readonly id: string;
  readonly kind: CollectionItemKind;
  readonly primary: ResourceRowPrimary;
  readonly title: {
    readonly text: string;
    readonly segments?: readonly EmphasisSegment[];
  };
  readonly contributors: readonly ContributorCredit[];
  readonly publicationDate: string | null;
  readonly context: CollectionContext | null;
  readonly activity: CollectionActivity | null;
  readonly exceptionalStatus: ExceptionalStatus | null;
  /**
   * The canonical resource suffix for this row's one contextual More menu.
   * `null` means a non-resource row, which may contribute only `flatActions`.
   */
  readonly resourceRef: CanonicalResourceRef | null;
  /** The visible resource and explicit insertion capability; never the action owner. */
  readonly insertionSource: import("@/lib/resourceGraph/links").InsertionSource | null;
  /**
   * Non-resource actions appended after row occurrence commands. These apply
   * only when `resourceRef` is `null`; a resource row's canonical suffix is
   * supplied by the resource-action runtime.
   */
  readonly flatActions?: readonly ActionDescriptor[];
  readonly selected: boolean;
}

export type CollectionRowView = CollectionRowBase & (
  | { readonly mediaIdentity: "Stored"; readonly consumption: Schema<"ConsumptionOut"> }
  | { readonly mediaIdentity: "External"; readonly consumption?: never }
  | { readonly mediaIdentity?: never; readonly consumption?: never }
);
