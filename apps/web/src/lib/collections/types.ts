/**
 * Canonical collection row view-model. Per-kind presenters own semantic
 * projection; CollectionRow owns formatting and visual hierarchy.
 */

import type { ResourceRowPrimary } from "@/components/ui/ResourceRow";
import type { LocalAvailability } from "@/lib/offlineMedia/contract";
import type { EmphasisSegment } from "@/lib/ui/emphasis";
import type { Presence } from "@/lib/api/presence";
import type { ContributorCredit } from "@/lib/contributors/types";
import type { MediaProcessingStatus } from "@/lib/status/mediaProcessing";
import type { PodcastSyncStatus } from "@/lib/podcasts/types";
import type { ResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import type { PublicationDate } from "@/lib/dates/publicationDate";
import type {
  PositiveCount,
  PositiveMinutes,
  ProgressFraction,
} from "@/lib/consumption/activityFacts";

export type { ResourceRowPrimary };

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

export type ConsumptionModality = "Read" | "Listen" | "Watch";

export type InProgressActivity =
  | {
      readonly kind: "InProgress";
      readonly modality: ConsumptionModality;
      readonly fraction: { readonly kind: "Present"; readonly value: ProgressFraction };
      readonly remainingMinutes: Presence<PositiveMinutes>;
    }
  | {
      readonly kind: "InProgress";
      readonly modality: ConsumptionModality;
      readonly fraction: { readonly kind: "Absent" };
      readonly remainingMinutes: {
        readonly kind: "Present";
        readonly value: PositiveMinutes;
      };
    };

export type CollectionActivity =
  | {
      readonly kind: "Unread";
      readonly modality: ConsumptionModality;
      readonly totalMinutes: Presence<PositiveMinutes>;
    }
  | InProgressActivity
  | {
      readonly kind: "Finished";
      readonly modality: ConsumptionModality;
    }
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
      readonly status: Exclude<MediaProcessingStatus, "ready_for_reading">;
    }
  | {
      readonly kind: "PodcastSync";
      readonly status: Extract<PodcastSyncStatus, "Failed">;
    };

export interface CollectionRowView {
  readonly id: string;
  readonly kind: CollectionItemKind;
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
  readonly relatedMediaId: Presence<string>;
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
