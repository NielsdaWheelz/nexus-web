"use client";

import { useRef, type ReactNode } from "react";
import {
  FeedbackNotice,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import ActionMenu from "@/components/ui/ActionMenu";
import Button from "@/components/ui/Button";
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
import type { EpisodeStateFilter } from "@/lib/podcasts/episodeView";
import { useOfflineMediaItem } from "@/lib/offlineMedia/OfflineMediaProvider";
import { useStringIdSet } from "@/lib/useStringIdSet";
import EpisodeControls from "./EpisodeControls";
import {
  EPISODE_WIDE_COMMAND_LABELS,
  deriveEpisodeState,
  decodeEpisodeTimingFacts,
  decodeEpisodePublicationDate,
  shouldPollTranscriptProvisioningForEpisode,
  type PodcastEpisodeMedia,
} from "./episodeTranscript";
import type { useEpisodeTranscriptController } from "./useEpisodeTranscriptController";
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
  expandedShowNotesMediaIds: StringIdSet;
  matchingEpisodeCount: number;
  markAllAsPlayedBusy: boolean;
  collectionBusy: boolean;
  exhaustion: ExhaustionState;
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
  transcriptionAllowed,
  expandedShowNotesMediaIds,
  matchingEpisodeCount,
  markAllAsPlayedBusy,
  collectionBusy,
  exhaustion,
  onMarkAllAsPlayed,
  onToggleShowNotes,
}: PodcastEpisodeListProps) {
  const localFilterActive = filterQuery.trim().length > 0;
  const commandLabels = EPISODE_WIDE_COMMAND_LABELS[episodeStateFilter];
  const localFilterDisabledReason = "Clear Filter to use episode-wide actions";
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

  // Show notes changes only this occurrence's disclosure. Every standing
  // episode action lives in CollectionRow's canonical ResourceActionMenu.
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
