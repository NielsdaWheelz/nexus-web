/** Pure semantic projection for one Library media row. */

import { absent, present, type Presence } from "@/lib/api/presence";
import { mediaResourceOptions } from "@/lib/actions/resourceActions";
import { connectionsFromSummary } from "@/lib/collections/connectionSummary";
import {
  readActivity,
  type ReadActivityTime,
  type ReadStateFields,
} from "@/lib/collections/readState";
import type {
  CollectionRowView,
  ConsumptionModality,
  ExceptionalStatus,
} from "@/lib/collections/types";
import type { PublicationDate } from "@/lib/dates/publicationDate";
import type { ContributorCredit } from "@/lib/contributors/types";
import type { ConnectionSummaryOut } from "@/lib/resourceGraph/connections";
import type { MediaProcessingStatus } from "@/lib/status/mediaProcessing";
import type {
  LibraryMediaKind,
  ReadingTimeEstimatePresence,
} from "@/lib/libraries/readingTime";

export interface MediaPresenterItem extends ReadStateFields {
  id: string;
  kind: LibraryMediaKind;
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
  };
}

export type MediaPresenterContext = Omit<
  Parameters<typeof mediaResourceOptions>[0],
  "media" | "readState"
> & {
  connectionSummary?: ConnectionSummaryOut;
  readingTimeEstimate: ReadingTimeEstimatePresence;
};

function modalityFor(kind: LibraryMediaKind): ConsumptionModality {
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

function exceptionalStatus(
  status: MediaProcessingStatus,
): Presence<ExceptionalStatus> {
  return status === "ready_for_reading"
    ? absent()
    : present({ kind: "MediaProcessing", status });
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
  const { connectionSummary, readingTimeEstimate, ...actionCtx } = ctx;
  const actions = mediaResourceOptions({
    media: item,
    readState: item.read_state,
    ...actionCtx,
  });

  return {
    id: item.id,
    kind: "media",
    primary: {
      kind: "link",
      href: `/media/${item.id}`,
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
    connections: connectionsFromSummary(connectionSummary),
    relatedMediaId: present(item.id),
    actions,
    selected: false,
  };
}
