"use client";

import { useMemo, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { FeedbackNotice, type FeedbackContent } from "@/components/feedback/Feedback";
import ActionMenu from "@/components/ui/ActionMenu";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import Select from "@/components/ui/Select";
import LibraryMembershipPanel from "@/components/LibraryMembershipPanel";
import CollectionView from "@/components/collections/CollectionView";
import CollectionDisplayControls from "@/components/collections/CollectionDisplayControls";
import { presentEpisode } from "@/lib/collections/presenters/episode";
import { useCollectionDisplayState } from "@/lib/collections/useCollectionDisplayState";
import { useConnectionSummaries } from "@/lib/collections/useConnectionSummaries";
import { requireDocumentProcessingStatus } from "@/lib/media/documentReadiness";
import { useLibraryMembership } from "@/lib/media/useLibraryMembership";
import { useStringIdSet } from "@/lib/useStringIdSet";
import EpisodeControls from "./EpisodeControls";
import {
  deriveEpisodeState,
  episodePlayerDescriptor,
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
  basePath: string;
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
  lecternMediaIds: Set<string>;
  playNextDisabledMediaId: string | null;
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
  basePath,
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
  lecternMediaIds,
  playNextDisabledMediaId,
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
  const { displayState, setDisplayState } = useCollectionDisplayState(basePath);
  const listDisplayState = { ...displayState, view: "list" as const };
  // The per-episode library picker is lifted here (one panel for the list,
  // keyed by the active episode) so the presenter ctx's `onManageLibraries`
  // can anchor it without per-row hook state.
  const [membershipEpisodeId, setMembershipEpisodeId] = useState<string | null>(
    null,
  );
  const [membershipTriggerEl, setMembershipTriggerEl] =
    useState<HTMLElement | null>(null);
  const membership = useLibraryMembership(membershipEpisodeId);
  const { loadLibraries } = membership;
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

  const rows = episodes.map((episode) =>
    presentEpisode(
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
        published_date: episode.published_date,
        listening_state: episode.listening_state,
      },
      {
        connectionSummary: connectionSummaries.get(`media:${episode.id}`),
        busy: busyMediaIds.ids.has(episode.id),
        retryBusy: busyMediaIds.ids.has(episode.id),
        refreshBusy: busyMediaIds.ids.has(episode.id),
        deleteBusy: busyMediaIds.ids.has(episode.id),
        markingBusy: markingEpisodeIds.ids.has(episode.id),
        onManageLibraries: ({ triggerEl }) => {
          setMembershipEpisodeId(episode.id);
          setMembershipTriggerEl(triggerEl);
          void loadLibraries();
        },
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
        onAddToLectern: audioEpisodeIds.has(episode.id)
          ? () => {
              onAddToLectern(episode.id);
            }
          : undefined,
      },
    ),
  );

  const rowPanels = episodes.reduce<Record<string, ReactNode>>(
    (panels, episode) => {
      panels[episode.id] = (
        <EpisodeControls
          episode={episode}
          isAudioEpisode={audioEpisodeIds.has(episode.id)}
          onLectern={lecternMediaIds.has(episode.id)}
          playNextDisabled={episode.id === playNextDisabledMediaId}
          transcriptionAllowed={transcriptionAllowed}
          billingDisabled={billingDisabled}
          showNotesExpanded={expandedShowNotesMediaIds.ids.has(episode.id)}
          transcript={transcript}
          onToggleShowNotes={onToggleShowNotes}
          onPlayNext={onPlayNext}
          onAddToLectern={onAddToLectern}
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
        <CollectionDisplayControls
          value={listDisplayState}
          onChange={setDisplayState}
          gallery={false}
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
        rows={rows}
        view="list"
        density={displayState.density}
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

      <LibraryMembershipPanel
        open={membershipEpisodeId !== null}
        title="Libraries"
        anchorEl={membershipTriggerEl}
        libraries={membership.libraries}
        loading={membership.loading}
        busy={membership.busy}
        error={membership.error}
        emptyMessage="No non-default libraries available."
        onClose={() => {
          setMembershipEpisodeId(null);
          setMembershipTriggerEl(null);
        }}
        onAddToLibrary={(libraryId) => {
          void membership.addToLibrary(libraryId);
        }}
        onRemoveFromLibrary={(libraryId) => {
          void membership.removeFromLibrary(libraryId);
        }}
      />
    </div>
  );
}
