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

interface EpisodeControlsProps {
  episode: PodcastEpisodeMedia;
  inQueue: boolean;
  transcriptionAllowed: boolean;
  billingDisabled: boolean;
  showNotesExpanded: boolean;
  transcript: EpisodeTranscriptController;
  onToggleShowNotes: (mediaId: string) => void;
  onAddToQueue: (mediaId: string, position: "next" | "last") => void;
}

/**
 * Pane-owned controls for one episode row, rendered in the row's expanded
 * region beneath the presenter-driven chrome. Owns only what the episode
 * presenter cannot emit: the show-notes toggle + preview, the transcript
 * request form (reason + submit + quota hint + status), and the queue actions.
 */
export default function EpisodeControls({
  episode,
  inQueue,
  transcriptionAllowed,
  billingDisabled,
  showNotesExpanded,
  transcript,
  onToggleShowNotes,
  onAddToQueue,
}: EpisodeControlsProps) {
  const canRequestTranscript =
    transcriptionAllowed && canRequestTranscriptForEpisode(episode);
  const transcriptProvisioningInProgress =
    shouldPollTranscriptProvisioningForEpisode(episode);
  const transcriptReason =
    transcript.transcriptReasonByMediaId[episode.id] ?? "search";
  const transcriptRequestForecast =
    transcript.transcriptRequestForecastByMediaId[episode.id];
  const forecastForSelectedReason =
    transcriptRequestForecast &&
    transcriptRequestForecast.reason === transcriptReason
      ? transcriptRequestForecast
      : null;
  const transcriptRequestDisabled =
    transcript.requestingTranscriptMediaIds.ids.has(episode.id) ||
    (forecastForSelectedReason
      ? !forecastForSelectedReason.fits_budget
      : false);
  const showNotesText = episode.description_text?.trim() ?? "";

  return (
    <div className={styles.episodeActions}>
      {showNotesText ? (
        <Button
          variant="ghost"
          size="sm"
          className={styles.showNotesToggleButton}
          aria-label={`${showNotesExpanded ? "Hide" : "Show"} notes for ${episode.title}`}
          onClick={() => onToggleShowNotes(episode.id)}
        >
          {showNotesExpanded ? "Hide notes" : "Show notes"}
        </Button>
      ) : null}
      {showNotesText && showNotesExpanded && (
        <span className={styles.episodeShowNotes}>
          <span className={styles.episodeShowNotesPreview} data-expanded="true">
            {showNotesText}
          </span>
        </span>
      )}
      <Button
        variant="secondary"
        size="sm"
        aria-label={`Play next for ${episode.title}`}
        onClick={() => {
          onAddToQueue(episode.id, "next");
        }}
      >
        Play next
      </Button>
      <Button
        variant="secondary"
        size="sm"
        aria-label={`Add ${episode.title} to queue`}
        onClick={() => {
          onAddToQueue(episode.id, "last");
        }}
      >
        Add to queue
      </Button>
      {inQueue && <span className={styles.queueBadge}>In Queue</span>}
      {canRequestTranscript &&
        !transcript.expandedTranscriptMediaIds.ids.has(episode.id) && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              transcript.expandedTranscriptMediaIds.add(episode.id);
            }}
            aria-label={`Request transcript for ${episode.title}`}
          >
            Request transcript...
          </Button>
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
                aria-label={`Transcript request reason for ${episode.title}`}
              >
                <option value="search">search</option>
                <option value="highlight">highlight</option>
                <option value="quote">quote</option>
              </Select>
            </label>
            <Button
              variant="secondary"
              size="sm"
              aria-label={`Submit transcript request for ${episode.title}`}
              disabled={transcriptRequestDisabled}
              onClick={() =>
                void transcript.handleRequestTranscript(episode.id)
              }
            >
              {transcript.requestingTranscriptMediaIds.ids.has(episode.id)
                ? "Requesting..."
                : "Request transcript"}
            </Button>
            {forecastForSelectedReason && (
              <span className={styles.transcriptRequestHint}>
                {forecastForSelectedReason.source === "request"
                  ? forecastForSelectedReason.request_enqueued
                    ? "queued"
                    : "acknowledged"
                  : "estimate"}{" "}
                · {forecastForSelectedReason.required_minutes} min · remaining{" "}
                {forecastForSelectedReason.remaining_minutes == null
                  ? "unlimited"
                  : `${forecastForSelectedReason.remaining_minutes} min`}
              </span>
            )}
            {forecastForSelectedReason &&
              !forecastForSelectedReason.fits_budget && (
                <span className={styles.transcriptQuotaWarning}>
                  Not enough monthly transcription quota for this request.
                </span>
              )}
          </>
        )}
      {!canRequestTranscript && !transcriptionAllowed && (
        <span className={styles.transcriptQuotaWarning}>
          {billingDisabled
            ? "Billing is temporarily unavailable, so transcription upgrades are unavailable right now."
            : "Transcription is included with AI Plus and AI Pro."}
        </span>
      )}
      {!canRequestTranscript && transcriptionAllowed && (
        <span className={styles.transcriptStatus}>
          {episode.transcript_state === "ready"
            ? "Transcript ready"
            : episode.transcript_state === "partial"
              ? "Transcript partially ready"
              : transcriptProvisioningInProgress
                ? "Transcript request in progress"
                : episode.transcript_state === "unavailable"
                  ? "Transcript unavailable"
                  : "Transcript state unavailable"}
        </span>
      )}
    </div>
  );
}
