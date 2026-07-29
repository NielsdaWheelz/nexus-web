"use client";

import {
  useMemo,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import {
  FeedbackNotice,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import ActionMenu from "@/components/ui/ActionMenu";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import Select from "@/components/ui/Select";
import CollectionExhaustionNotice from "@/components/collections/CollectionExhaustionNotice";
import CollectionView from "@/components/collections/CollectionView";
import type { ExhaustionState } from "@/lib/api/useExhaustivePagination";
import { presentEpisode } from "@/lib/collections/presenters/episode";
import {
  RESOURCE_ACTION_CATALOG,
  type ResourceActionId,
} from "@/lib/actions/resourceActions";
import { requireDocumentProcessingStatus } from "@/lib/media/documentReadiness";
import type { LecternItemId } from "@/lib/lectern/contract";
import type { ActionSelectDetail } from "@/lib/ui/actionDescriptor";
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
import {
  EPISODE_PLAY_NEXT_ACTION_ID,
  episodeActionBusyKey,
} from "./episodeActionBusy";
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
  busyEpisodeActionKeys: StringIdSet;
  markingEpisodeIds: StringIdSet;
  expandedShowNotesMediaIds: StringIdSet;
  lecternItemsByMediaId: ReadonlyMap<string, LecternItemId>;
  playNextDisabledMediaId: string | null;
  /** Whether the Lectern snapshot is Ready; its mutations defect until then. */
  lecternReady: boolean;
  matchingEpisodeCount: number;
  markAllAsPlayedBusy: boolean;
  collectionBusy: boolean;
  exhaustion: ExhaustionState;
  onMarkAllMatchingAsPlayed: () => void;
  onToggleShowNotes: (mediaId: string) => void;
  onPlayNext: (mediaId: string) => Promise<void>;
  onAddToLectern: (mediaId: string) => Promise<void>;
  onRemoveFromLectern: (
    mediaId: string,
    itemId: LecternItemId,
  ) => Promise<void>;
  onRetry: (mediaId: string) => Promise<void>;
  onRefreshSource: (mediaId: string) => Promise<void>;
  onRetryMetadata: (mediaId: string) => Promise<void>;
  onEditAuthors: (
    episode: PodcastEpisodeMedia,
    detail: ActionSelectDetail,
  ) => void;
  onDelete: (episode: PodcastEpisodeMedia) => Promise<void>;
  onTogglePlayed: (
    episode: PodcastEpisodeMedia,
    isCompleted: boolean,
  ) => Promise<void>;
  onResetProgress: (mediaId: string) => Promise<void>;
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
  busyEpisodeActionKeys,
  markingEpisodeIds,
  expandedShowNotesMediaIds,
  lecternItemsByMediaId,
  playNextDisabledMediaId,
  lecternReady,
  matchingEpisodeCount,
  markAllAsPlayedBusy,
  collectionBusy,
  exhaustion,
  onMarkAllMatchingAsPlayed,
  onToggleShowNotes,
  onPlayNext,
  onAddToLectern,
  onRemoveFromLectern,
  onRetry,
  onRefreshSource,
  onRetryMetadata,
  onEditAuthors,
  onDelete,
  onTogglePlayed,
  onResetProgress,
}: PodcastEpisodeListProps) {
  const selectionIsNarrowed =
    episodeStateFilter !== "all" || episodeSearchInput.trim().length > 0;
  const transcriptCommandLabel = selectionIsNarrowed
    ? "Transcribe matching episodes"
    : "Transcribe all episodes";
  const markPlayedCommandLabel = selectionIsNarrowed
    ? "Mark matching episodes as played"
    : "Mark all episodes as played";
  // Playback presence gates playback-only view actions. Lectern relationship
  // applicability comes exclusively from the ready membership snapshot, just
  // as it does in the opened media pane.
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
    const lecternItemId = lecternItemsByMediaId.get(episode.id);
    const actionBusy = (actionId: ResourceActionId) =>
      busyEpisodeActionKeys.has(episodeActionBusyKey(episode.id, actionId));
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
        retryProcessing: episode.capabilities.can_retry
          ? {
              kind: "Available",
              execute: async () => {
                if (actionBusy(RESOURCE_ACTION_CATALOG.RetryProcessing.id))
                  return;
                await onRetry(episode.id);
              },
            }
          : { kind: "Unavailable" },
        refreshSource: episode.capabilities.can_refresh_source
          ? {
              kind: "Available",
              execute: async () => {
                if (actionBusy(RESOURCE_ACTION_CATALOG.RefreshSource.id))
                  return;
                await onRefreshSource(episode.id);
              },
            }
          : { kind: "Unavailable" },
        retryMetadata: episode.capabilities.can_retry_metadata
          ? {
              kind: "Available",
              execute: async () => {
                if (actionBusy(RESOURCE_ACTION_CATALOG.RetryMetadata.id))
                  return;
                await onRetryMetadata(episode.id);
              },
            }
          : { kind: "Unavailable" },
        editAuthors: episode.capabilities.can_edit_authors
          ? {
              kind: "Available",
              execute: (detail) => onEditAuthors(episode, detail),
            }
          : { kind: "Unavailable" },
        removeMedia: episode.capabilities.can_delete
          ? {
              kind: "Available",
              execute: async () => {
                if (actionBusy(RESOURCE_ACTION_CATALOG.RemoveMedia.id)) return;
                await onDelete(episode);
              },
            }
          : { kind: "Unavailable" },
        progressReset: episode.progress_resettable
          ? {
              kind: "Available",
              execute: async () => {
                if (actionBusy(RESOURCE_ACTION_CATALOG.ResetProgress.id)) {
                  return;
                }
                await onResetProgress(episode.id);
              },
            }
          : { kind: "Unavailable" },
        playedState:
          deriveEpisodeState(episode) === "played"
            ? {
                kind: "MarkUnplayed",
                execute: async () => {
                  if (markingEpisodeIds.has(episode.id)) return;
                  await onTogglePlayed(episode, false);
                },
              }
            : {
                kind: "MarkPlayed",
                execute: async () => {
                  if (markingEpisodeIds.has(episode.id)) return;
                  await onTogglePlayed(episode, true);
                },
              },
        lecternMembership: !lecternReady
          ? { kind: "Unavailable" }
          : lecternItemId
            ? {
                kind: "Remove",
                itemId: lecternItemId,
                execute: async () => {
                  if (
                    actionBusy(RESOURCE_ACTION_CATALOG.RemoveFromLectern.id)
                  ) {
                    return;
                  }
                  await onRemoveFromLectern(episode.id, lecternItemId);
                },
              }
            : {
                kind: "Add",
                execute: async () => {
                  if (actionBusy(RESOURCE_ACTION_CATALOG.AddToLectern.id)) {
                    return;
                  }
                  await onAddToLectern(episode.id);
                },
              },
        busyIds: new Set<ResourceActionId>([
          ...[
            RESOURCE_ACTION_CATALOG.RetryProcessing.id,
            RESOURCE_ACTION_CATALOG.RefreshSource.id,
            RESOURCE_ACTION_CATALOG.RetryMetadata.id,
            RESOURCE_ACTION_CATALOG.RemoveMedia.id,
            RESOURCE_ACTION_CATALOG.ResetProgress.id,
            RESOURCE_ACTION_CATALOG.AddToLectern.id,
            RESOURCE_ACTION_CATALOG.RemoveFromLectern.id,
          ].filter(actionBusy),
          ...(markingEpisodeIds.ids.has(episode.id)
            ? [
                RESOURCE_ACTION_CATALOG.MarkPlayed.id,
                RESOURCE_ACTION_CATALOG.MarkUnplayed.id,
              ]
            : []),
        ]),
        view: [
          ...(episode.has_show_notes
            ? [
                {
                  kind: "command" as const,
                  id: "ViewAction.Episode.ShowNotes",
                  label: showNotesExpanded ? "Hide notes" : "Show notes",
                  state: showNotesExpanded
                    ? {
                        kind: "disclosure" as const,
                        expanded: true as const,
                        controls: panelId,
                        menuLabels: {
                          collapsed: "Show notes",
                          expanded: "Hide notes",
                        },
                      }
                    : {
                        kind: "disclosure" as const,
                        expanded: false as const,
                        menuLabels: {
                          collapsed: "Show notes",
                          expanded: "Hide notes",
                        },
                      },
                  onSelect: () => onToggleShowNotes(episode.id),
                },
              ]
            : []),
          ...(audioEpisodeIds.has(episode.id)
            ? [
                {
                  kind: "command" as const,
                  id: "ViewAction.Episode.PlayNext",
                  label: "Play next",
                  disabled:
                    !lecternReady ||
                    episode.id === playNextDisabledMediaId ||
                    busyEpisodeActionKeys.has(
                      episodeActionBusyKey(
                        episode.id,
                        EPISODE_PLAY_NEXT_ACTION_ID,
                      ),
                    ),
                  disabledReason: !lecternReady
                    ? "Lectern is still loading"
                    : episode.id === playNextDisabledMediaId
                      ? "This episode is already next"
                      : busyEpisodeActionKeys.has(
                            episodeActionBusyKey(
                              episode.id,
                              EPISODE_PLAY_NEXT_ACTION_ID,
                            ),
                          )
                        ? "Placing episode next"
                        : undefined,
                  onSelect: () => {
                    void onPlayNext(episode.id);
                  },
                },
              ]
            : []),
          ...(transcriptionAllowed && canRequestTranscriptForEpisode(episode)
            ? [
                {
                  kind: "command" as const,
                  id: "ViewAction.Episode.Transcript",
                  label: transcriptPanelExpanded
                    ? "Hide transcript request"
                    : "Request transcript...",
                  state: transcriptPanelExpanded
                    ? {
                        kind: "disclosure" as const,
                        expanded: true as const,
                        controls: panelId,
                        menuLabels: {
                          collapsed: "Request transcript...",
                          expanded: "Hide transcript request",
                        },
                      }
                    : {
                        kind: "disclosure" as const,
                        expanded: false as const,
                        menuLabels: {
                          collapsed: "Request transcript...",
                          expanded: "Hide transcript request",
                        },
                      },
                  onSelect: () => {
                    if (transcriptPanelExpanded) {
                      transcript.expandedTranscriptMediaIds.remove(episode.id);
                    } else {
                      transcript.expandedTranscriptMediaIds.add(episode.id);
                    }
                  },
                },
              ]
            : []),
        ],
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
          {!loading && error === null && exhaustion.kind === "Complete" ? (
            <span>{exhaustion.itemCount} episodes</span>
          ) : null}
        </div>
        <ActionMenu
          label="Episode actions"
          options={[
            {
              kind: "command",
              id: "transcribe-unplayed",
              label: transcript.batchTranscriptBusy
                ? "Transcribing..."
                : transcriptCommandLabel,
              disabled:
                transcript.batchTranscriptBusy ||
                !transcriptionAllowed ||
                matchingEpisodeCount === 0,
              onSelect: () => void transcript.handleBatchTranscriptRequest(),
            },
            {
              kind: "command",
              id: "mark-all-played",
              label: markAllAsPlayedBusy
                ? "Marking..."
                : markPlayedCommandLabel,
              disabled:
                markAllAsPlayedBusy || matchingEpisodeCount === 0,
              onSelect: () => onMarkAllMatchingAsPlayed(),
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
        collectionBusy={collectionBusy}
        footer={<CollectionExhaustionNotice state={exhaustion} />}
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
      />
    </div>
  );
}
