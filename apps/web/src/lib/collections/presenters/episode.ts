/**
 * Episode presenter — pure data for one podcast-episode row, modeled on the
 * media presenter. Owns the view-model + the overflow ActionMenu only; the
 * pane keeps its own controls (transcript form, show-notes, queue). Pure data —
 * no React, no fetch.
 *
 * `ctx` carries everything `episodeResourceOptions` needs except the subject
 * and its played state — both derived here from `item`.
 */

import { CircleCheck, Trash2 } from "lucide-react";
import { episodeResourceOptions } from "@/lib/actions/resourceActions";
import { connectionsFromSummary } from "@/lib/collections/connectionSummary";
import type { CollectionRowView, ReadStatus, SignalFact } from "@/lib/collections/types";
import type { ContributorCredit } from "@/lib/contributors/types";
import type { ConnectionSummaryOut } from "@/lib/resourceGraph/connections";
import { mediaKindIcon } from "@/lib/resources/resourceKind";
import { mediaProcessingStatusPill, type MediaProcessingStatus } from "@/lib/status/mediaProcessing";

export interface EpisodePresenterItem {
  id: string;
  title: string;
  kind: string;
  processing_status: MediaProcessingStatus;
  episode_state: "unplayed" | "in_progress" | "played";
  canonical_source_url: string | null;
  contributors?: ContributorCredit[];
  capabilities?: unknown;
  published_date?: string | null;
  listening_state?: { position_ms: number; duration_ms: number | null } | null;
}

export type EpisodePresenterContext = Omit<
  Parameters<typeof episodeResourceOptions>[0],
  "media" | "played"
> & {
  connectionSummary?: ConnectionSummaryOut;
};

function deriveConsumption(item: EpisodePresenterItem): { status: ReadStatus; fraction?: number } {
  const fraction = listenedFraction(item.listening_state);
  switch (item.episode_state) {
    case "unplayed":
      return { status: "unread" };
    case "in_progress":
      return fraction === undefined
        ? { status: "in_progress" }
        : { status: "in_progress", fraction };
    case "played":
      return { status: "finished" };
    default: {
      const _exhaustive: never = item.episode_state;
      return { status: "unread" };
    }
  }
}

function listenedFraction(
  listeningState: EpisodePresenterItem["listening_state"],
): number | undefined {
  if (!listeningState || listeningState.duration_ms == null || listeningState.duration_ms <= 0) {
    return undefined;
  }
  return Math.max(0, Math.min(1, listeningState.position_ms / listeningState.duration_ms));
}

export function presentEpisode(
  item: EpisodePresenterItem,
  ctx: EpisodePresenterContext,
): CollectionRowView {
  const { connectionSummary, ...actionCtx } = ctx;
  const signals: SignalFact[] = [];
  if (item.published_date) signals.push({ value: item.published_date });
  const actions = episodeResourceOptions({
    media: item,
    played: item.episode_state === "played",
    ...actionCtx,
  });
  const deleteAction = actions.find(
    (action) => action.id === "delete-media" && !action.disabled && action.onSelect,
  );
  const togglePlayedAction = actions.find(
    (action) => action.id === "toggle-episode-played" && !action.disabled && action.onSelect,
  );
  const swipeAction = deleteAction ?? togglePlayedAction;

  return {
    id: item.id,
    kind: "podcast_episode",
    primary: {
      kind: "link",
      href: `/media/${item.id}`,
      paneLabelHint: item.title,
      viewTransition: "media-reader",
    },
    lead: { icon: mediaKindIcon(item.kind) },
    headline: { text: item.title },
    signals,
    consumption: deriveConsumption(item),
    status: mediaProcessingStatusPill(item.processing_status) ?? undefined,
    connections: connectionsFromSummary(connectionSummary),
    contributors:
      item.contributors && item.contributors.length > 0
        ? { credits: item.contributors, maxVisible: 3 }
        : undefined,
    actions,
    swipeActions: swipeAction
      ? [
          {
            id: swipeAction.id,
            label: swipeAction.label,
            icon: swipeAction.id === "delete-media" ? Trash2 : CircleCheck,
            tone: swipeAction.tone,
            onActivate: () => swipeAction.onSelect?.({ triggerEl: null }),
          },
        ]
      : undefined,
  };
}
