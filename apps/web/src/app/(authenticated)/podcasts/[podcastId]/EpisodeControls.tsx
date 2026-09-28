"use client";

import Button from "@/components/ui/Button";
import Select from "@/components/ui/Select";
import {
  canRequestTranscriptForEpisode,
  shouldPollTranscriptProvisioningForEpisode,
  type PodcastEpisodeMedia,
  type TranscriptRequestReason,
} from "./episodeTranscript";
import type { useEpisodeTranscriptController } from "./useEpisodeTranscriptController";
import styles from "./page.module.css";

type EpisodeTranscriptController = ReturnType<
  typeof useEpisodeTranscriptController
>;

interface EpisodeTranscriptControls {
  transcriptReasonByMediaId: EpisodeTranscriptController[
    "transcriptReasonByMediaId"
  ];
  requestingTranscriptMediaIds: Pick<
    EpisodeTranscriptController["requestingTranscriptMediaIds"],
    "ids"
  >;
  expandedTranscriptMediaIds: Pick<
    EpisodeTranscriptController["expandedTranscriptMediaIds"],
    "ids"
  >;
  setTranscriptReasonByMediaId: EpisodeTranscriptController[
    "setTranscriptReasonByMediaId"
  ];
  handleRequestTranscript: EpisodeTranscriptController[
    "handleRequestTranscript"
  ];
}

interface EpisodeControlsProps {
  episode: PodcastEpisodeMedia;
  showNotesExpanded: boolean;
  transcript: EpisodeTranscriptControls;
}

/**
 * Pane-owned controls for one episode row, rendered in the row's expanded
 * region beneath the presenter-driven chrome. Owns only what the episode
 * presenter cannot emit: expanded show notes and the transcript request form
 * (reason + submit + provisioning status). Stable commands live
 * in the row ActionMenu.
 */
export default function EpisodeControls({
  episode,
  showNotesExpanded,
  transcript,
}: EpisodeControlsProps) {
  const canRequestTranscript = canRequestTranscriptForEpisode(episode);
  const transcriptProvisioningInProgress =
    shouldPollTranscriptProvisioningForEpisode(episode);
  const transcriptReason =
    transcript.transcriptReasonByMediaId[episode.id] ?? "search";
  const showNotesText = episode.description_text?.trim() ?? "";

  return (
    <div id={`episode-panel-${episode.id}`} className={styles.episodeActions}>
      {showNotesText && showNotesExpanded && (
        <span className={styles.episodeShowNotes}>
          <span className={styles.episodeShowNotesPreview} data-expanded="true">
            {showNotesText}
          </span>
        </span>
      )}
      {canRequestTranscript &&
        transcript.expandedTranscriptMediaIds.ids.has(episode.id) && (
          <>
            <label className={styles.reasonLabel}>
              Transcript reason
              <Select
                size="sm"
                value={transcriptReason}
                onChange={(event) =>
                  transcript.setTranscriptReasonByMediaId((prev) => ({
                    ...prev,
                    [episode.id]: event.target
                      .value as TranscriptRequestReason,
                  }))
                }
                aria-label={`Transcript request reason for ${episode.mediaSummary.title}`}
              >
                <option value="search">search</option>
                <option value="highlight">highlight</option>
                <option value="quote">quote</option>
              </Select>
            </label>
            <Button
              variant="secondary"
              size="sm"
              aria-label={`Submit transcript request for ${episode.mediaSummary.title}`}
              disabled={transcript.requestingTranscriptMediaIds.ids.has(episode.id)}
              onClick={() =>
                void transcript.handleRequestTranscript(episode.id)
              }
            >
              {transcript.requestingTranscriptMediaIds.ids.has(episode.id)
                ? "Requesting..."
                : "Request transcript"}
            </Button>
          </>
        )}
      {!canRequestTranscript && transcriptProvisioningInProgress && (
        <span className={styles.transcriptStatus}>
          Transcript request in progress
        </span>
      )}
    </div>
  );
}
