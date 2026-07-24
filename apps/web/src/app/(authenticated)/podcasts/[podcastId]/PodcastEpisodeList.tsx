"use client";

import { useMemo, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { FeedbackNotice, type FeedbackContent } from "@/components/feedback/Feedback";
import ActionMenu from "@/components/ui/ActionMenu";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import Select from "@/components/ui/Select";
import CollectionView from "@/components/collections/CollectionView";
import { presentEpisode } from "@/lib/collections/presenters/episode";
import { useConnectionSummaries } from "@/lib/collections/useConnectionSummaries";
import { requireDocumentProcessingStatus } from "@/lib/media/documentReadiness";
import { useStringIdSet } from "@/lib/useStringIdSet";
import EpisodeControls from "./EpisodeControls";
import {
  deriveEpisodeState,
  decodeEpisodeTimingFacts,
  decodeEpisodePublicationDate,
  episodePlayerDescriptor,
  canRequestTranscriptForEpisode,
  shouldPollTranscriptProvisioningForEpisode,
  type EpisodeSort,
  type EpisodeStateFilter,
  type PodcastEpisodeMedia,
} from "./episodeTranscript";
import type { useEpisodeTranscriptController } from "./useEpisodeTranscriptController";
import styles from "./page.module.css";
import { usePaneRuntime } from "@/lib/panes/paneRuntime";
import { useShareController } from "@/lib/sharing/controller";
import { paneShareOpenOptions } from "@/lib/sharing/openOptions";
import { resourceShareTarget } from "@/lib/sharing/targets";

type EpisodeTranscriptController = ReturnType<
  typeof useEpisodeTranscriptController
>;

type StringIdSet = ReturnType<typeof useStringIdSet>;

interface PodcastEpisodeListProps {
  episodes: PodcastEpisodeMedia[];
  loading: boolean;
  error: FeedbackContent | null;
  episodeStateFilter: EpisodeStateFilter;
  setEpisodeStateFilter: (filter: EpisodeStateFilter) => void;
  episodeSort: EpisodeSort;
  setEpisodeSort: (sort: EpisodeSort) => void;
  episodeSearchInput: string;
  setEpisodeSearchInput: Dispatch<SetStateAction<string>>;
  transcript: EpisodeTranscriptController;
  transcriptionAllowed: boolean;
  busyMediaIds: StringIdSet;
  markingEpisodeIds: StringIdSet;
  expandedShowNotesMediaIds: StringIdSet;
  lecternMediaIds: Set<string>;
  playNextDisabledMediaId: string | null;
  /** Whether the Lectern snapshot is Ready; its mutations defect until then. */
  lecternReady: boolean;
  visibleUnplayedEpisodeIds: string[];
  markAllAsPlayedBusy: boolean;
  hasMoreEpisodes: boolean;
  loadingMoreEpisodes: boolean;
  onMarkAllVisibleUnplayedAsPlayed: () => void;
  onLoadMoreEpisodes: () => void;
  onToggleShowNotes: (mediaId: string) => void;
  onPlayNext: (mediaId: string) => void;
  onAddToLectern: (mediaId: string) => void;
  onOpenChat: (episode: PodcastEpisodeMedia) => void;
  onRetry: (mediaId: string) => void;
  onRefreshSource: (mediaId: string) => void;
  onDelete: (episode: PodcastEpisodeMedia) => void;
  onTogglePlayed: (episode: PodcastEpisodeMedia, isCompleted: boolean) => void;
}

export default function PodcastEpisodeList({
  episodes,
  loading,
  error,
  episodeStateFilter,
  setEpisodeStateFilter,
  episodeSort,
  setEpisodeSort,
  episodeSearchInput,
  setEpisodeSearchInput,
  transcript,
  transcriptionAllowed,
  busyMediaIds,
  markingEpisodeIds,
  expandedShowNotesMediaIds,
  lecternMediaIds,
  playNextDisabledMediaId,
  lecternReady,
  visibleUnplayedEpisodeIds,
  markAllAsPlayedBusy,
  hasMoreEpisodes,
  loadingMoreEpisodes,
  onMarkAllVisibleUnplayedAsPlayed,
  onLoadMoreEpisodes,
  onToggleShowNotes,
  onPlayNext,
  onAddToLectern,
  onOpenChat,
  onRetry,
  onRefreshSource,
  onDelete,
  onTogglePlayed,
}: PodcastEpisodeListProps) {
  const paneRuntime = usePaneRuntime();
  const { openShare } = useShareController();
  const connectionSummaries = useConnectionSummaries(
    episodes.map((episode) => `media:${episode.id}`),
  );

  // A podcast-episode row is audio-playable when its decoded playerDescriptor is
  // Present (spec §4). That presence gates the Lectern placement affordances
  // ("Play next" / "Add to Lectern"); an Absent descriptor hides them.
  const audioEpisodeIds = useMemo(
    () =>
      new Set(
        episodes
          .filter(
            (episode) => episodePlayerDescriptor(episode).kind === "Present",
          )
          .map((episode) => episode.id),
      ),
    [episodes],
  );

  const rows = episodes.map((episode) => {
    const panelId = `episode-panel-${episode.id}`;
    const showNotesExpanded = expandedShowNotesMediaIds.ids.has(episode.id);
    const transcriptPanelExpanded =
      transcript.expandedTranscriptMediaIds.ids.has(episode.id);
    return presentEpisode(
      {
        id: episode.id,
        title: episode.title,
        kind: episode.kind,
        processing_status: requireDocumentProcessingStatus(
          episode.processing_status,
        ),
        episode_state: deriveEpisodeState(episode),
        canonical_source_url: episode.canonical_source_url,
        contributors: episode.contributors,
        capabilities: episode.capabilities,
        publicationDate: decodeEpisodePublicationDate(episode.published_date),
        activityFacts: decodeEpisodeTimingFacts(episode.listening_state),
      },
      {
        connectionSummary: connectionSummaries.get(`media:${episode.id}`),
        busy: busyMediaIds.ids.has(episode.id),
        retryBusy: busyMediaIds.ids.has(episode.id),
        refreshBusy: busyMediaIds.ids.has(episode.id),
        deleteBusy: busyMediaIds.ids.has(episode.id),
        markingBusy: markingEpisodeIds.ids.has(episode.id),
        episodePanelId: panelId,
        showNotesExpanded,
        onToggleShowNotes: episode.description_text?.trim()
          ? () => onToggleShowNotes(episode.id)
          : undefined,
        playNextDisabled:
          !lecternReady || episode.id === playNextDisabledMediaId,
        onPlayNext: audioEpisodeIds.has(episode.id)
          ? () => onPlayNext(episode.id)
          : undefined,
        transcriptPanelExpanded,
        onRequestTranscript:
          transcriptionAllowed && canRequestTranscriptForEpisode(episode)
            ? () => {
                if (transcriptPanelExpanded) {
                  transcript.expandedTranscriptMediaIds.remove(episode.id);
                } else {
                  transcript.expandedTranscriptMediaIds.add(episode.id);
                }
              }
            : undefined,
        onShare: ({ triggerEl }) =>
          openShare(
            resourceShareTarget(`media:${episode.id}`),
            paneShareOpenOptions(triggerEl, paneRuntime?.paneId ?? ""),
          ),
        onOpenChat: () => {
          onOpenChat(episode);
        },
        onRetry: episode.capabilities.can_retry
          ? () => {
              onRetry(episode.id);
            }
          : undefined,
        onRefreshSource: episode.capabilities.can_refresh_source
          ? () => {
              onRefreshSource(episode.id);
            }
          : undefined,
        onDelete: episode.capabilities.can_delete
          ? () => {
              onDelete(episode);
            }
          : undefined,
        onTogglePlayed: () => {
          onTogglePlayed(episode, deriveEpisodeState(episode) !== "played");
        },
        onAddToLectern:
          audioEpisodeIds.has(episode.id) &&
          lecternReady &&
          !lecternMediaIds.has(episode.id)
            ? () => {
                onAddToLectern(episode.id);
              }
            : undefined,
      },
    );
  });

  const rowPanels = episodes.reduce<Record<string, ReactNode>>(
    (panels, episode) => {
      const showNotesExpanded = expandedShowNotesMediaIds.ids.has(episode.id);
      const transcriptPanelExpanded =
        transcript.expandedTranscriptMediaIds.ids.has(episode.id);
      const transcriptInFlight =
        transcript.requestingTranscriptMediaIds.ids.has(episode.id) ||
        shouldPollTranscriptProvisioningForEpisode(episode);
      if (!showNotesExpanded && !transcriptPanelExpanded && !transcriptInFlight) {
        return panels;
      }
      panels[episode.id] = (
        <EpisodeControls
          episode={episode}
          showNotesExpanded={showNotesExpanded}
          transcript={transcript}
          transcriptionAllowed={transcriptionAllowed}
        />
      );
      return panels;
    },
    {},
  );

  return (
    <div className={styles.episodePaneContent}>
      <div className={styles.episodePaneHeaderRow}>
        <div className={styles.episodeHeaderActions}>
          <span>{episodes.length} episodes</span>
        </div>
        <ActionMenu
          label="Episode actions"
          options={[
            {
              kind: "command",
              id: "transcribe-unplayed",
              label: transcript.batchTranscriptBusy
                ? "Transcribing..."
                : "Transcribe unplayed",
              disabled:
                transcript.batchTranscriptBusy ||
                transcript.batchTranscriptCandidateEpisodes.length === 0,
              onSelect: () => void transcript.handleBatchTranscriptRequest(),
            },
            {
              kind: "command",
              id: "mark-all-played",
              label: markAllAsPlayedBusy ? "Marking..." : "Mark all as played",
              disabled:
                markAllAsPlayedBusy || visibleUnplayedEpisodeIds.length === 0,
              onSelect: () => onMarkAllVisibleUnplayedAsPlayed(),
            },
          ]}
        />
      </div>

      <div className={styles.episodeFilterBar}>
        <div className={styles.episodeFilterPills}>
          {(
            [
              ["all", "All"],
              ["unplayed", "Unplayed"],
              ["in_progress", "In Progress"],
              ["played", "Played"],
            ] as const
          ).map(([value, label]) => (
            <Button
              key={value}
              variant="pill"
              size="sm"
              className={styles.episodeFilterPill}
              aria-pressed={episodeStateFilter === value}
              onClick={() => setEpisodeStateFilter(value)}
            >
              {label}
            </Button>
          ))}
        </div>
        <label className={styles.episodeSortLabel}>
          Episode sort
          <Select
            size="sm"
            aria-label="Episode sort"
            value={episodeSort}
            onChange={(event) =>
              setEpisodeSort(event.target.value as EpisodeSort)
            }
          >
            <option value="newest">Newest</option>
            <option value="oldest">Oldest</option>
            <option value="duration_asc">Shortest</option>
            <option value="duration_desc">Longest</option>
          </Select>
        </label>
        <label className={styles.episodeSearchLabel}>
          Search episodes
          <Input
            size="sm"
            type="search"
            aria-label="Search episodes"
            className={styles.episodeSearchInput}
            placeholder="Search titles..."
            value={episodeSearchInput}
            onChange={(event) => setEpisodeSearchInput(event.target.value)}
          />
        </label>
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
        ariaLabel="Episodes"
        rowPanels={rowPanels}
        empty={
          !loading && !error ? (
            <FeedbackNotice
              severity="neutral"
              title="No episodes found for this podcast."
            />
          ) : null
        }
        footer={
          !loading && hasMoreEpisodes ? (
            <Button
              variant="secondary"
              size="md"
              onClick={() => onLoadMoreEpisodes()}
              disabled={loadingMoreEpisodes}
              aria-label="Load more episodes"
            >
              {loadingMoreEpisodes ? "Loading..." : "Load more episodes"}
            </Button>
          ) : undefined
        }
      />

    </div>
  );
}
