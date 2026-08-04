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
import { absent } from "@/lib/api/presence";
import { requireDocumentProcessingStatus } from "@/lib/media/documentReadiness";
import type { LocalAvailability } from "@/lib/offlineMedia/contract";
import { useOfflineMediaItem } from "@/lib/offlineMedia/OfflineMediaProvider";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
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
type EpisodePresenterBaseContext = Omit<
  EpisodePresenterContext,
  "localAvailability"
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
  const offlineReady = offlineMedia.capability.kind === "Ready";
  const localAvailability =
    offlineReady &&
    (item.offline_download_eligible ||
      offlineMedia.availability.kind === "Present")
      ? offlineMedia.availability
      : absent<LocalAvailability>();
  return (
    <CollectionRow
      {...rowRenderProps}
      row={presentEpisode(item, { ...context, localAvailability })}
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
  expandedShowNotesMediaIds: StringIdSet;
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
  expandedShowNotesMediaIds,
  playNextDisabledMediaId,
  lecternReady,
  matchingEpisodeCount,
  markAllAsPlayedBusy,
  collectionBusy,
  exhaustion,
  onMarkAllAsPlayed,
  onToggleShowNotes,
  onPlayNext,
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

  const rowPresentations: EpisodePresentation[] = episodes.map((episode) => ({
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
    context: {},
  }));
  const presentationsByIdRef = useRef(new Map<string, EpisodePresentation>());
  for (const presentation of rowPresentations) {
    presentationsByIdRef.current.set(presentation.item.id, presentation);
  }
  const rows = rowPresentations.map((presentation) =>
    presentEpisode(presentation.item, {
      ...presentation.context,
      localAvailability: absent<LocalAvailability>(),
    }),
  );

  // Episode view + playback-session controls live in a SEPARATE per-row menu, not
  // the canonical resource dropdown (AC4): Show notes / Request transcript are
  // view-disclosure controls; Play next is a playback-queue control.
  const episodeViewControls = episodes.reduce<Record<string, ReactNode>>(
    (controls, episode) => {
      const panelId = `episode-panel-${episode.id}`;
      const showNotesExpanded = expandedShowNotesMediaIds.ids.has(episode.id);
      const transcriptPanelExpanded =
        transcript.expandedTranscriptMediaIds.ids.has(episode.id);
      const options: ActionDescriptor[] = [];
      if (episode.has_show_notes) {
        options.push({
          kind: "command",
          id: "ViewAction.Episode.ShowNotes",
          label: showNotesExpanded ? "Hide notes" : "Show notes",
          state: showNotesExpanded
            ? {
                kind: "disclosure",
                expanded: true,
                controls: panelId,
                menuLabels: { collapsed: "Show notes", expanded: "Hide notes" },
              }
            : {
                kind: "disclosure",
                expanded: false,
                menuLabels: { collapsed: "Show notes", expanded: "Hide notes" },
              },
          onSelect: () => onToggleShowNotes(episode.id),
        });
      }
      if (audioEpisodeIds.has(episode.id)) {
        const playNextBusy = busyEpisodeActionKeys.has(
          episodeActionBusyKey(episode.id, EPISODE_PLAY_NEXT_ACTION_ID),
        );
        options.push({
          kind: "command",
          id: "ViewAction.Episode.PlayNext",
          label: "Play next",
          disabled:
            !lecternReady ||
            episode.id === playNextDisabledMediaId ||
            playNextBusy,
          disabledReason: !lecternReady
            ? "Lectern is still loading"
            : episode.id === playNextDisabledMediaId
              ? "This episode is already next"
              : playNextBusy
                ? "Placing episode next"
                : undefined,
          onSelect: () => {
            void onPlayNext(episode.id);
          },
        });
      }
      if (transcriptionAllowed && canRequestTranscriptForEpisode(episode)) {
        options.push({
          kind: "command",
          id: "ViewAction.Episode.Transcript",
          label: transcriptPanelExpanded
            ? "Hide transcript request"
            : "Request transcript...",
          state: transcriptPanelExpanded
            ? {
                kind: "disclosure",
                expanded: true,
                controls: panelId,
                menuLabels: {
                  collapsed: "Request transcript...",
                  expanded: "Hide transcript request",
                },
              }
            : {
                kind: "disclosure",
                expanded: false,
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
        });
      }
      if (options.length > 0) {
        controls[episode.id] = (
          <ActionMenu label={`Options for ${episode.title}`} options={options} />
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
