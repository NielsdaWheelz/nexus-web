"use client";

import { useState } from "react";
import { Minus, Plus, Volume2 } from "lucide-react";
import Button from "@/components/ui/Button";
import { apiTransportFeedback, isApiError } from "@/lib/api/client";
import { formatClock } from "@/lib/formatClock";
import {
  formatPlaybackRate,
  PLAYBACK_RATE_MAX,
  PLAYBACK_RATE_MIN,
  PLAYBACK_RATE_PRESETS,
  PLAYBACK_RATE_STEP,
  snapPlaybackRate,
  stepPlaybackRate,
} from "@/lib/player/playbackRate";
import {
  usePlayerCommands,
  usePlayerSession,
  usePlayerTimeline,
  type PlayerState,
} from "@/lib/player/playerRuntime";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import styles from "./Player.module.css";

const same = (a: number, b: number) => Math.abs(a - b) < 0.0001;

export function PlaybackRateEditor({
  value,
  onChange,
  label,
  description,
}: {
  readonly value: number;
  readonly onChange: (value: number) => void;
  readonly label: string;
  readonly description?: string;
}) {
  return (
    <div className={styles.editor}>
      <div className={styles.summary}>
        <span className={styles.eyebrow}>{label}</span>
        <strong className={styles.rateValue}>
          {formatPlaybackRate(value)}
        </strong>
        {description ? (
          <span className={styles.eyebrow}>{description}</span>
        ) : null}
      </div>
      <div
        className={styles.presets}
        role="group"
        aria-label={`${label} presets`}
      >
        {PLAYBACK_RATE_PRESETS.map((preset) => (
          <Button
            key={preset}
            variant={same(value, preset) ? "primary" : "secondary"}
            size="sm"
            aria-pressed={same(value, preset)}
            onClick={() => onChange(preset)}
          >
            {formatPlaybackRate(preset)}
          </Button>
        ))}
      </div>
      <div className={styles.adjuster}>
        <Button
          variant="secondary"
          size="lg"
          iconOnly
          disabled={value <= PLAYBACK_RATE_MIN}
          aria-label={`Decrease ${label.toLocaleLowerCase()}`}
          onClick={() => onChange(stepPlaybackRate(value, -1))}
        >
          <Minus aria-hidden="true" />
        </Button>
        <input
          type="range"
          className={styles.rateRange}
          min={PLAYBACK_RATE_MIN}
          max={PLAYBACK_RATE_MAX}
          step={PLAYBACK_RATE_STEP}
          value={value}
          aria-label={label}
          aria-valuetext={
            same(value, 1)
              ? "Normal speed"
              : `${formatPlaybackRate(value).slice(0, -1)} times normal`
          }
          onChange={(event) =>
            onChange(snapPlaybackRate(Number(event.currentTarget.value)))
          }
        />
        <Button
          variant="secondary"
          size="lg"
          iconOnly
          disabled={value >= PLAYBACK_RATE_MAX}
          aria-label={`Increase ${label.toLocaleLowerCase()}`}
          onClick={() => onChange(stepPlaybackRate(value, 1))}
        >
          <Plus aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}

export function VolumeControl({
  state,
}: {
  state: Extract<PlayerState, { kind: "Loaded" }>;
}) {
  const commands = usePlayerCommands();
  return (
    <label className={styles.volume}>
      <Volume2 size={16} aria-hidden="true" />
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={state.volume}
        aria-label="Volume"
        onChange={(event) =>
          commands.setVolume(Number(event.currentTarget.value))
        }
      />
    </label>
  );
}

/** Speed, remember-for-podcast, pause shortening, chapters, and (mobile) volume. */
export function PlayerPanel() {
  const { state } = usePlayerSession();
  const { positionMs, durationMs } = usePlayerTimeline();
  const commands = usePlayerCommands();
  const isMobile = useIsMobileViewport();
  const [remembered, setRemembered] = useState<{
    rate: number;
    text: string;
  } | null>(null);
  if (state.kind !== "Loaded") return null;
  const episode =
    state.source.kind === "Episode" ? state.source.descriptor : null;
  const remember = async () => {
    const rate = state.rate;
    setRemembered({ rate, text: "Remembering…" });
    try {
      await commands.rememberPlaybackRateForPodcast();
      setRemembered({
        rate,
        text: `New episodes of ${episode?.subtitle.kind === "Present" ? episode.subtitle.value : "this podcast"} start at ${formatPlaybackRate(rate)}`,
      });
    } catch (error) {
      const failure = isApiError(error)
        ? apiTransportFeedback(error, "Playback speed wasn’t saved")
        : null;
      setRemembered({
        rate,
        text: failure?.message
          ? `${failure.title}. ${failure.message}`
          : "Playback speed wasn’t saved",
      });
    }
  };
  const pauses = state.shortenPauses;
  const scope =
    state.shortenPausesSession !== null
      ? "This session"
      : episode?.pauseShorteningMode.kind === "Present"
        ? "This podcast"
        : "Device default";

  return (
    <div className={styles.panel}>
      <PlaybackRateEditor
        value={state.rate}
        onChange={commands.setPlaybackRate}
        label="Playback speed"
        description={`About ${formatClock(Math.max(0, durationMs - positionMs) / state.rate / 1000)} remaining`}
      />
      {episode?.podcastId.kind === "Present" ? (
        <div className={styles.panelRow}>
          <Button
            variant="secondary"
            size="lg"
            onClick={() => void remember()}
            disabled={remembered?.text === "Remembering…"}
          >
            Remember {formatPlaybackRate(state.rate)} for this podcast
          </Button>
          {remembered ? (
            <p className={styles.eyebrow} role="status">
              {remembered.text}
            </p>
          ) : null}
        </div>
      ) : null}
      {pauses !== null && episode !== null ? (
        <section className={styles.panelRow} aria-label="Shorten pauses">
          <label className={styles.switch}>
            <input
              type="checkbox"
              role="switch"
              checked={pauses}
              onChange={(event) =>
                commands.setShortenPauses(event.currentTarget.checked)
              }
            />
            Shorten pauses
          </label>
          <p className={styles.eyebrow}>{scope}</p>
          {state.shortenPausesSession !== null ? (
            <div className={styles.panelActions}>
              <Button
                variant="secondary"
                size="lg"
                onClick={() => commands.setShortenPauses(null)}
              >
                Use default
              </Button>
              {state.shortenPausesDefault !== pauses ? (
                <Button
                  variant="secondary"
                  size="lg"
                  onClick={() => {
                    commands.setShortenPausesDefault(pauses);
                    commands.setShortenPauses(null);
                  }}
                >
                  Make default on this device
                </Button>
              ) : null}
            </div>
          ) : null}
          {state.shortenPausesSavedMs > 0 ? (
            <p className={styles.eyebrow}>
              Saved on this device ·{" "}
              {formatClock(state.shortenPausesSavedMs / 1000)}
            </p>
          ) : null}
        </section>
      ) : null}
      {episode !== null && episode.chapters.length > 0 ? (
        <section className={styles.panelRow} aria-label="Chapters">
          <ol className={styles.chapters}>
            {episode.chapters.map((chapter) => (
              <li key={`${chapter.startMs}:${chapter.title}`}>
                <Button
                  variant="ghost"
                  size="sm"
                  className={styles.chapter}
                  onClick={() => commands.seekTo(chapter.startMs)}
                >
                  <span>{chapter.title}</span>
                  <span className={styles.time}>
                    {formatClock(chapter.startMs / 1000)}
                  </span>
                </Button>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
      {isMobile ? <VolumeControl state={state} /> : null}
    </div>
  );
}
