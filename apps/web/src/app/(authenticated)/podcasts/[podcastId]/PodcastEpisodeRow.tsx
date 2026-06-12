"use client";

import { useState } from "react";
import { episodeResourceOptions } from "@/lib/actions/resourceActions";
import { useLibraryMembership } from "@/lib/media/useLibraryMembership";
import { formatContributorCreditSummary } from "@/lib/contributors/formatting";
import ContributorCreditList from "@/components/contributors/ContributorCreditList";
import LibraryMembershipPanel from "@/components/LibraryMembershipPanel";
import ActionMenu from "@/components/ui/ActionMenu";
import Button from "@/components/ui/Button";
import ResourceRow from "@/components/ui/ResourceRow";
import Select from "@/components/ui/Select";
import {
  canRequestTranscriptForEpisode,
  deriveEpisodeState,
  getEpisodeProgressPercent,
  shouldPollTranscriptProvisioningForEpisode,
  type PodcastEpisodeMedia,
  type TranscriptRequestReason,
} from "./episodeTranscript";
import type { useEpisodeTranscriptController } from "./useEpisodeTranscriptController";
import styles from "./page.module.css";

type EpisodeTranscriptController = ReturnType<
  typeof useEpisodeTranscriptController
>;

interface PodcastEpisodeRowProps {
  episode: PodcastEpisodeMedia;
  busy: boolean;
  markingBusy: boolean;
  inQueue: boolean;
  transcriptionAllowed: boolean;
  billingDisabled: boolean;
  showNotesExpanded: boolean;
  transcript: EpisodeTranscriptController;
  onToggleShowNotes: (mediaId: string) => void;
  onAddToQueue: (mediaId: string, position: "next" | "last") => void;
  onOpenChat: (episode: PodcastEpisodeMedia) => void;
  onRetry: (mediaId: string) => void;
  onRefreshSource: (mediaId: string) => void;
  onDelete: (episode: PodcastEpisodeMedia) => void;
  onTogglePlayed: (episode: PodcastEpisodeMedia, isCompleted: boolean) => void;
}

export default function PodcastEpisodeRow({
  episode,
  busy,
  markingBusy,
  inQueue,
  transcriptionAllowed,
  billingDisabled,
  showNotesExpanded,
  transcript,
  onToggleShowNotes,
  onAddToQueue,
  onOpenChat,
  onRetry,
  onRefreshSource,
  onDelete,
  onTogglePlayed,
}: PodcastEpisodeRowProps) {
  const {
    libraries,
    loading: librariesLoading,
    error: librariesError,
    busy: membershipBusy,
    loadLibraries,
    addToLibrary,
    removeFromLibrary,
  } = useLibraryMembership(episode.id);
  const [membershipPanelOpen, setMembershipPanelOpen] = useState(false);
  const [membershipPanelTriggerEl, setMembershipPanelTriggerEl] =
    useState<HTMLElement | null>(null);

  const episodeState = deriveEpisodeState(episode);
  const episodeProgressPercent = getEpisodeProgressPercent(episode);
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
  const authorSummary = formatContributorCreditSummary(episode.contributors, 1);
  const paneTitleHint =
    authorSummary && `${episode.title} · ${authorSummary}`.length <= 56
      ? `${episode.title} · ${authorSummary}`
      : episode.title;
  const rowOptions = episodeResourceOptions({
    media: episode,
    busy,
    retryBusy: busy,
    refreshBusy: busy,
    deleteBusy: busy,
    played: episodeState === "played",
    markingBusy,
    onManageLibraries: ({ triggerEl }) => {
      setMembershipPanelOpen(true);
      setMembershipPanelTriggerEl(triggerEl);
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
      onTogglePlayed(episode, episodeState !== "played");
    },
  });

  return (
    <>
      <ResourceRow
        primary={{
          kind: "link",
          href: `/media/${episode.id}`,
          paneTitleHint,
        }}
        title={
          <span className={styles.episodeTitle}>
            {episodeState === "unplayed" && (
              <span className={styles.unplayedDot} aria-hidden="true" />
            )}
            <span
              className={
                episodeState === "played"
                  ? styles.playedEpisodeTitleText
                  : undefined
              }
            >
              {episode.title}
            </span>
          </span>
        }
        description={
          <span className={styles.episodeDescription}>
            <span>
              {episode.capabilities.can_play ? "Playable episode" : "Processing"}
            </span>
            {episodeState === "in_progress" && (
              <span
                className={styles.inProgressBar}
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={episodeProgressPercent}
              >
                <span
                  className={styles.inProgressBarFill}
                  style={{ width: `${episodeProgressPercent}%` }}
                />
              </span>
            )}
            {showNotesText && showNotesExpanded && (
              <span className={styles.episodeShowNotes}>
                <span
                  className={styles.episodeShowNotesPreview}
                  data-expanded="true"
                >
                  {showNotesText}
                </span>
              </span>
            )}
          </span>
        }
        meta={
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              flexWrap: "wrap",
              gap: "0.35rem",
            }}
          >
            <span>
              {[
                episode.processing_status,
                `transcript ${episode.transcript_state ?? "unknown"} (${episode.transcript_coverage ?? "unknown"} coverage)`,
                episodeState === "in_progress" ? "in progress" : episodeState,
              ].join(" · ")}
            </span>
          </span>
        }
        actions={
          <>
            <div className={styles.episodeActions}>
              <ContributorCreditList
                credits={episode.contributors}
                maxVisible={1}
              />
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
                        · {forecastForSelectedReason.required_minutes} min ·
                        remaining{" "}
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
            <ActionMenu options={rowOptions} />
          </>
        }
      />

      <LibraryMembershipPanel
        open={membershipPanelOpen}
        title="Libraries"
        anchorEl={membershipPanelTriggerEl}
        libraries={libraries}
        loading={librariesLoading}
        busy={membershipBusy}
        error={librariesError}
        emptyMessage="No non-default libraries available."
        onClose={() => {
          setMembershipPanelOpen(false);
          setMembershipPanelTriggerEl(null);
        }}
        onAddToLibrary={(libraryId) => {
          void addToLibrary(libraryId);
        }}
        onRemoveFromLibrary={(libraryId) => {
          void removeFromLibrary(libraryId);
        }}
      />
    </>
  );
}
