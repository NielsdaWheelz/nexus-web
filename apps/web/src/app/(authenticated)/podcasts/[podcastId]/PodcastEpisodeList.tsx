"use client";

import type { Dispatch, SetStateAction } from "react";
import { FeedbackNotice, type FeedbackContent } from "@/components/feedback/Feedback";
import ActionMenu from "@/components/ui/ActionMenu";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import ResourceList from "@/components/ui/ResourceList";
import Select from "@/components/ui/Select";
import { useStringIdSet } from "@/lib/useStringIdSet";
import PodcastEpisodeRow from "./PodcastEpisodeRow";
import {
  type EpisodeSort,
  type EpisodeStateFilter,
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
  billingDisabled: boolean;
  busyMediaIds: StringIdSet;
  markingEpisodeIds: StringIdSet;
  expandedShowNotesMediaIds: StringIdSet;
  queueMediaIds: Set<string>;
  visibleUnplayedEpisodeIds: string[];
  markAllAsPlayedBusy: boolean;
  hasMoreEpisodes: boolean;
  loadingMoreEpisodes: boolean;
  onMarkAllVisibleUnplayedAsPlayed: () => void;
  onLoadMoreEpisodes: () => void;
  onToggleShowNotes: (mediaId: string) => void;
  onAddToQueue: (mediaId: string, position: "next" | "last") => void;
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
  billingDisabled,
  busyMediaIds,
  markingEpisodeIds,
  expandedShowNotesMediaIds,
  queueMediaIds,
  visibleUnplayedEpisodeIds,
  markAllAsPlayedBusy,
  hasMoreEpisodes,
  loadingMoreEpisodes,
  onMarkAllVisibleUnplayedAsPlayed,
  onLoadMoreEpisodes,
  onToggleShowNotes,
  onAddToQueue,
  onOpenChat,
  onRetry,
  onRefreshSource,
  onDelete,
  onTogglePlayed,
}: PodcastEpisodeListProps) {
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
              id: "mark-all-played",
              label: markAllAsPlayedBusy ? "Marking..." : "Mark all as played",
              disabled:
                markAllAsPlayedBusy || visibleUnplayedEpisodeIds.length === 0,
              onSelect: () => onMarkAllVisibleUnplayedAsPlayed(),
            },
          ]}
        />
      </div>

      {!loading && episodes.length === 0 && !error && (
        <FeedbackNotice
          severity="neutral"
          title="No episodes found for this podcast."
        />
      )}

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

      {episodes.length > 0 || (!loading && hasMoreEpisodes) ? (
        <ResourceList
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
        >
          {episodes.map((episode) => (
            <PodcastEpisodeRow
              key={episode.id}
              episode={episode}
              busy={busyMediaIds.ids.has(episode.id)}
              markingBusy={markingEpisodeIds.ids.has(episode.id)}
              inQueue={queueMediaIds.has(episode.id)}
              transcriptionAllowed={transcriptionAllowed}
              billingDisabled={billingDisabled}
              showNotesExpanded={expandedShowNotesMediaIds.ids.has(episode.id)}
              transcript={transcript}
              onToggleShowNotes={onToggleShowNotes}
              onAddToQueue={onAddToQueue}
              onOpenChat={onOpenChat}
              onRetry={onRetry}
              onRefreshSource={onRefreshSource}
              onDelete={onDelete}
              onTogglePlayed={onTogglePlayed}
            />
          ))}
        </ResourceList>
      ) : null}
    </div>
  );
}
