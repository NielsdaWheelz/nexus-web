/**
 * Canonical collection row view-model. Per-kind presenters own semantic
 * projection; CollectionRow owns formatting and visual hierarchy.
 */

import type { ResourceRowPrimary } from "@/components/ui/ResourceRow";
import type { EmphasisSegment } from "@/lib/ui/emphasis";
import type { ContributorCredit } from "@/lib/contributors/credits";
import type { CanonicalResourceRef } from "@/lib/sharing/types";
import type { Schema } from "@/lib/api/wire";
import type { MetadataSubject } from "@/lib/actions/subjects";
import type { ResourceActionSubject } from "@/lib/actions/inlineActions";
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
      }
    | { readonly kind: "Sorted" | "Filtered" | "Incomplete" | "Refreshing" };
}

export type CollectionItemKind =
  | "media"
  | "podcast"
  | "feed"
  | "podcast_episode"
  | "library"
  | "contributor_work"
  | "note"
  | "search_result"
  | "settings_row";

export type CollectionActivity =
  | { readonly kind: "RemainingTime"; readonly modality: "Read" | "Listen"; readonly minutes: number }
  | {
      readonly kind: "FeedSync";
      readonly feedKind: "podcast" | "article";
      readonly status: Extract<Schema<"FeedRecurringOut">["state"], "pending" | "running">;
    };

export type CollectionContext =
  | { readonly kind: "Text"; readonly text: string }
  | { readonly kind: "Snippet"; readonly segments: readonly EmphasisSegment[] };

export type ExceptionalStatus = {
  readonly kind: "FeedSync";
  readonly feedKind: "podcast" | "article";
  readonly status: "failed";
};

interface CollectionRowBase {
  readonly id: string;
  readonly presentation: "Index" | "Details";
  readonly primary: ResourceRowPrimary;
  readonly title: {
    readonly text: string;
    readonly segments?: readonly EmphasisSegment[];
  };
  readonly contributors: readonly ContributorCredit[];
  readonly publicationDate: string | null;
  readonly context: CollectionContext | null;
  readonly activity: Extract<CollectionActivity, { kind: "FeedSync" }> | null;
  readonly exceptionalStatus: ExceptionalStatus | null;
  /**
   * The displayed resource's canonical identity and contextual More menu subject.
   * Presenters guarantee both identities coincide; `kind` is collection behavior,
   * not resource type (a `note` collection item can display a `page:` resource).
   * `null` means a non-resource row.
   */
  readonly resourceRef: CanonicalResourceRef | null;
  readonly selected: boolean;
  readonly resourceActions?: ResourceActionSubject;
  readonly podcastMetadata?: Extract<MetadataSubject, { kind: "DiscoveryPodcast" | "DiscoveryPodcastPreview" }>;
}

export type CollectionRowView = CollectionRowBase & (
  | {
      readonly kind: "podcast" | "feed";
      /** omission reserves no column; a null source still presents an initials tile. */
      readonly artwork?: { readonly imageUrl: string | null };
    }
  | { readonly kind: Exclude<CollectionItemKind, "podcast" | "feed">; readonly artwork?: never }
);
