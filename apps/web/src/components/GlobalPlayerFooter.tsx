"use client";

import { useEffect, useState, type CSSProperties, type KeyboardEvent } from "react";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import { useGlobalPlayer } from "@/lib/player/globalPlayer";
import {
  countUpcomingQueueItems,
  type PlaybackQueueItem,
} from "@/lib/player/playbackQueueClient";
import SortableList from "@/components/sortable/SortableList";
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
  const [queueOpen, setQueueOpen] = useState(false);
  const {
    track,
    setTrack,
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
    queueItems,
    refreshQueue,
    removeFromQueue,
    reorderQueue,
    clearQueue,
    playNextInQueue,
    playPreviousInQueue,
    hasNextInQueue,
  } = useGlobalPlayer();

  useEffect(() => {
    if (!queueOpen || !track) {
      return;
    }
    void refreshQueue();
  }, [queueOpen, refreshQueue, track]);

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
  const upcomingCount = countUpcomingQueueItems(queueItems, track.media_id);

  const handleQueueItemPlay = (item: PlaybackQueueItem) => {
    setTrack(
      {
        media_id: item.media_id,
        title: item.title,
        stream_url: item.stream_url,
        source_url: item.source_url,
      },
      {
        autoplay: true,
        seek_seconds:
          item.listening_state != null ? Math.floor(item.listening_state.position_ms / 1000) : undefined,
        playback_rate: item.listening_state?.playback_speed,
      }
    );
    setQueueOpen(false);
  };

  const handleQueueReorder = (nextItems: PlaybackQueueItem[]) => {
    void reorderQueue(nextItems.map((item) => item.item_id));
  };

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
          onClick={() => void playPreviousInQueue()}
          aria-label="Previous in queue"
        >
          ⏮
        </button>

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

        <button
          type="button"
          className={styles.transportButton}
          onClick={() => void playNextInQueue()}
          aria-label="Next in queue"
          disabled={!hasNextInQueue}
        >
          ⏭
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

        <button
          type="button"
          className={styles.queueButton}
          onClick={() => setQueueOpen(true)}
          aria-label={`Open playback queue (${upcomingCount} upcoming)`}
        >
          Queue
          <span className={styles.queueBadge}>{upcomingCount}</span>
        </button>
      </div>

      <audio
        ref={bindAudioElement}
        preload="none"
        src={track.stream_url}
        className={styles.hiddenAudio}
        aria-label="Global podcast player"
      />

      {queueOpen && (
        <div className={styles.queueOverlay}>
          <section className={styles.queuePanel} role="dialog" aria-label="Playback queue panel">
            <header className={styles.queueHeader}>
              <h2 className={styles.queueTitle}>Playback queue</h2>
              <button
                type="button"
                className={styles.queueCloseButton}
                onClick={() => setQueueOpen(false)}
                aria-label="Close playback queue"
              >
                Close
              </button>
            </header>

            {queueItems.length === 0 ? (
              <p className={styles.queueEmpty}>Queue is empty.</p>
            ) : (
              <SortableList
                className={styles.queueList}
                itemClassName={styles.queueListItem}
                items={queueItems}
                getItemId={(item) => item.item_id}
                onReorder={handleQueueReorder}
                renderItem={({ item, handleProps }) => {
                  const isCurrent = item.media_id === track.media_id;
                  return (
                    <div className={styles.queueListItemInner} data-current={isCurrent ? "true" : "false"}>
                      <button
                        type="button"
                        className={styles.queueDragHandle}
                        aria-label={`Reorder ${item.title}`}
                        {...handleProps.attributes}
                        {...handleProps.listeners}
                      >
                        ⋮⋮
                      </button>
                      <button
                        type="button"
                        className={styles.queueItemMain}
                        onClick={() => handleQueueItemPlay(item)}
                        aria-label={`Play ${item.title} from queue`}
                      >
                        <span className={styles.queueItemTitle}>{item.title}</span>
                        <span className={styles.queueItemMeta}>
                          {item.podcast_title ?? "Unknown podcast"}
                        </span>
                      </button>
                      <button
                        type="button"
                        className={styles.queueItemRemoveButton}
                        aria-label={`Remove ${item.title} from queue`}
                        onClick={() => {
                          void removeFromQueue(item.item_id);
                        }}
                      >
                        Remove
                      </button>
                    </div>
                  );
                }}
              />
            )}

            <footer className={styles.queueFooter}>
              <button
                type="button"
                className={styles.queueClearButton}
                aria-label="Clear queue"
                onClick={() => {
                  void clearQueue();
                }}
              >
                Clear queue
              </button>
            </footer>
          </section>
        </div>
      )}
    </footer>
  );
}
