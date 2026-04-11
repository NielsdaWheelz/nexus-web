"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import { useGlobalPlayer } from "@/lib/player/globalPlayer";
import {
  areAudioEffectsActive,
  type AudioEffectsVolumeBoost,
} from "@/lib/player/audioEffects";
import {
  countUpcomingQueueItems,
  type PlaybackQueueItem,
} from "@/lib/player/playbackQueueClient";
import SortableList from "@/components/sortable/SortableList";
import styles from "./GlobalPlayerFooter.module.css";

const SKIP_BACK_SECONDS = 15;
const SKIP_FORWARD_SECONDS = 30;
const SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3] as const;
const VOLUME_BOOST_OPTIONS: Array<{ value: AudioEffectsVolumeBoost; label: string }> = [
  { value: "off", label: "Off" },
  { value: "low", label: "Low (+3dB)" },
  { value: "medium", label: "Medium (+6dB)" },
  { value: "high", label: "High (+9dB)" },
];

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

function resolveCurrentChapter(
  chapters: NonNullable<ReturnType<typeof useGlobalPlayer>["track"]>["chapters"],
  currentSeconds: number
) {
  if (!chapters || chapters.length === 0) {
    return null;
  }
  const currentMs = Math.max(0, Math.floor(currentSeconds * 1000));
  let activeChapter = null;
  for (const chapter of chapters) {
    if (chapter.t_start_ms <= currentMs) {
      activeChapter = chapter;
      continue;
    }
    break;
  }
  return activeChapter;
}

function formatTimeSavedSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "0.0";
  }
  return seconds.toFixed(1);
}

export default function GlobalPlayerFooter() {
  const isMobile = useIsMobileViewport();
  const [queueOpen, setQueueOpen] = useState(false);
  const [effectsOpen, setEffectsOpen] = useState(false);
  const [mobileExpanded, setMobileExpanded] = useState(false);
  const {
    track,
    setTrack,
    bindAudioElement,
    isPlaying,
    isBuffering,
    playbackError,
    play,
    pause,
    retryPlayback,
    currentTimeSeconds,
    durationSeconds,
    bufferedSeconds,
    playbackRate,
    volume,
    audioEffects,
    setAudioEffects,
    audioEffectsAvailable,
    isSilenceTrimming,
    silenceTimeSavedSeconds,
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

  useEffect(() => {
    if (!mobileExpanded || !isMobile) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [mobileExpanded, isMobile]);

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
  const chapterMarkers =
    durationSafe > 0 && Array.isArray(track.chapters)
      ? track.chapters
          .map((chapter) => ({
            ...chapter,
            leftPercent: Math.max(
              0,
              Math.min(100, (chapter.t_start_ms / 1000 / durationSafe) * 100)
            ),
          }))
          .filter((chapter) => Number.isFinite(chapter.leftPercent))
      : [];
  const currentChapter = resolveCurrentChapter(track.chapters ?? [], currentSafe);

  const onSeek = (nextValue: number) => {
    if (durationSafe <= 0) {
      return;
    }
    const clampedSeconds = Math.max(0, Math.min(durationSafe, nextValue));
    seekToMs(Math.floor(clampedSeconds * 1000));
  };

  const speedValue = SPEED_OPTIONS.includes(playbackRate as (typeof SPEED_OPTIONS)[number])
    ? playbackRate
    : 1;
  const upcomingCount = countUpcomingQueueItems(queueItems, track.media_id);
  const hasActiveAudioEffects = areAudioEffectsActive(audioEffects);

  const handleQueueItemPlay = (item: PlaybackQueueItem) => {
    setTrack(
      {
        media_id: item.media_id,
        title: item.title,
        stream_url: item.stream_url,
        source_url: item.source_url,
        podcast_title: item.podcast_title ?? undefined,
        image_url: item.image_url ?? undefined,
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

  const closeMobileExpanded = () => {
    setMobileExpanded(false);
    setQueueOpen(false);
    setEffectsOpen(false);
  };

  return (
    <footer
      className={styles.footer}
      role="contentinfo"
      aria-label="Global player footer"
      data-mobile-view={isMobile ? (mobileExpanded ? "expanded" : "minibar") : undefined}
    >
      {isMobile ? (
        <>
          {/* Mini progress bar at top edge */}
          <div
            className={styles.miniProgressBar}
            style={{ "--progress-percent": `${progressPercent}%` } as CSSProperties}
            aria-hidden="true"
          />

          {/* Compact mini-bar */}
          <div className={styles.miniBar}>
            <button
              type="button"
              className={styles.miniTapArea}
              onClick={() => setMobileExpanded(true)}
              aria-label="Expand player"
            >
              {track.image_url ? (
                <img src={track.image_url} alt="" className={styles.miniArtwork} />
              ) : (
                <div className={styles.miniArtworkFallback} aria-hidden="true" />
              )}
              <span className={styles.miniTitle}>{track.title}</span>
            </button>
            <button
              type="button"
              className={styles.transportButton}
              onClick={isPlaying ? pause : play}
              aria-label={isPlaying ? "Pause" : "Play"}
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
          </div>

          {/* Expanded bottom sheet */}
          {mobileExpanded && (
            <div className={styles.expandedBackdrop} onClick={closeMobileExpanded}>
              <section
                className={styles.expandedSheet}
                role="dialog"
                aria-modal="true"
                aria-label="Expanded player"
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  if (e.key === "Escape") closeMobileExpanded();
                }}
              >
                <div className={styles.expandedHandle} aria-hidden="true" />
                <button
                  type="button"
                  className={styles.expandedClose}
                  onClick={closeMobileExpanded}
                  aria-label="Collapse player"
                >
                  Close
                </button>

                {track.image_url ? (
                  <img src={track.image_url} alt={track.title} className={styles.expandedArtwork} />
                ) : (
                  <div className={styles.expandedArtworkFallback} aria-hidden="true" />
                )}

                <div className={styles.expandedMeta}>
                  <a href={`/media/${track.media_id}`} className={styles.trackLink}>
                    {track.title}
                  </a>
                  {currentChapter && (
                    <span className={styles.chapterLabel}>
                      Chapter {currentChapter.chapter_idx + 1}: {currentChapter.title}
                    </span>
                  )}
                </div>

                <div className={styles.seekArea}>
                  <div className={styles.seekTrack} style={seekTrackStyle} aria-hidden="true" />
                  {chapterMarkers.length > 0 && (
                    <div className={styles.chapterTicks} aria-hidden="true">
                      {chapterMarkers.map((chapter) => (
                        <span
                          key={`${chapter.chapter_idx}-${chapter.t_start_ms}`}
                          className={styles.chapterTick}
                          style={{ left: `${chapter.leftPercent}%` }}
                          title={chapter.title}
                        />
                      ))}
                    </div>
                  )}
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

                {playbackError ? (
                  <div className={styles.playbackErrorArea} role="status" aria-live="polite">
                    <span className={styles.playbackErrorMessage}>{playbackError.message}</span>
                    <button
                      type="button"
                      className={styles.playbackErrorAction}
                      onClick={retryPlayback}
                      aria-label="Retry playback"
                    >
                      Retry
                    </button>
                    <a
                      href={track.source_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={styles.playbackErrorLink}
                      aria-label="Open source audio"
                    >
                      Open source
                    </a>
                  </div>
                ) : (
                  <span className={styles.timecode}>
                    {isBuffering && (
                      <span className={styles.bufferingIndicator} role="status" aria-live="polite">
                        <span className={styles.bufferingDot} aria-hidden="true" />
                        Buffering...
                      </span>
                    )}
                    {formatClock(currentSafe)} / {formatClock(durationSafe)}
                  </span>
                )}

                <div className={styles.expandedTransport}>
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
                    aria-label={isPlaying ? "Pause" : "Play"}
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
                </div>

                <div className={styles.expandedSecondary}>
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

                  <button
                    type="button"
                    className={styles.effectsButton}
                    aria-label="Audio effects"
                    aria-expanded={effectsOpen}
                    data-active={hasActiveAudioEffects ? "true" : "false"}
                    onClick={() => setEffectsOpen((previous) => !previous)}
                  >
                    Effects
                    <span className={styles.effectsIndicator} aria-hidden="true" />
                  </button>

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

                {effectsOpen && (
                  <section className={styles.effectsPanel} aria-label="Audio effects panel">
                    {!audioEffectsAvailable && (
                      <p className={styles.effectsUnavailable}>Audio effects unavailable for this source.</p>
                    )}

                    <label className={styles.effectsToggle}>
                      <input
                        type="checkbox"
                        aria-label="Silence trimming"
                        checked={audioEffects.silenceTrim}
                        disabled={!audioEffectsAvailable}
                        onChange={(event) => {
                          setAudioEffects({ silenceTrim: event.currentTarget.checked });
                        }}
                      />
                      <span>Silence trimming</span>
                    </label>

                    <label className={styles.effectsSelectControl}>
                      <span className={styles.controlLabel}>Volume boost</span>
                      <select
                        aria-label="Volume boost"
                        value={audioEffects.volumeBoost}
                        disabled={!audioEffectsAvailable}
                        onChange={(event) => {
                          setAudioEffects({
                            volumeBoost: event.currentTarget.value as AudioEffectsVolumeBoost,
                          });
                        }}
                        className={styles.select}
                      >
                        {VOLUME_BOOST_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label className={styles.effectsToggle}>
                      <input
                        type="checkbox"
                        aria-label="Mono audio"
                        checked={audioEffects.mono}
                        disabled={!audioEffectsAvailable}
                        onChange={(event) => {
                          setAudioEffects({ mono: event.currentTarget.checked });
                        }}
                      />
                      <span>Mono audio</span>
                    </label>

                    <p className={styles.effectsMeta}>Time saved: {formatTimeSavedSeconds(silenceTimeSavedSeconds)}s</p>
                    {isSilenceTrimming && <span className={styles.trimmingBadge}>Trimming silence</span>}
                  </section>
                )}
              </section>
            </div>
          )}
        </>
      ) : (
        <>
          {/* Desktop: full footer layout */}
          <div className={styles.metaRow}>
            {track.image_url && (
              <img src={track.image_url} alt="" className={styles.desktopArtwork} />
            )}
            <span className={styles.kicker}>Now playing</span>
            <div className={styles.metaText}>
              <a href={`/media/${track.media_id}`} className={styles.trackLink}>
                {track.title}
              </a>
              {currentChapter && (
                <span className={styles.chapterLabel}>
                  Chapter {currentChapter.chapter_idx + 1}: {currentChapter.title}
                </span>
              )}
            </div>
          </div>

          <div
            className={styles.controlsRow}
            role="group"
            aria-label="Global player controls"
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
              {chapterMarkers.length > 0 && (
                <div className={styles.chapterTicks} aria-hidden="true">
                  {chapterMarkers.map((chapter) => (
                    <span
                      key={`${chapter.chapter_idx}-${chapter.t_start_ms}`}
                      className={styles.chapterTick}
                      style={{ left: `${chapter.leftPercent}%` }}
                      title={chapter.title}
                    />
                  ))}
                </div>
              )}
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

            {playbackError ? (
              <div className={styles.playbackErrorArea} role="status" aria-live="polite">
                <span className={styles.playbackErrorMessage}>{playbackError.message}</span>
                <button
                  type="button"
                  className={styles.playbackErrorAction}
                  onClick={retryPlayback}
                  aria-label="Retry playback"
                >
                  Retry
                </button>
                <a
                  href={track.source_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={styles.playbackErrorLink}
                  aria-label="Open source audio"
                >
                  Open source
                </a>
              </div>
            ) : (
              <span className={styles.timecode}>
                {isBuffering && (
                  <span className={styles.bufferingIndicator} role="status" aria-live="polite">
                    <span className={styles.bufferingDot} aria-hidden="true" />
                    Buffering...
                  </span>
                )}
                {formatClock(currentSafe)} / {formatClock(durationSafe)}
              </span>
            )}

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

            <button
              type="button"
              className={styles.effectsButton}
              aria-label="Audio effects"
              aria-expanded={effectsOpen}
              data-active={hasActiveAudioEffects ? "true" : "false"}
              onClick={() => setEffectsOpen((previous) => !previous)}
            >
              Effects
              <span className={styles.effectsIndicator} aria-hidden="true" />
            </button>

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

          {effectsOpen && (
            <section className={styles.effectsPanel} aria-label="Audio effects panel">
              {!audioEffectsAvailable && (
                <p className={styles.effectsUnavailable}>Audio effects unavailable for this source.</p>
              )}

              <label className={styles.effectsToggle}>
                <input
                  type="checkbox"
                  aria-label="Silence trimming"
                  checked={audioEffects.silenceTrim}
                  disabled={!audioEffectsAvailable}
                  onChange={(event) => {
                    setAudioEffects({ silenceTrim: event.currentTarget.checked });
                  }}
                />
                <span>Silence trimming</span>
              </label>

              <label className={styles.effectsSelectControl}>
                <span className={styles.controlLabel}>Volume boost</span>
                <select
                  aria-label="Volume boost"
                  value={audioEffects.volumeBoost}
                  disabled={!audioEffectsAvailable}
                  onChange={(event) => {
                    setAudioEffects({
                      volumeBoost: event.currentTarget.value as AudioEffectsVolumeBoost,
                    });
                  }}
                  className={styles.select}
                >
                  {VOLUME_BOOST_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className={styles.effectsToggle}>
                <input
                  type="checkbox"
                  aria-label="Mono audio"
                  checked={audioEffects.mono}
                  disabled={!audioEffectsAvailable}
                  onChange={(event) => {
                    setAudioEffects({ mono: event.currentTarget.checked });
                  }}
                />
                <span>Mono audio</span>
              </label>

              <p className={styles.effectsMeta}>Time saved: {formatTimeSavedSeconds(silenceTimeSavedSeconds)}s</p>
              {isSilenceTrimming && <span className={styles.trimmingBadge}>Trimming silence</span>}
            </section>
          )}
        </>
      )}

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
