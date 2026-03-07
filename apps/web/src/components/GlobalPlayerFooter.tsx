"use client";

import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import { useGlobalPlayer } from "@/lib/player/globalPlayer";
import styles from "./GlobalPlayerFooter.module.css";

function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "00:00";
  }
  const rounded = Math.floor(seconds);
  const minutes = Math.floor(rounded / 60);
  const remaining = rounded % 60;
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
  } = useGlobalPlayer();

  if (!track) {
    return null;
  }

  return (
    <footer
      className={styles.footer}
      role="contentinfo"
      aria-label="Global player footer"
      data-mobile={isMobile ? "true" : "false"}
    >
      <div className={styles.meta}>
        <span className={styles.kicker}>Now playing</span>
        <a href={`/media/${track.media_id}`} className={styles.trackLink}>
          {track.title}
        </a>
        <span className={styles.timecode}>
          {formatClock(currentTimeSeconds)} / {formatClock(durationSeconds)}
        </span>
      </div>

      <button
        type="button"
        className={styles.playPause}
        onClick={isPlaying ? pause : play}
        aria-label={isPlaying ? "Pause global player" : "Play global player"}
      >
        {isPlaying ? "Pause" : "Play"}
      </button>

      <audio
        ref={bindAudioElement}
        controls
        preload="none"
        src={track.stream_url}
        className={styles.player}
        aria-label="Global podcast player"
      />
    </footer>
  );
}
