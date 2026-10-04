/**
 * Canonical collection row view-model. Per-kind presenters own semantic
 * projection; CollectionRow owns formatting and visual hierarchy.
 */

import type { ResourceRowPrimary } from "@/components/ui/ResourceActivation";
import type { LocalAvailability } from "@/lib/offlineMedia/contract";
import type { EmphasisSegment } from "@/lib/ui/emphasis";
import type { Presence } from "@/lib/api/presence";
import type { ContributorCredit } from "@/lib/contributors/types";
import type { PodcastSyncStatus } from "@/lib/podcasts/types";
import type { ResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import type { PublicationDate } from "@/lib/dates/publicationDate";
import type { MediaDuration } from "@/lib/media/mediaSummary";
import type { PositiveCount } from "@/lib/consumption/activityFacts";

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
  | { readonly kind: "MediaDuration"; readonly duration: MediaDuration }
  | {
      readonly kind: "Unplayed";
      readonly count: PositiveCount;
    }
  | {
      readonly kind: "PodcastSync";
      readonly status: Extract<PodcastSyncStatus, "Pending" | "Running">;
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
      readonly status: Extract<PodcastSyncStatus, "Failed">;
    };

export interface CollectionRowView {
  readonly id: string;
  readonly kind: CollectionItemKind;
  /** The common stored-media layout also applies when duration is unknown. */
  readonly mediaIdentity?: true;
  readonly primary: ResourceRowPrimary;
  readonly title: {
    readonly text: string;
    readonly segments?: readonly EmphasisSegment[];
  };
  readonly contributors: readonly ContributorCredit[];
  readonly publicationDate: Presence<PublicationDate>;
  readonly context: Presence<CollectionContext>;
  readonly activity: Presence<CollectionActivity>;
  readonly exceptionalStatus: Presence<ExceptionalStatus>;
  readonly localAvailability: Presence<LocalAvailability>;
  /**
   * The canonical resource suffix for this row's one contextual More menu.
   * `null` means a non-resource row, which may contribute only `flatActions`.
   */
  readonly actionSubject: ResourceActionSubject | null;
  /**
   * Non-resource actions appended after row occurrence commands. These apply
   * only when `actionSubject` is `null`; a resource row's canonical suffix is
   * supplied by the resource-action runtime.
   */
  readonly flatActions?: readonly ActionDescriptor[];
  readonly selected: boolean;
}
