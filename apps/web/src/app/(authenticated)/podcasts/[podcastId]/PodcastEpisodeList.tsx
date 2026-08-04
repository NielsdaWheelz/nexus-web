"use client";

import { useMemo, useRef, type ReactNode } from "react";
import {
  FeedbackNotice,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import ActionMenu from "@/components/ui/ActionMenu";
import CollectionRow from "@/components/collections/CollectionRow";
import CollectionExhaustionNotice from "@/components/collections/CollectionExhaustionNotice";
import CollectionView, {
  type CollectionViewRowRenderProps,
} from "@/components/collections/CollectionView";
import type { ExhaustionState } from "@/lib/api/useExhaustivePagination";
import {
  presentEpisode,
  type EpisodePresenterContext,
  type EpisodePresenterItem,
} from "@/lib/collections/presenters/episode";
import {
  RESOURCE_ACTION_CATALOG,
  type ResourceActionId,
} from "@/lib/actions/resourceActions";
import { requireDocumentProcessingStatus } from "@/lib/media/documentReadiness";
import type { LecternItemId } from "@/lib/lectern/contract";
import type { EpisodeStateFilter } from "@/lib/podcasts/episodeView";
import { useOfflineMediaItem } from "@/lib/offlineMedia/OfflineMediaProvider";
import type { ActionSelectDetail } from "@/lib/ui/actionDescriptor";
import { useStringIdSet } from "@/lib/useStringIdSet";
import EpisodeControls from "./EpisodeControls";
import {
  EPISODE_WIDE_COMMAND_LABELS,
  deriveEpisodeState,
  decodeEpisodeTimingFacts,
  decodeEpisodePublicationDate,
  episodePlayerDescriptor,
  canRequestTranscriptForEpisode,
  shouldPollTranscriptProvisioningForEpisode,
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
type EpisodePresenterBaseContext = Omit<
  EpisodePresenterContext,
  "offlineDownload"
>;

interface EpisodePresentation {
  readonly item: EpisodePresenterItem;
  readonly context: EpisodePresenterBaseContext;
}

function OfflineEpisodeCollectionRow({
  presentation,
  rowRenderProps,
}: {
  readonly presentation: EpisodePresentation;
  readonly rowRenderProps: CollectionViewRowRenderProps;
}) {
  const { item, context } = presentation;
  const offlineMedia = useOfflineMediaItem(item.id, item.title);
  const controller =
    offlineMedia.capability.kind === "Ready"
      ? offlineMedia.capability.controller
      : null;
  const offlineDownload =
    controller !== null &&
    (item.offline_download_eligible ||
      offlineMedia.availability.kind === "Present")
      ? {
          kind: "Available" as const,
          availability: offlineMedia.availability,
          execute: {
            download: () => controller.enqueue(item.id),
            cancel: () => controller.cancel(item.id),
            retry: () => controller.retry(item.id),
            remove: () => controller.remove(item.id),
          },
        }
      : { kind: "Unavailable" as const };
  return (
    <CollectionRow
      {...rowRenderProps}
      row={presentEpisode(item, { ...context, offlineDownload })}
    />
  );
}

interface PodcastEpisodeListProps {
  episodes: PodcastEpisodeMedia[];
  filterQuery: string;
  loading: boolean;
  error: FeedbackContent | null;
  episodeStateFilter: EpisodeStateFilter;
  transcript: EpisodeTranscriptController;
  transcriptionAllowed: boolean;
  busyEpisodeActionKeys: StringIdSet;
  markingEpisodeIds: StringIdSet;
  expandedShowNotesMediaIds: StringIdSet;
  unconfirmedMetadataMediaIds: ReadonlySet<string>;
  lecternItemsByMediaId: ReadonlyMap<string, LecternItemId>;
  playNextDisabledMediaId: string | null;
  /** Whether the Lectern snapshot is Ready; its mutations defect until then. */
  lecternReady: boolean;
  matchingEpisodeCount: number;
  markAllAsPlayedBusy: boolean;
  collectionBusy: boolean;
  exhaustion: ExhaustionState;
  onMarkAllAsPlayed: () => void;
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
  filterQuery,
  loading,
  error,
  episodeStateFilter,
  transcript,
  transcriptionAllowed,
  busyEpisodeActionKeys,
  markingEpisodeIds,
  expandedShowNotesMediaIds,
  unconfirmedMetadataMediaIds,
  lecternItemsByMediaId,
  playNextDisabledMediaId,
  lecternReady,
  matchingEpisodeCount,
  markAllAsPlayedBusy,
  collectionBusy,
  exhaustion,
  onMarkAllAsPlayed,
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
  const localFilterActive = filterQuery.trim().length > 0;
  const commandLabels = EPISODE_WIDE_COMMAND_LABELS[episodeStateFilter];
  const localFilterDisabledReason = "Clear Filter to use episode-wide actions";
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

  const rowPresentations: EpisodePresentation[] = episodes.map((episode) => {
    const panelId = `episode-panel-${episode.id}`;
    const showNotesExpanded = expandedShowNotesMediaIds.ids.has(episode.id);
    const transcriptPanelExpanded =
      transcript.expandedTranscriptMediaIds.ids.has(episode.id);
    const lecternItemId = lecternItemsByMediaId.get(episode.id);
    const actionBusy = (actionId: ResourceActionId) =>
      busyEpisodeActionKeys.has(episodeActionBusyKey(episode.id, actionId));
    return {
      item: {
        id: episode.id,
        title: episode.title,
        kind: episode.kind,
        processing_status: requireDocumentProcessingStatus(
          episode.processing_status,
        ),
        episode_state: deriveEpisodeState(episode),
        canonical_source_url: episode.canonical_source_url,
        offline_download_eligible: episode.offline_download_eligible,
        contributors: episode.contributors,
        capabilities: episode.capabilities,
        publicationDate: decodeEpisodePublicationDate(episode.published_date),
        activityFacts: decodeEpisodeTimingFacts(episode.listening_state),
      },
      context: {
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
        retryMetadata:
          episode.capabilities.can_retry_metadata &&
          !unconfirmedMetadataMediaIds.has(episode.id)
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
    };
  });
  const presentationsByIdRef = useRef(new Map<string, EpisodePresentation>());
  for (const presentation of rowPresentations) {
    presentationsByIdRef.current.set(presentation.item.id, presentation);
  }
  const rows = rowPresentations.map((presentation) =>
    presentEpisode(presentation.item, {
      ...presentation.context,
      offlineDownload: { kind: "Unavailable" },
    }),
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
                !transcriptionAllowed ||
                matchingEpisodeCount === 0,
              disabledReason: localFilterActive
                ? localFilterDisabledReason
                : undefined,
              onSelect: () => {
                if (
                  localFilterActive ||
                  transcript.batchTranscriptBusy ||
                  !transcriptionAllowed ||
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
        renderRow={(rowRenderProps) => {
          const presentation = presentationsByIdRef.current.get(
            rowRenderProps.row.id,
          );
          if (presentation === undefined) {
            // justify-defect: CollectionView renders exactly the row ids
            // projected from this presentation map.
            throw new Error(
              `Missing podcast episode presentation: ${rowRenderProps.row.id}`,
            );
          }
          return (
            <OfflineEpisodeCollectionRow
              presentation={presentation}
              rowRenderProps={rowRenderProps}
            />
          );
        }}
        status="ready"
        collectionBusy={collectionBusy}
        footer={<CollectionExhaustionNotice state={exhaustion} />}
        ariaLabel="Episodes"
        rowPanels={rowPanels}
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
