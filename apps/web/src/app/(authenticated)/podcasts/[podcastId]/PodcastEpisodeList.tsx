"use client";

// Canonical episode rows and episode-wide commands.
// Those commands name the server's state selection, never the rendered rows,
// so a local text filter disables them.

import { useState, type ReactNode } from "react";
import CollectionView from "@/components/collections/CollectionView";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import ActionMenu from "@/components/ui/ActionMenu";
import { presentMedia } from "@/lib/collections/presenters/media";
import { shouldPollTranscriptProvisioning } from "@/lib/media/transcriptView";
import {
  forecastEpisodeTranscripts,
  markEpisodesPlayed,
  requestEpisodeTranscripts,
  type EpisodeState,
  type PodcastEpisodeRow,
} from "@/lib/podcasts/api";
import type { useCommand } from "@/lib/podcasts/paneState";
import { canonicalResourceRef } from "@/lib/sharing/targets";
import styles from "./page.module.css";

const SELECTION: Readonly<Record<EpisodeState, string>> = {
  all: "",
  unplayed: " unplayed",
  in_progress: " in-progress",
  played: " played",
};
const TRANSCRIBE = "Batch transcripts weren’t requested";
const MARK = "Episodes weren’t marked as played";

export default function PodcastEpisodeList({
  podcastId,
  state,
  episodes,
  filter,
  complete,
  loading,
  historyLoading,
  command,
  notice,
  footer,
}: {
  readonly podcastId: string;
  readonly state: EpisodeState;
  readonly episodes: readonly PodcastEpisodeRow[];
  /** The trimmed local text filter. */
  readonly filter: string;
  readonly complete: boolean;
  readonly loading: boolean;
  readonly historyLoading: boolean;
  readonly command: ReturnType<typeof useCommand>;
  readonly notice: ReactNode;
  readonly footer: ReactNode;
}) {
  const [queued, setQueued] = useState<string | null>(null);
  const transcribeLabel = `Transcribe all${SELECTION[state]} episodes`;
  const markLabel =
    state === "played"
      ? "All played episodes are already played"
      : `Mark all${SELECTION[state]} episodes as played`;
  const filterActive = filter !== "";
  const unavailable =
    filterActive || command.running !== null || episodes.length === 0;
  const filterReason = filterActive
    ? "Clear Filter to use episode-wide actions"
    : undefined;

  const transcribe = () =>
    command.run(TRANSCRIBE, async () => {
      const forecast = await forecastEpisodeTranscripts(podcastId, state);
      const ask = `Eligible episodes: ${forecast.eligible_count}\n\nSubmit batch transcript request?`;
      if (!window.confirm(ask)) return;
      const result = await requestEpisodeTranscripts(
        podcastId,
        state,
        forecast.selection_fingerprint,
      );
      setQueued(
        `${result.queued_count} of ${result.matched_count} eligible episodes queued.`,
      );
    });

  const panels = Object.fromEntries(episodes.flatMap((episode) => shouldPollTranscriptProvisioning(episode.transcript_state)
    ? [[episode.id, <div key={episode.id} className={styles.panel}>transcript request in progress</div>]] : []));

  return (
    <div className={styles.episodes}>
      <div className={styles.actions}>
        <ActionMenu
          label="more actions for episodes"
          source={{ kind: "Immediate", subjectKey: `podcast:${podcastId}:episodes:${state}`, title: "episode actions", content: { sections: [{ id: "Episodes", label: null, options: [
            {
              kind: "command",
              id: "transcribe-episodes",
              label:
                command.running === TRANSCRIBE
                  ? "Transcribing..."
                  : transcribeLabel,
              disabled: unavailable,
              disabledReason: filterReason,
              onSelect: transcribe,
            },
            {
              kind: "command",
              id: "mark-all-played",
              label: command.running === MARK ? "Marking..." : markLabel,
              disabled: unavailable || state === "played",
              disabledReason:
                filterReason ??
                (state === "played"
                  ? "Every episode in this state is already played."
                  : undefined),
              onSelect: () => {
                if (!window.confirm(`${markLabel}?`)) return;
                command.run(MARK, () => markEpisodesPlayed(podcastId, state));
              },
            },
          ] }] } }}
        />
      </div>
      {queued ? <p className={styles.summary}>{queued}</p> : null}
      <CollectionView
        returnScope="PodcastDetail.Episodes"
        rows={episodes.map((episode) =>
          presentMedia(episode.media_summary, {
            id: episode.id,
            primary: { kind: "link", href: `/media/${episode.id}` },
            resourceRef: canonicalResourceRef({
              scheme: "media",
              id: episode.id,
            }),
            selected: false,
          }),
        )}
        status={loading ? "loading" : "ready"}
        ariaLabel="Episodes"
        notice={notice}
        footer={footer}
        rowPanels={panels}
        rowChangePresentation={{
          kind: "ImmediateOnKeyChange",
          key: filter,
        }}
        empty={
          loading ? null : (
            <FeedbackNotice
              content={{
                tone: "Neutral",
                title: !filterActive && state === "all"
                  ? historyLoading ? "loading episode history…" : "no episodes available."
                  : !filterActive ? `no ${state === "in_progress" ? "in-progress" : state} episodes.`
                  : complete
                    ? "No episodes match this filter."
                    : "No matching episode found so far.",
              }}
              announcement="None"
            />
          )
        }
      />
    </div>
  );
}
