/**
 * Canonical collection row view-model. Per-kind presenters own semantic
 * projection; CollectionRow owns formatting and visual hierarchy.
 */

import type { ResourceRowPrimary } from "@/components/ui/ResourceRow";
import type { Presence } from "@/lib/api/presence";
import type { ContributorCredit } from "@/lib/contributors/types";
import type {
  ConnectionEndpointOut,
  EdgeKind,
} from "@/lib/resourceGraph/connections";
import type { MediaProcessingStatus } from "@/lib/status/mediaProcessing";
import type { PodcastSyncStatus } from "@/lib/status/podcastSync";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import type { PublicationDate } from "@/lib/dates/publicationDate";
import type {
  PositiveCount,
  PositiveMinutes,
  ProgressFraction,
} from "@/lib/consumption/activityFacts";

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

export interface EmphasisSegment {
  readonly text: string;
  readonly emphasized: boolean;
}

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
      readonly status: Exclude<PodcastSyncStatus, "complete">;
    };

export interface ConnectionSummaryView {
  readonly total: number;
  readonly dominantKind: Presence<EdgeKind>;
  readonly topPeers: readonly ConnectionEndpointOut[];
}

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
  readonly connections: Presence<ConnectionSummaryView>;
  readonly relatedMediaId: Presence<string>;
  readonly actions: readonly ActionDescriptor[];
  readonly selected: boolean;
}
