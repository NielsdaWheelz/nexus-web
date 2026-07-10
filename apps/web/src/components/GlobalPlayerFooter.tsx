"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { formatClock } from "@/lib/formatClock";
import { useDismissOnOutsideOrEscape } from "@/lib/ui/useDismissOnOutsideOrEscape";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import { isPositiveFinite } from "@/lib/validation";
import {
  PLAYER_SKIP_BACK_SECONDS,
  PLAYER_SKIP_FORWARD_SECONDS,
  useGlobalPlayer,
} from "@/lib/player/globalPlayer";
import {
  SUBSCRIPTION_PLAYBACK_SPEED_OPTIONS,
  formatPlaybackSpeedLabel,
} from "@/lib/player/subscriptionPlaybackSpeed";
import {
  areAudioEffectsActive,
  normalizeVolumeBoostLevel,
  type AudioEffectsVolumeBoost,
} from "@/lib/player/audioEffects";
import { useBillingAccount } from "@/lib/billing/useBillingAccount";
import { useWalknoteSession } from "@/lib/walknotes/walknoteSession";
import { useVoiceRecorder } from "@/lib/walknotes/useVoiceRecorder";
import { transcribeAudio } from "@/lib/walknotes/transcribeAudio";
import MediaImage from "@/components/ui/MediaImage";
import MobileSheet from "@/components/ui/MobileSheet";
import GlobalPlayerConsumptionPanel from "@/components/GlobalPlayerConsumptionPanel";
import { requestOpenInAppPane } from "@/lib/panes/openInAppPane";
import WalknoteReviewPanel from "@/components/walknotes/WalknoteReviewPanel";
import Button from "@/components/ui/Button";
import Select from "@/components/ui/Select";
import styles from "./GlobalPlayerFooter.module.css";

const MARK_HOLD_THRESHOLD_MS = 500;

const VOLUME_BOOST_OPTIONS: Array<{ value: AudioEffectsVolumeBoost; label: string }> = [
  { value: "off", label: "Off" },
  { value: "low", label: "Low (+3dB)" },
  { value: "medium", label: "Medium (+6dB)" },
  { value: "high", label: "High (+9dB)" },
];

function EffectsPanel({
  audioEffects,
  audioEffectsAvailable,
  setAudioEffects,
  silenceTimeSavedSeconds,
  isSilenceTrimming,
}: {
  audioEffects: ReturnType<typeof useGlobalPlayer>["audioEffects"];
  audioEffectsAvailable: boolean;
  setAudioEffects: ReturnType<typeof useGlobalPlayer>["setAudioEffects"];
  silenceTimeSavedSeconds: number;
  isSilenceTrimming: boolean;
}) {
  return (
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
        <Select
          size="sm"
          aria-label="Volume boost"
          value={audioEffects.volumeBoost}
          disabled={!audioEffectsAvailable}
          onChange={(event) => {
            setAudioEffects({
              volumeBoost: normalizeVolumeBoostLevel(event.currentTarget.value),
            });
          }}
          className={styles.select}
        >
          {VOLUME_BOOST_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
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

      <p className={styles.effectsMeta}>Time saved: {isPositiveFinite(silenceTimeSavedSeconds) ? silenceTimeSavedSeconds.toFixed(1) : "0.0"}s</p>
      {isSilenceTrimming && <span className={styles.trimmingBadge}>Trimming silence</span>}
    </section>
  );
}

function PlaybackErrorOrTimecode({
  playbackError,
  retryPlayback,
  sourceUrl,
  isBuffering,
  currentSafe,
  durationSafe,
}: {
  playbackError: { message: string } | null;
  retryPlayback: () => void;
  sourceUrl: string;
  isBuffering: boolean;
  currentSafe: number;
  durationSafe: number;
}) {
  if (playbackError) {
    return (
      <div className={styles.playbackErrorArea} role="status" aria-live="polite">
        <span className={styles.playbackErrorMessage}>{playbackError.message}</span>
        <Button
          variant="secondary"
          size="sm"
          className={styles.playbackErrorAction}
          onClick={retryPlayback}
          aria-label="Retry playback"
        >
          Retry
        </Button>
        <a
          href={sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          className={styles.playbackErrorLink}
          aria-label="Open source audio"
        >
          Open source
        </a>
      </div>
    );
  }
  return (
    <span className={styles.timecode}>
      {isBuffering && (
        <span className={styles.bufferingIndicator} role="status" aria-live="polite">
          <span className={styles.bufferingDot} aria-hidden="true" />
          Buffering...
        </span>
      )}
      {formatClock(currentSafe)} / {formatClock(durationSafe)}
    </span>
  );
}

export default function GlobalPlayerFooter() {
  const isMobile = useIsMobileViewport();
  const [queueOpen, setQueueOpen] = useState(false);
  const [effectsOpen, setEffectsOpen] = useState(false);
  const [mobileExpanded, setMobileExpanded] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [walknoteReviewOpen, setWalknoteReviewOpen] = useState(false);
  const morePopoverRef = useRef<HTMLDivElement>(null);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const miniExpandButtonRef = useRef<HTMLButtonElement>(null);
  const markButtonDesktopRef = useRef<HTMLButtonElement>(null);
  const markButtonMobileRef = useRef<HTMLButtonElement>(null);

  const {
    track,
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
    currentChapter,
    chapterMarkers,
    selectedPlaybackRateOption,
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
    refreshQueue,
    playNextInQueue,
    playPreviousInQueue,
    hasNextInQueue,
  } = useGlobalPlayer();
  const trackMediaId = track?.media_id ?? null;

  const { account } = useBillingAccount();
  const canTranscribe = account?.can_transcribe ?? false;

  const { waypoints, addWaypoint, updateWaypointVoice } = useWalknoteSession();
  const waypointCount = waypoints.length;

  const voiceRecorder = useVoiceRecorder();
  const [isRecording, setIsRecording] = useState(false);
  const [liveStatus, setLiveStatus] = useState("");

  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdFiredRef = useRef(false);
  const recordingWaypointIdRef = useRef<string | null>(null);
  const pointerDownCaptureRef = useRef<{ mediaId: string; posMs: number } | null>(null);

  useEffect(() => {
    if (!queueOpen || !trackMediaId) {
      return;
    }
    void refreshQueue();
  }, [queueOpen, refreshQueue, trackMediaId]);

  const closeMobileExpanded = () => {
    setMobileExpanded(false);
    setQueueOpen(false);
    setEffectsOpen(false);
  };

  useDismissOnOutsideOrEscape({
    enabled: moreOpen,
    refs: [morePopoverRef, moreButtonRef],
    onDismiss: () => {
      setMoreOpen(false);
    },
  });

  const handleMarkPointerDown = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      if (!track) return;
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // setPointerCapture may throw in test environments without an active pointer
      }

      const posMs = Math.floor(currentTimeSeconds * 1000);
      const mediaId = track.media_id;
      pointerDownCaptureRef.current = { mediaId, posMs };
      holdFiredRef.current = false;

      if (holdTimerRef.current !== null) {
        clearTimeout(holdTimerRef.current);
      }

      holdTimerRef.current = setTimeout(() => {
        holdFiredRef.current = true;
        holdTimerRef.current = null;

        if (!canTranscribe) {
          // voice disabled — no recording but continue to tap on release
          return;
        }

        const waypointId = addWaypoint(mediaId, posMs);
        recordingWaypointIdRef.current = waypointId;
        updateWaypointVoice(waypointId, "recording");
        setIsRecording(true);
        setLiveStatus("Recording");

        void voiceRecorder.start().catch(() => {
          if (recordingWaypointIdRef.current === waypointId) {
            updateWaypointVoice(waypointId, "failed");
            setIsRecording(false);
            recordingWaypointIdRef.current = null;
            setLiveStatus("Transcription failed");
          }
        });
      }, MARK_HOLD_THRESHOLD_MS);
    },
    [track, currentTimeSeconds, canTranscribe, addWaypoint, updateWaypointVoice, voiceRecorder]
  );

  const handleMarkPointerUp = useCallback(() => {
    if (!holdFiredRef.current) {
      // Tap path
      if (holdTimerRef.current !== null) {
        clearTimeout(holdTimerRef.current);
        holdTimerRef.current = null;
      }
      const capture = pointerDownCaptureRef.current;
      if (capture) {
        addWaypoint(capture.mediaId, capture.posMs);
      }
      return;
    }

    // Hold path — check if we started recording
    const waypointId = recordingWaypointIdRef.current;
    if (!waypointId) {
      // Hold fired but recording was disabled (canTranscribe=false); fall back to tap-only
      const capture = pointerDownCaptureRef.current;
      if (capture) addWaypoint(capture.mediaId, capture.posMs);
      return;
    }
    if (!isRecording) return;

    recordingWaypointIdRef.current = null;
    setIsRecording(false);

    void (async () => {
      try {
        const { blob } = await voiceRecorder.stop();
        updateWaypointVoice(waypointId, "transcribing");
        setLiveStatus("Transcribing");
        const text = await transcribeAudio(blob);
        updateWaypointVoice(waypointId, "done", text);
        setLiveStatus("");
      } catch {
        updateWaypointVoice(waypointId, "failed");
        setLiveStatus("Transcription failed");
      }
    })();
  }, [isRecording, voiceRecorder, addWaypoint, updateWaypointVoice]);

  const handleMarkPointerCancel = useCallback(() => {
    if (holdTimerRef.current !== null) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
    // If recording was started, stop silently (no waypoint without a valid stop)
    if (isRecording && recordingWaypointIdRef.current) {
      const waypointId = recordingWaypointIdRef.current;
      recordingWaypointIdRef.current = null;
      setIsRecording(false);
      void voiceRecorder.stop().then(({ blob }) => {
        updateWaypointVoice(waypointId, "transcribing");
        setLiveStatus("Transcribing");
        return transcribeAudio(blob);
      }).then((text) => {
        updateWaypointVoice(waypointId, "done", text);
        setLiveStatus("");
      }).catch(() => {
        updateWaypointVoice(waypointId, "failed");
        setLiveStatus("Transcription failed");
      });
    }
  }, [isRecording, voiceRecorder, updateWaypointVoice]);

  if (!track) {
    return null;
  }

  const durationSafe = isPositiveFinite(durationSeconds) ? durationSeconds : 0;
  const currentSafe = Math.max(0, currentTimeSeconds);
  const bufferedSafe = Math.max(0, bufferedSeconds);
  const progressPercent = durationSafe > 0 ? Math.min(100, (currentSafe / durationSafe) * 100) : 0;
  const bufferedPercent =
    durationSafe > 0 ? Math.min(100, (bufferedSafe / durationSafe) * 100) : 0;
  const seekSliderValue = durationSafe > 0 ? Math.min(durationSafe, currentSafe) : 0;
  const artworkUrl = track.image_url;
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

  const hasActiveAudioEffects = areAudioEffectsActive(audioEffects);
  const getQueueReturnFocusTarget = () =>
    isMobile ? miniExpandButtonRef.current : moreButtonRef.current;
  const openQueueFromMobileExpanded = () => {
    // On mobile the Lectern pane IS the queue surface; the audio-only panel is
    // desktop-only (D-4).
    miniExpandButtonRef.current?.focus();
    setMobileExpanded(false);
    requestOpenInAppPane("/lectern", { titleHint: "Lectern" });
  };
  const openQueueFromDesktopMore = () => {
    moreButtonRef.current?.focus();
    setMoreOpen(false);
    setQueueOpen(true);
  };
  const getWalknoteReviewReturnFocusTarget = () =>
    isMobile ? markButtonMobileRef.current : markButtonDesktopRef.current;

  return (
    <footer
      className={styles.footer}
      role="contentinfo"
      aria-label="Global player footer"
      data-mobile-view={isMobile ? (mobileExpanded ? "expanded" : "minibar") : undefined}
    >
      {/* Aria-live region for walknote status announcements */}
      <span
        role="status"
        aria-live="polite"
        className={styles.srOnly}
      >
        {liveStatus}
      </span>

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
            <Button
              ref={miniExpandButtonRef}
              variant="ghost"
              className={styles.miniTapArea}
              onClick={() => setMobileExpanded(true)}
              aria-label="Expand player"
            >
              {artworkUrl ? (
                <MediaImage
                  kind="proxied"
                  remoteUrl={artworkUrl}
                  alt=""
                  width={40}
                  height={40}
                  className={styles.miniArtwork}
                />
              ) : (
                <div className={styles.miniArtworkFallback} aria-hidden="true" />
              )}
              <span className={styles.miniTitle}>{track.title}</span>
            </Button>
            <Button
              variant="secondary"
              size="sm"
              className={styles.transportButton}
              onClick={isPlaying ? pause : play}
              aria-label={isPlaying ? "Pause" : "Play"}
            >
              {isPlaying ? "Pause" : "Play"}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              className={styles.transportButton}
              onClick={() => skipBySeconds(PLAYER_SKIP_FORWARD_SECONDS)}
              aria-label="Forward 30 seconds"
            >
              30s ►►
            </Button>
          </div>

        </>
      ) : (
        <>
          {/* Desktop: full footer layout */}
          <div className={styles.metaRow}>
            {artworkUrl && (
              <MediaImage
                kind="proxied"
                remoteUrl={artworkUrl}
                alt=""
                width={32}
                height={32}
                className={styles.desktopArtwork}
              />
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
            <Button
              variant="secondary"
              size="sm"
              className={styles.transportButton}
              onClick={() => skipBySeconds(-PLAYER_SKIP_BACK_SECONDS)}
              aria-label="Back 15 seconds"
            >
              ◄◄ 15s
            </Button>

            <Button
              variant="secondary"
              size="sm"
              className={styles.transportButton}
              onClick={isPlaying ? pause : play}
              aria-label={isPlaying ? "Pause global player" : "Play global player"}
            >
              {isPlaying ? "Pause" : "Play"}
            </Button>

            <Button
              variant="secondary"
              size="sm"
              className={styles.transportButton}
              onClick={() => skipBySeconds(PLAYER_SKIP_FORWARD_SECONDS)}
              aria-label="Forward 30 seconds"
            >
              30s ►►
            </Button>

            <Button
              ref={markButtonDesktopRef}
              variant="secondary"
              size="sm"
              className={styles.transportButton}
              aria-label="Mark waypoint"
              data-recording={isRecording ? "true" : "false"}
              onPointerDown={handleMarkPointerDown}
              onPointerUp={handleMarkPointerUp}
              onPointerCancel={handleMarkPointerCancel}
            >
              Mark
            </Button>

            <Button
              variant="secondary"
              size="sm"
              className={styles.queueButton}
              onClick={() => setWalknoteReviewOpen(true)}
              aria-label={`Review waypoints (${waypointCount})`}
            >
              Waypoints
              <span className={styles.queueBadge} aria-hidden="true">{waypointCount}</span>
            </Button>

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
                className={styles.seekSlider}
                aria-label="Seek playback position"
                disabled={durationSafe <= 0}
              />
            </div>

            <PlaybackErrorOrTimecode
              playbackError={playbackError}
              retryPlayback={retryPlayback}
              sourceUrl={track.source_url}
              isBuffering={isBuffering}
              currentSafe={currentSafe}
              durationSafe={durationSafe}
            />

            <Button
              ref={moreButtonRef}
              variant="secondary"
              size="sm"
              className={styles.moreButton}
              onClick={() => setMoreOpen((prev) => !prev)}
              aria-label="More controls"
              aria-expanded={moreOpen}
            >
              More ▾
            </Button>
          </div>

          {moreOpen && (
            <div className={styles.morePopover} ref={morePopoverRef}>
              <div className={styles.morePopoverRow}>
                <Button
                  variant="secondary"
                  size="sm"
                  className={styles.transportButton}
                  onClick={() => void playPreviousInQueue()}
                  aria-label="Previous in queue"
                >
                  ⏮
                </Button>

                <label className={styles.speedControl}>
                  <span className={styles.controlLabel}>Speed</span>
                  <Select
                    size="sm"
                    aria-label="Playback speed"
                    value={selectedPlaybackRateOption.toString()}
                    onChange={(event) => setPlaybackRate(Number(event.currentTarget.value))}
                    className={styles.select}
                  >
                    {SUBSCRIPTION_PLAYBACK_SPEED_OPTIONS.map((option) => (
                      <option key={option} value={option.toString()}>
                        {formatPlaybackSpeedLabel(option)}
                      </option>
                    ))}
                  </Select>
                </label>

                <Button
                  variant="secondary"
                  size="sm"
                  className={styles.transportButton}
                  onClick={() => void playNextInQueue()}
                  aria-label="Next in queue"
                  disabled={!hasNextInQueue}
                >
                  ⏭
                </Button>
              </div>

              <label className={styles.volumeControl}>
                <span className={styles.controlLabel}>Volume</span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={volume}
                  onInput={(event) => setVolume(Number(event.currentTarget.value))}
                  className={styles.volumeSlider}
                  aria-label="Volume"
                />
              </label>

              <div className={styles.morePopoverRow}>
                <Button
                  variant="secondary"
                  size="sm"
                  className={styles.effectsButton}
                  aria-label="Audio effects"
                  aria-expanded={effectsOpen}
                  data-active={hasActiveAudioEffects ? "true" : "false"}
                  onClick={() => setEffectsOpen((previous) => !previous)}
                >
                  Effects
                  <span className={styles.effectsIndicator} aria-hidden="true" />
                </Button>

                <Button
                  variant="secondary"
                  size="sm"
                  className={styles.queueButton}
                  onClick={openQueueFromDesktopMore}
                  aria-label="Open up next"
                >
                  Queue
                </Button>
              </div>

              {effectsOpen && (
                <EffectsPanel
                  audioEffects={audioEffects}
                  audioEffectsAvailable={audioEffectsAvailable}
                  setAudioEffects={setAudioEffects}
                  silenceTimeSavedSeconds={silenceTimeSavedSeconds}
                  isSilenceTrimming={isSilenceTrimming}
                />
              )}
            </div>
          )}
        </>
      )}

      {/* Expanded bottom sheet (mobile). Stays mounted; `active` gates it (MobileSheet mount contract). */}
      <MobileSheet
        active={isMobile && mobileExpanded}
        onDismiss={closeMobileExpanded}
        ariaLabel="Expanded player"
        layer="overlay"
      >
        <div className={styles.expandedBody}>
          <Button
            variant="secondary"
            size="sm"
            className={styles.expandedClose}
            onClick={closeMobileExpanded}
            aria-label="Collapse player"
          >
            Close
          </Button>

          {artworkUrl ? (
            <MediaImage
              kind="proxied"
              remoteUrl={artworkUrl}
              alt={track.title}
              width={240}
              height={240}
              className={styles.expandedArtwork}
            />
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
              className={styles.seekSlider}
              aria-label="Seek playback position"
              disabled={durationSafe <= 0}
            />
          </div>

          <PlaybackErrorOrTimecode
            playbackError={playbackError}
            retryPlayback={retryPlayback}
            sourceUrl={track.source_url}
            isBuffering={isBuffering}
            currentSafe={currentSafe}
            durationSafe={durationSafe}
          />

          <div className={styles.expandedTransport}>
            <Button
              variant="secondary"
              size="sm"
              className={styles.transportButton}
              onClick={() => void playPreviousInQueue()}
              aria-label="Previous in queue"
            >
              ⏮
            </Button>
            <Button
              variant="secondary"
              size="sm"
              className={styles.transportButton}
              onClick={() => skipBySeconds(-PLAYER_SKIP_BACK_SECONDS)}
              aria-label="Back 15 seconds"
            >
              ◄◄ 15s
            </Button>
            <Button
              variant="secondary"
              size="sm"
              className={styles.transportButton}
              onClick={isPlaying ? pause : play}
              aria-label={isPlaying ? "Pause" : "Play"}
            >
              {isPlaying ? "Pause" : "Play"}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              className={styles.transportButton}
              onClick={() => skipBySeconds(PLAYER_SKIP_FORWARD_SECONDS)}
              aria-label="Forward 30 seconds"
            >
              30s ►►
            </Button>
            <Button
              variant="secondary"
              size="sm"
              className={styles.transportButton}
              onClick={() => void playNextInQueue()}
              aria-label="Next in queue"
              disabled={!hasNextInQueue}
            >
              ⏭
            </Button>
          </div>

          <div className={styles.expandedSecondary}>
            <label className={styles.speedControl}>
              <span className={styles.controlLabel}>Speed</span>
              <Select
                size="sm"
                aria-label="Playback speed"
                value={selectedPlaybackRateOption.toString()}
                onChange={(event) => setPlaybackRate(Number(event.currentTarget.value))}
                className={styles.select}
              >
                {SUBSCRIPTION_PLAYBACK_SPEED_OPTIONS.map((option) => (
                  <option key={option} value={option.toString()}>
                    {formatPlaybackSpeedLabel(option)}
                  </option>
                ))}
              </Select>
            </label>

            <Button
              variant="secondary"
              size="sm"
              className={styles.effectsButton}
              aria-label="Audio effects"
              aria-expanded={effectsOpen}
              data-active={hasActiveAudioEffects ? "true" : "false"}
              onClick={() => setEffectsOpen((previous) => !previous)}
            >
              Effects
              <span className={styles.effectsIndicator} aria-hidden="true" />
            </Button>

            <Button
              variant="secondary"
              size="sm"
              className={styles.queueButton}
              onClick={openQueueFromMobileExpanded}
              aria-label="Open Lectern"
            >
              Queue
            </Button>

            <Button
              ref={markButtonMobileRef}
              variant="secondary"
              size="sm"
              className={styles.transportButton}
              aria-label="Mark waypoint"
              data-recording={isRecording ? "true" : "false"}
              onPointerDown={handleMarkPointerDown}
              onPointerUp={handleMarkPointerUp}
              onPointerCancel={handleMarkPointerCancel}
            >
              Mark
            </Button>

            <Button
              variant="secondary"
              size="sm"
              className={styles.queueButton}
              onClick={() => setWalknoteReviewOpen(true)}
              aria-label={`Review waypoints (${waypointCount})`}
            >
              Waypoints
              <span className={styles.queueBadge} aria-hidden="true">{waypointCount}</span>
            </Button>
          </div>

          {effectsOpen && (
            <EffectsPanel
              audioEffects={audioEffects}
              audioEffectsAvailable={audioEffectsAvailable}
              setAudioEffects={setAudioEffects}
              silenceTimeSavedSeconds={silenceTimeSavedSeconds}
              isSilenceTrimming={isSilenceTrimming}
            />
          )}
        </div>
      </MobileSheet>

      <audio
        ref={bindAudioElement}
        preload="none"
        src={track.stream_url}
        className={styles.hiddenAudio}
        aria-label="Global podcast player"
      />

      {queueOpen && (
        <GlobalPlayerConsumptionPanel
          onClose={() => setQueueOpen(false)}
          returnFocusFallback={getQueueReturnFocusTarget}
        />
      )}

      {walknoteReviewOpen && (
        <WalknoteReviewPanel
          onClose={() => setWalknoteReviewOpen(false)}
          returnFocusFallback={getWalknoteReviewReturnFocusTarget}
          onMaterializeComplete={(n) =>
            setLiveStatus(n === 1 ? "1 highlight created" : `${n} highlights created`)
          }
        />
      )}
    </footer>
  );
}
