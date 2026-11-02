"use client";

import { Minus, Plus } from "lucide-react";
import Button from "@/components/ui/Button";
import {
  formatPlaybackRate,
  PLAYBACK_RATE_MAX,
  PLAYBACK_RATE_MIN,
  PLAYBACK_RATE_PRESETS,
  PLAYBACK_RATE_STEP,
  snapPlaybackRate,
  stepPlaybackRate,
} from "@/lib/player/playbackRate";
import styles from "./PlaybackRateEditor.module.css";

const same = (a: number, b: number) => Math.abs(a - b) < 0.0001;

/** The field alone: the caller owns what the value applies to and whether it is saved. */
export default function PlaybackRateEditor({
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
