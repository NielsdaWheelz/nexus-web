/** Pure semantic projection for one Library media row. */

import { absent, present, type Presence } from "@/lib/api/presence";
import { canonicalResourceRef } from "@/lib/sharing/targets";
import {
  readActivity,
  type ReadActivityTime,
  type ReadStateFields,
} from "@/lib/collections/readState";
import type {
  CollectionRowView,
  ConsumptionModality,
} from "@/lib/collections/types";
import type { PublicationDate } from "@/lib/dates/publicationDate";
import type { ContributorCredit } from "@/lib/contributors/types";
import {
  exceptionalStatus,
  type MediaProcessingStatus,
} from "@/lib/status/mediaProcessing";
import type { MediaKind } from "@/lib/media/kind";
import type { ReadingTimeEstimatePresence } from "@/lib/libraries/readingTime";

export interface MediaPresenterItem extends ReadStateFields {
  id: string;
  kind: MediaKind;
  title: string;
  canonical_source_url: string | null;
  processing_status: MediaProcessingStatus;
  publicationDate: Presence<PublicationDate>;
  sourceHost: Presence<string>;
  contributors: ContributorCredit[];
  capabilities: {
    can_quote: boolean;
    can_delete?: boolean;
    can_retry?: boolean;
    can_refresh_source?: boolean;
    can_retry_metadata?: boolean;
    can_edit_authors?: boolean;
  };
}

export interface MediaPresenterContext {
  readonly readingTimeEstimate: ReadingTimeEstimatePresence;
}

function modalityFor(kind: MediaKind): ConsumptionModality {
  if (kind === "podcast_episode") return "Listen";
  if (kind === "video") return "Watch";
  return "Read";
}

function readingTime(
  estimate: ReadingTimeEstimatePresence,
): ReadActivityTime {
  if (estimate.kind === "Absent") {
    return { totalMinutes: absent(), remainingMinutes: absent() };
  }
  return {
    totalMinutes: present(estimate.value.totalMinutes),
    remainingMinutes: estimate.value.remainingMinutes,
  };
}

function webSourceContext(item: MediaPresenterItem): CollectionRowView["context"] {
  return item.sourceHost.kind === "Present"
    ? present({ kind: "Text", text: item.sourceHost.value })
    : absent();
}

export function presentMedia(
  item: MediaPresenterItem,
  ctx: MediaPresenterContext,
): CollectionRowView {
  const { readingTimeEstimate } = ctx;
  const href = `/media/${item.id}`;

  return {
    id: item.id,
    kind: "media",
    primary: {
      kind: "link",
      href,
      paneLabelHint: item.title,
      viewTransition: "media-reader",
    },
    title: { text: item.title },
    contributors: item.contributors,
    publicationDate: item.publicationDate,
    context: webSourceContext(item),
    activity: readActivity(
      item,
      modalityFor(item.kind),
      readingTime(readingTimeEstimate),
    ),
    exceptionalStatus: exceptionalStatus(item.processing_status),
    localAvailability: absent(),
    relatedMediaId: present(item.id),
    actionSubject: {
      ref: canonicalResourceRef({ scheme: "media", id: item.id }),
    },
    selected: false,
  };
}
