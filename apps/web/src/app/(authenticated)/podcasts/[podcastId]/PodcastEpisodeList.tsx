"use client";

import type { ReactNode } from "react";
import {
  FeedbackNotice,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import ActionMenu from "@/components/ui/ActionMenu";
import Button from "@/components/ui/Button";
import CollectionView from "@/components/collections/CollectionView";
import type { ExhaustionState } from "@/lib/api/useExhaustivePagination";
import { presentMedia } from "@/lib/collections/presenters/media";
import type { EpisodeStateFilter } from "@/lib/podcasts/episodeView";
import { canonicalResourceRef } from "@/lib/sharing/targets";
import { useStringIdSet } from "@/lib/useStringIdSet";
import EpisodeControls from "./EpisodeControls";
import {
  EPISODE_WIDE_COMMAND_LABELS,
  shouldPollTranscriptProvisioningForEpisode,
  type PodcastEpisodeMedia,
} from "./episodeTranscript";
import type { useEpisodeTranscriptController } from "./useEpisodeTranscriptController";
import styles from "./page.module.css";

type EpisodeTranscriptController = ReturnType<
  typeof useEpisodeTranscriptController
>;

type StringIdSet = ReturnType<typeof useStringIdSet>;

interface PodcastEpisodeListProps {
  episodes: PodcastEpisodeMedia[];
  filterQuery: string;
  loading: boolean;
  error: FeedbackContent | null;
  episodeStateFilter: EpisodeStateFilter;
  transcript: EpisodeTranscriptController;
  expandedShowNotesMediaIds: StringIdSet;
  matchingEpisodeCount: number;
  markAllAsPlayedBusy: boolean;
  collectionBusy: boolean;
  exhaustion: ExhaustionState;
  notice?: ReactNode;
  footer?: ReactNode;
  onMarkAllAsPlayed: () => void;
  onToggleShowNotes: (mediaId: string) => void;
}

export default function PodcastEpisodeList({
  episodes,
  filterQuery,
  loading,
  error,
  episodeStateFilter,
  transcript,
  expandedShowNotesMediaIds,
  matchingEpisodeCount,
  markAllAsPlayedBusy,
  collectionBusy,
  exhaustion,
  notice,
  footer,
  onMarkAllAsPlayed,
  onToggleShowNotes,
}: PodcastEpisodeListProps) {
  const localFilterActive = filterQuery.trim().length > 0;
  const commandLabels = EPISODE_WIDE_COMMAND_LABELS[episodeStateFilter];
  const localFilterDisabledReason = "Clear Filter to use episode-wide actions";
  const rows = episodes.map((episode) =>
    presentMedia(episode.mediaSummary, {
      id: episode.id,
      primary: { kind: "link", href: `/media/${episode.id}` },
      actionSubject: { ref: canonicalResourceRef({ scheme: "media", id: episode.id }) },
      selected: false,
    }),
  );

  // Show notes changes only this occurrence's disclosure. Every standing
  // episode action stays in CollectionRow's canonical contextual More menu.
  const episodeViewControls = episodes.reduce<Record<string, ReactNode>>(
    (controls, episode) => {
      const panelId = `episode-panel-${episode.id}`;
      const showNotesExpanded = expandedShowNotesMediaIds.ids.has(episode.id);
      if (episode.has_show_notes) {
        controls[episode.id] = (
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={showNotesExpanded}
            aria-controls={panelId}
            onClick={() => onToggleShowNotes(episode.id)}
          >
            {showNotesExpanded ? "Hide notes" : "Show notes"}
          </Button>
        );
      }
      return controls;
    },
    {},
  );

  const rowPanels = episodes.reduce<Record<string, ReactNode>>(
    (panels, episode) => {
      const showNotesExpanded = expandedShowNotesMediaIds.ids.has(episode.id);
      const transcriptPanelExpanded =
        transcript.expandedTranscriptMediaIds.ids.has(episode.id);
      const transcriptInFlight =
        transcript.requestingTranscriptMediaIds.ids.has(episode.id) ||
        shouldPollTranscriptProvisioningForEpisode(episode);
      if (
        !showNotesExpanded &&
        !transcriptPanelExpanded &&
        !transcriptInFlight
      ) {
        return panels;
      }
      panels[episode.id] = (
        <EpisodeControls
          episode={episode}
          showNotesExpanded={showNotesExpanded}
          transcript={transcript}
        />
      );
      return panels;
    },
    {},
  );

  return (
    <div className={styles.episodePaneContent}>
      <div className={styles.episodePaneHeaderRow}>
        <ActionMenu
          label="Episode actions"
          options={[
            {
              kind: "command",
              id: "transcribe-episodes",
              label: transcript.batchTranscriptBusy
                ? "Transcribing..."
                : commandLabels.transcript,
              disabled:
                localFilterActive ||
                transcript.batchTranscriptBusy ||
                matchingEpisodeCount === 0,
              disabledReason: localFilterActive
                ? localFilterDisabledReason
                : undefined,
              onSelect: () => {
                if (
                  localFilterActive ||
                  transcript.batchTranscriptBusy ||
                  matchingEpisodeCount === 0
                ) {
                  return;
                }
                void transcript.handleBatchTranscriptRequest();
              },
            },
            {
              kind: "command",
              id: "mark-all-played",
              label: markAllAsPlayedBusy
                ? "Marking..."
                : commandLabels.markPlayed,
              disabled:
                localFilterActive ||
                markAllAsPlayedBusy ||
                matchingEpisodeCount === 0 ||
                episodeStateFilter === "played",
              disabledReason: localFilterActive
                ? localFilterDisabledReason
                : episodeStateFilter === "played"
                  ? "Every episode in this state is already played."
                  : undefined,
              onSelect: () => {
                if (
                  localFilterActive ||
                  markAllAsPlayedBusy ||
                  matchingEpisodeCount === 0 ||
                  episodeStateFilter === "played"
                ) {
                  return;
                }
                onMarkAllAsPlayed();
              },
            },
          ]}
        />
      </div>

      {transcript.batchTranscriptSummary && (
        <p className={styles.batchTranscriptSummary}>
          {transcript.batchTranscriptSummary}
        </p>
      )}

      <CollectionView
        returnScope="PodcastDetail.Episodes"
        rows={rows}
        status="ready"
        collectionBusy={collectionBusy}
        notice={notice}
        footer={footer}
        ariaLabel="Episodes"
        rowPanels={rowPanels}
        rowControls={episodeViewControls}
        empty={
          !error && (localFilterActive || !loading) ? (
            <FeedbackNotice
              content={{
                tone: "Neutral",
                title: localFilterActive
                  ? !loading && exhaustion.kind === "Complete"
                    ? "No episodes match this filter."
                    : "No matching episode found so far."
                  : "No episodes found for this podcast.",
              }}
              announcement="None"
            />
          ) : null
        }
        rowChangePresentation={{
          kind: "ImmediateOnKeyChange",
          key: filterQuery.trim(),
        }}
      />
    </div>
  );
}
