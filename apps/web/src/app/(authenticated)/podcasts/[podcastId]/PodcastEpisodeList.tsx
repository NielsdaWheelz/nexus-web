"use client";

// Episode rows with their lazy show notes, and the episode-wide commands.
// Those commands name the server's state selection, never the rendered rows,
// so a local text filter disables them.

import { useState, type ReactNode } from "react";
import CollectionView from "@/components/collections/CollectionView";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import ActionMenu from "@/components/ui/ActionMenu";
import Button from "@/components/ui/Button";
import { presentMedia } from "@/lib/collections/presenters/media";
import { shouldPollTranscriptProvisioning } from "@/lib/media/transcriptView";
import {
  forecastEpisodeTranscripts,
  getShowNotes,
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
  readonly command: ReturnType<typeof useCommand>;
  readonly notice: ReactNode;
  readonly footer: ReactNode;
}) {
  const [notes, setNotes] = useState<Readonly<Record<string, string | null>>>(
    {},
  );
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
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

  const toggleNotes = (id: string) => {
    const opened = (shown: boolean) =>
      setOpen((current) => {
        const next = new Set(current);
        if (shown) next.add(id);
        else next.delete(id);
        return next;
      });
    if (open.has(id) || id in notes) return opened(!open.has(id));
    command.run("Episode notes couldn’t be loaded", async () => {
      const text = await getShowNotes(id);
      setNotes((current) => ({ ...current, [id]: text }));
      opened(true);
    });
  };
  const transcribe = () =>
    command.run(TRANSCRIBE, async () => {
      const forecast = await forecastEpisodeTranscripts(podcastId, state);
      const ask = `Eligible episodes: ${forecast.eligibleCount}\n\nSubmit batch transcript request?`;
      if (!window.confirm(ask)) return;
      const result = await requestEpisodeTranscripts(
        podcastId,
        state,
        forecast.selectionFingerprint,
      );
      setQueued(
        `${result.queuedCount} of ${result.matchedCount} eligible episodes queued.`,
      );
    });

  const controls: Record<string, ReactNode> = {};
  const panels: Record<string, ReactNode> = {};
  for (const episode of episodes) {
    const shown = open.has(episode.id);
    const text = shown ? notes[episode.id]?.trim() : undefined;
    const pending = shouldPollTranscriptProvisioning(episode.transcript_state);
    if (episode.has_show_notes) {
      controls[episode.id] = (
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={shown}
          aria-controls={`episode-panel-${episode.id}`}
          disabled={command.running !== null && !(episode.id in notes)}
          onClick={() => toggleNotes(episode.id)}
        >
          {shown ? "Hide notes" : "Show notes"}
        </Button>
      );
    }
    if (text || pending) {
      panels[episode.id] = (
        <div id={`episode-panel-${episode.id}`} className={styles.panel}>
          {text ? <span className={styles.notes}>{text}</span> : null}
          {pending ? <span>Transcript request in progress</span> : null}
        </div>
      );
    }
  }

  return (
    <div className={styles.episodes}>
      <div className={styles.actions}>
        <ActionMenu
          label="Episode actions"
          options={[
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
          ]}
        />
      </div>
      {queued ? <p className={styles.summary}>{queued}</p> : null}
      <CollectionView
        returnScope="PodcastDetail.Episodes"
        rows={episodes.map((episode) =>
          presentMedia(episode.mediaSummary, {
            id: episode.id,
            primary: { kind: "link", href: `/media/${episode.id}` },
            actionSubject: {
              ref: canonicalResourceRef({ scheme: "media", id: episode.id }),
            },
            selected: false,
          }),
        )}
        status={loading ? "loading" : "ready"}
        ariaLabel="Episodes"
        notice={notice}
        footer={footer}
        rowPanels={panels}
        rowControls={controls}
        rowChangePresentation={{
          kind: "ImmediateOnKeyChange",
          key: filter,
        }}
        empty={
          loading ? null : (
            <FeedbackNotice
              content={{
                tone: "Neutral",
                title: !filterActive
                  ? "No episodes found for this podcast."
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
