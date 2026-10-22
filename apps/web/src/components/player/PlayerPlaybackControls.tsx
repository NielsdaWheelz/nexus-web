"use client";

import { useId } from "react";
import { Minus, Plus } from "lucide-react";
import Button from "@/components/ui/Button";
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
import styles from "./Player.module.css";
import collection from "@/components/ui/Collection.module.css";

const same = (a: number, b: number) => Math.abs(a - b) < 0.0001;

export function PlaybackRateEditor({
  value,
  onChange,
  label,
}: {
  readonly value: number;
  readonly onChange: (value: number) => void;
  readonly label: string;
}) {
  return (
    <div className={styles.editor}>
      <div className={styles.summary}>
        <span className={styles.eyebrow}>{label}</span>
        <strong className={styles.rateValue}>
          {formatPlaybackRate(value)}
        </strong>
      </div>
      <div
        className={styles.presets}
        role="group"
        aria-label={`${label} presets`}
      >
        {PLAYBACK_RATE_PRESETS.map((preset) => (
          <Button
            key={preset}
            size="comfortable"
            className={styles.preset}
            aria-pressed={same(value, preset)}
            onClick={() => onChange(preset)}
          >
            {formatPlaybackRate(preset)}
          </Button>
        ))}
      </div>
      <div className={styles.adjuster}>
        <Button
          size="comfortable"
          iconOnly
          icon={<Minus />}
          disabled={value <= PLAYBACK_RATE_MIN}
          aria-label={`Decrease ${label.toLocaleLowerCase()}`}
          onClick={() => onChange(stepPlaybackRate(value, -1))}
        />
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
          size="comfortable"
          iconOnly
          icon={<Plus />}
          disabled={value >= PLAYBACK_RATE_MAX}
          aria-label={`Increase ${label.toLocaleLowerCase()}`}
          onClick={() => onChange(stepPlaybackRate(value, 1))}
        />
      </div>
    </div>
  );
}

/** The caller owns capability, live effects and saved defaults. */
export function SkipSilenceField({
  checked,
  onChange,
  label,
}: {
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly label: string;
}) {
  const helpId = useId();
  return <label className={styles.silenceField}>
    <span className={styles.switch}>
      <input type="checkbox" aria-label={label} aria-describedby={helpId} checked={checked} onChange={event => onChange(event.currentTarget.checked)} />
      <span>{label}</span>
    </span>
    <span id={helpId} className={styles.eyebrow}>shorten quiet gaps between speech.</span>
  </label>;
}

/** Chapter navigation is shared by the desktop picker and now-playing sheet. */
export function ChapterList({ state, compact }: { readonly state: Extract<PlayerState, { kind: "Loaded" }>; readonly compact: boolean }) {
  const commands = usePlayerCommands();
  const { playbackSubject } = usePlayerSession();
  const { chapter: current } = usePlayerTimeline();
  if (state.source.kind !== "Episode") return null;
  return <ol className={compact ? collection.compactViewport : styles.chapters} data-collection-viewport={compact ? "" : undefined}>
    {state.source.descriptor.chapters.map(chapter => <li key={`${chapter.start_ms}:${chapter.title}`}>
      <button type="button" className={`${collection.row} ${styles.chapter}`} aria-current={current?.start_ms === chapter.start_ms ? "true" : undefined}
        disabled={playbackSubject === null} aria-disabled={playbackSubject === null || undefined} onClick={() => { if (playbackSubject !== null) commands.seekTo({ positionMs: chapter.start_ms, expectedSubject: playbackSubject }); }}>
        <span>{chapter.title}</span>
        <span className={styles.time}>{formatClock(chapter.start_ms / 1000)}</span>
      </button>
    </li>)}
  </ol>;
}
