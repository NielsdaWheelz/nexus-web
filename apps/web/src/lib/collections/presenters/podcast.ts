/** One podcast row. Null facts publish metadata only; the containing card owns its scoped controls. */

import type { PodcastActionSubject } from "@/lib/actions/inlineActions";
import type { Schema } from "@/lib/api/wire";
import type { CollectionRowView, PositiveCount } from "@/lib/collections/types";
import type { ContributorCredit } from "@/lib/contributors/credits";
import { canonicalResourceRef } from "@/lib/sharing/targets";

export interface PodcastPresenterItem {
  readonly facts: PodcastActionSubject["facts"] | null;
  readonly id: string;
  readonly title: string;
  readonly imageUrl: string | null;
  readonly contributors: readonly ContributorCredit[];
  readonly unplayedCount: PositiveCount | null;
  readonly recurring: Schema<"PodcastRecurringOut"> | null;
}

export function presentPodcast(item: PodcastPresenterItem): CollectionRowView {
  const sync = item.recurring;
  return {
    presentation: "Index",
    id: item.id,
    kind: "podcast",
    ...(item.facts === null ? {} : { resourceActions: { kind: "Podcast" as const, subject: { target: { kind: "Canonical" as const, podcast_id: item.id }, title: item.title, facts: item.facts } } }),
    primary: {
      kind: "link",
      href: `/podcasts/${item.id}`,
      paneLabelHint: item.title,
    },
    title: { text: item.title },
    artwork: { imageUrl: item.imageUrl },
    contributors: item.contributors,
    publicationDate: null,
    context: null,
    activity: sync?.state === "pending" || sync?.state === "running"
      ? { kind: "PodcastSync", status: sync.state }
      : item.unplayedCount !== null ? { kind: "Unplayed", count: item.unplayedCount } : null,
    exceptionalStatus: sync?.error_code !== null && sync?.error_code !== undefined
      ? { kind: "PodcastSync", status: "failed" } : null,
    resourceRef: canonicalResourceRef({ scheme: "podcast", id: item.id }),
    selected: false,
  };
}
