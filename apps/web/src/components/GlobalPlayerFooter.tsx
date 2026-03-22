"use client";

import { type CSSProperties, type KeyboardEvent } from "react";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import { useGlobalPlayer } from "@/lib/player/globalPlayer";
import styles from "./GlobalPlayerFooter.module.css";

const SKIP_BACK_SECONDS = 15;
const SKIP_FORWARD_SECONDS = 30;
const SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3] as const;

function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "00:00";
  }
  const rounded = Math.floor(seconds);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const remaining = rounded % 60;
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${remaining
      .toString()
      .padStart(2, "0")}`;
  }
  return `${minutes.toString().padStart(2, "0")}:${remaining.toString().padStart(2, "0")}`;
}

export default function GlobalPlayerFooter() {
  const isMobile = useIsMobileViewport();
  const {
    track,
    bindAudioElement,
    isPlaying,
    play,
    pause,
    currentTimeSeconds,
    durationSeconds,
    bufferedSeconds,
    playbackRate,
    volume,
    seekToMs,
    skipBySeconds,
    setPlaybackRate,
    setVolume,
  } = useGlobalPlayer();

  if (!track) {
    return null;
  }

  const durationSafe = Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : 0;
  const currentSafe = Math.max(0, currentTimeSeconds);
  const bufferedSafe = Math.max(0, bufferedSeconds);
  const progressPercent = durationSafe > 0 ? Math.min(100, (currentSafe / durationSafe) * 100) : 0;
  const bufferedPercent =
    durationSafe > 0 ? Math.min(100, (bufferedSafe / durationSafe) * 100) : 0;
  const seekSliderValue = durationSafe > 0 ? Math.min(durationSafe, currentSafe) : 0;
  const seekTrackStyle = {
    "--progress-percent": `${progressPercent}%`,
    "--buffered-percent": `${Math.max(progressPercent, bufferedPercent)}%`,
  } as CSSProperties;

  const onSeek = (nextValue: number) => {
    if (durationSafe <= 0) {
      return;
    }
    const clampedSeconds = Math.max(0, Math.min(durationSafe, nextValue));
    seekToMs(Math.floor(clampedSeconds * 1000));
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      skipBySeconds(-SKIP_BACK_SECONDS);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      skipBySeconds(SKIP_FORWARD_SECONDS);
    }
  };

  const speedValue = SPEED_OPTIONS.includes(playbackRate as (typeof SPEED_OPTIONS)[number])
    ? playbackRate
    : 1;

  return (
    <footer
      className={styles.footer}
      role="contentinfo"
      aria-label="Global player footer"
      data-mobile={isMobile ? "true" : "false"}
    >
      <div className={styles.metaRow}>
        <span className={styles.kicker}>Now playing</span>
        <a href={`/media/${track.media_id}`} className={styles.trackLink}>
          {track.title}
        </a>
      </div>

      <div
        className={styles.controlsRow}
        role="group"
        aria-label="Global player controls"
        tabIndex={0}
        onKeyDown={handleKeyDown}
      >
        <button
          type="button"
          className={styles.transportButton}
          onClick={() => skipBySeconds(-SKIP_BACK_SECONDS)}
          aria-label="Back 15 seconds"
        >
          ◄◄ 15s
        </button>

        <button
          type="button"
          className={styles.transportButton}
          onClick={isPlaying ? pause : play}
          aria-label={isPlaying ? "Pause global player" : "Play global player"}
        >
          {isPlaying ? "Pause" : "Play"}
        </button>

        <button
          type="button"
          className={styles.transportButton}
          onClick={() => skipBySeconds(SKIP_FORWARD_SECONDS)}
          aria-label="Forward 30 seconds"
        >
          30s ►►
        </button>

        <div className={styles.seekArea}>
          <div className={styles.seekTrack} style={seekTrackStyle} aria-hidden="true" />
          <input
            type="range"
            min={0}
            max={durationSafe}
            step={1}
            value={seekSliderValue}
            onInput={(event) => onSeek(Number(event.currentTarget.value))}
            onChange={(event) => onSeek(Number(event.currentTarget.value))}
            className={styles.seekSlider}
            aria-label="Seek playback position"
            disabled={durationSafe <= 0}
          />
        </div>

        <span className={styles.timecode}>
          {formatClock(currentSafe)} / {formatClock(durationSafe)}
        </span>

        <label className={styles.speedControl}>
          <span className={styles.controlLabel}>Speed</span>
          <select
            aria-label="Playback speed"
            value={speedValue.toString()}
            onChange={(event) => setPlaybackRate(Number(event.currentTarget.value))}
            className={styles.select}
          >
            {SPEED_OPTIONS.map((option) => (
              <option key={option} value={option.toString()}>
                {option.toFixed(option % 1 === 0 ? 0 : 2)}x
              </option>
            ))}
          </select>
        </label>

        {!isMobile && (
          <label className={styles.volumeControl}>
            <span className={styles.controlLabel}>Volume</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={volume}
              onInput={(event) => setVolume(Number(event.currentTarget.value))}
              onChange={(event) => setVolume(Number(event.currentTarget.value))}
              className={styles.volumeSlider}
              aria-label="Volume"
            />
          </label>
        )}
      </div>

      <audio
        ref={bindAudioElement}
        preload="none"
        src={track.stream_url}
        className={styles.hiddenAudio}
        aria-label="Global podcast player"
      />
    </footer>
  );
}
