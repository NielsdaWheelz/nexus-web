/**
 * Podcast presenter — mirrors the media template. Pure data: it owns the decision
 * of what earns weight for a followed-podcast row. No React, no fetch.
 *
 * Calm by intent: a podcast leads with its unplayed count (the one fact worth
 * scanning for), optionally trails the latest-episode date, and surfaces sync
 * only when it is noteworthy. The old row's playback-speed / auto-queue /
 * per-library badges are deliberately dropped here.
 *
 * `ctx` carries everything `podcastResourceOptions` needs — the pane supplies the
 * callbacks + capability flag + busy state.
 *
 * NOTE on shape: this is the structural subset of `PodcastSubscriptionListItem`
 * the presenter reads. The list DTO nests `title` / `image_url` / `contributors`
 * under a `podcast` summary and keys the row by `podcast_id`; this item mirrors
 * that nesting rather than flattening it.
 */

import { BellOff } from "lucide-react";
import { podcastResourceOptions } from "@/lib/actions/resourceActions";
import { connectionsFromSummary } from "@/lib/collections/connectionSummary";
import type { CollectionRowView, SignalFact } from "@/lib/collections/types";
import type { ContributorCredit } from "@/lib/contributors/types";
import type { ConnectionSummaryOut } from "@/lib/resourceGraph/connections";
import { resourceIconForScheme } from "@/lib/resources/resourceKind";
import { podcastSyncStatusPill, type PodcastSyncStatus } from "@/lib/status/podcastSync";
import { pluralize } from "@/lib/text/pluralize";

export interface PodcastPresenterItem {
  id: string;
  title: string;
  image_url: string | null;
  contributors: ContributorCredit[];
  unplayed_count: number;
  sync_status: PodcastSyncStatus;
  latest_episode_published_at?: string | null;
}

export type PodcastPresenterContext = Parameters<typeof podcastResourceOptions>[0] & {
  connectionSummary?: ConnectionSummaryOut;
};

export function presentPodcast(
  item: PodcastPresenterItem,
  ctx: PodcastPresenterContext,
): CollectionRowView {
  const { connectionSummary, ...actionCtx } = ctx;
  const status = podcastSyncStatusPill(item.sync_status);
  const actions = podcastResourceOptions(actionCtx);
  const unsubscribeAction = actions.find(
    (action) => action.id === "unsubscribe-podcast" && !action.disabled && action.onSelect,
  );

  const signals: SignalFact[] = [];
  if (item.unplayed_count > 0) {
    signals.push({ value: pluralize(item.unplayed_count, "unplayed episode") });
  }

  return {
    id: item.id,
    kind: "podcast",
    primary: { kind: "link", href: `/podcasts/${item.id}`, paneTitleHint: item.title },
    lead: { icon: resourceIconForScheme("podcast"), remoteUrl: item.image_url ?? undefined },
    headline: { text: item.title },
    signals,
    status: status ?? undefined,
    connections: connectionsFromSummary(connectionSummary),
    recency: item.latest_episode_published_at
      ? { at: item.latest_episode_published_at, reason: "published" }
      : undefined,
    contributors:
      item.contributors && item.contributors.length > 0
        ? { credits: item.contributors, maxVisible: 3 }
        : undefined,
    actions,
    swipeActions: unsubscribeAction
      ? [
          {
            id: unsubscribeAction.id,
            label: unsubscribeAction.label,
            icon: BellOff,
            tone: "danger",
            onActivate: () => unsubscribeAction.onSelect?.({ triggerEl: null }),
          },
        ]
      : undefined,
  };
}
