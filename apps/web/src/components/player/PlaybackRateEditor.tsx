"use client";

import { nearestRateIndex, PLAYBACK_RATES, presentPlaybackRate } from "@/lib/player/playbackRate";
import * as Icon from "@/lib/ui/icons";
import styles from "./PlaybackRateEditor.module.css";

/** The caller owns the requested or saved value. Opening never snaps a retained rate. */
export default function PlaybackRateEditor({ value, onChange, label }: {
  readonly value: number;
  readonly onChange: (value: number) => void;
  readonly label: string;
}) {
  const shown = presentPlaybackRate(value);
  return <div className={styles.editor}>
    <div className={styles.summary}>
      <span aria-hidden="true"><Icon.Speed size={56} rate={shown.rate} className={styles.dial} /></span>
      <div><div className={styles.eyebrow}>{label}</div><strong className={styles.rateValue}>{shown.label}</strong></div>
    </div>
    <div>
      <input type="range" className={styles.rateRange} min={0} max={PLAYBACK_RATES.length - 1} step={1}
        value={nearestRateIndex(value)} aria-label={label} aria-valuetext={shown.label}
        onChange={event => onChange(PLAYBACK_RATES[Number(event.currentTarget.value)])} />
      <div className={styles.stops}>
        {PLAYBACK_RATES.map(rate => <button key={rate} type="button" tabIndex={-1}
          aria-label={`${rate}×`} aria-pressed={value === rate} onClick={() => onChange(rate)}>{rate}</button>)}
      </div>
    </div>
  </div>;
}
