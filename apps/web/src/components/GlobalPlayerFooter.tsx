"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { formatClock } from "@/lib/formatClock";
import { presenceValueOr } from "@/lib/api/presence";
import { useDismissOnOutsideOrEscape } from "@/lib/ui/useDismissOnOutsideOrEscape";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import { isPositiveFinite } from "@/lib/validation";
import {
  PLAYER_SKIP_BACK_SECONDS,
  PLAYER_SKIP_FORWARD_SECONDS,
  useGlobalPlayer,
} from "@/lib/player/globalPlayer";
import { chapterIndexAtPositionMs, chapterMarkers } from "@/lib/player/chapters";
import {
  SUBSCRIPTION_PLAYBACK_SPEED_OPTIONS,
  formatPlaybackSpeedLabel,
} from "@/lib/player/subscriptionPlaybackSpeed";
import {
  areAudioEffectsActive,
  normalizeVolumeBoostLevel,
  type AudioEffectsState,
  type AudioEffectsVolumeBoost,
} from "@/lib/player/audioEffects";
import { useBillingAccount } from "@/lib/billing/useBillingAccount";
import { useWalknoteSession } from "@/lib/walknotes/walknoteSession";
import { useVoiceRecorder } from "@/lib/walknotes/useVoiceRecorder";
import { transcribeAudio } from "@/lib/walknotes/transcribeAudio";
import MediaImage from "@/components/ui/MediaImage";
import MobileSheet from "@/components/ui/MobileSheet";
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

function isSubscriptionSpeed(rate: number): boolean {
  return SUBSCRIPTION_PLAYBACK_SPEED_OPTIONS.some((option) => option === rate);
}

function EffectsPanel({
  audioEffects,
  audioEffectsAvailable,
  setAudioEffects,
  silenceTimeSavedSeconds,
  isSilenceTrimming,
}: {
  audioEffects: AudioEffectsState;
  audioEffectsAvailable: boolean;
  setAudioEffects: (patch: Partial<AudioEffectsState>) => void;
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

      <p className={styles.effectsMeta}>
        Time saved: {isPositiveFinite(silenceTimeSavedSeconds) ? silenceTimeSavedSeconds.toFixed(1) : "0.0"}s
      </p>
      {isSilenceTrimming && <span className={styles.trimmingBadge}>Trimming silence</span>}
    </section>
  );
}

function StatusArea({
  playbackError,
  completionRetry,
  retryPlayback,
  sourceUrl,
  isBuffering,
  currentSafe,
  durationSafe,
}: {
  playbackError: { message: string } | null;
  completionRetry: (() => void) | null;
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
  if (completionRetry) {
    return (
      <div className={styles.playbackErrorArea} role="status" aria-live="polite">
        <span className={styles.playbackErrorMessage}>Couldn’t save your progress.</span>
        <Button
          variant="secondary"
          size="sm"
          className={styles.playbackErrorAction}
          onClick={completionRetry}
          aria-label="Retry saving progress"
        >
          Retry
        </Button>
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

/** The read-only "Next" preview line (spec §6). */
function nextPreviewText(preview: ReturnType<typeof useGlobalPlayer>["nextPreview"]): string | null {
  if (preview.kind === "Forward") return `Forward: ${preview.descriptor.title}`;
  if (preview.kind === "Lectern") return `Next on the Lectern: ${preview.descriptor.title}`;
  return null;
}

export default function GlobalPlayerFooter() {
  const isMobile = useIsMobileViewport();
  const [effectsOpen, setEffectsOpen] = useState(false);
  const [mobileExpanded, setMobileExpanded] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [walknoteReviewOpen, setWalknoteReviewOpen] = useState(false);
  const [nowPlaying, setNowPlaying] = useState("");
  const morePopoverRef = useRef<HTMLDivElement>(null);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const miniExpandButtonRef = useRef<HTMLButtonElement>(null);
  const markButtonDesktopRef = useRef<HTMLButtonElement>(null);
  const markButtonMobileRef = useRef<HTMLButtonElement>(null);

  const {
    state,
    presentation,
    nextPreview,
    bindAudioElement,
    playAudio,
    resume,
    pause,
    previous,
    next,
    seekTo,
    skipBy,
    setPlaybackRate,
    setVolume,
    setAudioEffects,
  } = useGlobalPlayer();

  const session = state.kind === "Absent" ? null : state.session;
  const descriptor = session?.descriptor ?? null;
  const currentMediaId = descriptor?.mediaId ?? null;

  const isPlaying = state.kind === "Active" && state.phase === "Playing";
  const isBuffering = state.kind === "Active" && state.phase === "Buffering";
  const playbackError = state.kind === "PlaybackFailed" ? { message: state.error.message } : null;
  const completionRetry = state.kind === "CompletionFailed" ? state.retry : null;
  const retryPlayback = state.kind === "PlaybackFailed" ? state.retry : () => {};
  // Session-replacing transport is disabled while a completion is in flight/failed.
  const transportLocked = state.kind === "Completing" || state.kind === "CompletionFailed";

  const currentTimeSeconds = presentation.positionMs / 1000;
  const durationSeconds = presentation.durationMs / 1000;
  const bufferedSeconds = presentation.bufferedMs / 1000;

  const chapters = descriptor?.activation.chapters ?? [];
  const currentChapterIndex = chapterIndexAtPositionMs(chapters, presentation.positionMs);
  const currentChapter = presentation.currentChapter;
  const markers = chapterMarkers(chapters, presentation.durationMs);

  const selectedPlaybackRateOption = isSubscriptionSpeed(presentation.playbackRate)
    ? presentation.playbackRate
    : 1;

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

  // Announce track changes politely (spec §6 "Now playing: …").
  const announcedMediaRef = useRef<string | null>(null);
  useEffect(() => {
    if (descriptor && descriptor.mediaId !== announcedMediaRef.current) {
      announcedMediaRef.current = descriptor.mediaId;
      setNowPlaying(`Now playing: ${descriptor.title}`);
    } else if (!descriptor) {
      announcedMediaRef.current = null;
    }
  }, [descriptor]);

  const closeMobileExpanded = () => {
    setMobileExpanded(false);
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
      if (!currentMediaId) return;
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // setPointerCapture may throw in test environments without an active pointer
      }

      const posMs = Math.floor(currentTimeSeconds * 1000);
      const mediaId = currentMediaId;
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
    [currentMediaId, currentTimeSeconds, canTranscribe, addWaypoint, updateWaypointVoice, voiceRecorder]
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

  // The dock is activity-conditional: it renders for every non-Absent session
  // (including PausedAtEnd / Completing / CompletionFailed / PlaybackFailed).
  if (state.kind === "Absent" || descriptor === null) {
    return null;
  }

  const durationSafe = isPositiveFinite(durationSeconds) ? durationSeconds : 0;
  const currentSafe = Math.max(0, currentTimeSeconds);
  const bufferedSafe = Math.max(0, bufferedSeconds);
  const progressPercent = durationSafe > 0 ? Math.min(100, (currentSafe / durationSafe) * 100) : 0;
  const bufferedPercent = durationSafe > 0 ? Math.min(100, (bufferedSafe / durationSafe) * 100) : 0;
  const seekSliderValue = durationSafe > 0 ? Math.min(durationSafe, currentSafe) : 0;
  const artworkUrl = presenceValueOr(descriptor.activation.artworkUrl, undefined);
  const sourceUrl = descriptor.activation.sourceUrl;
  const streamUrl = descriptor.activation.streamUrl;
  const seekTrackStyle = {
    "--progress-percent": `${progressPercent}%`,
    "--buffered-percent": `${Math.max(progressPercent, bufferedPercent)}%`,
  } as CSSProperties;

  const onSeek = (nextValueSeconds: number) => {
    if (durationSafe <= 0) return;
    const clampedSeconds = Math.max(0, Math.min(durationSafe, nextValueSeconds));
    seekTo(Math.floor(clampedSeconds * 1000));
  };

  // Play/Pause: pause the active session, resume a paused one, or start a NEW
  // session from PausedAtEnd / a failed session (explicit Play).
  const onPlayPause = () => {
    if (isPlaying) {
      pause();
      return;
    }
    if (state.kind === "PausedAtEnd" || state.kind === "PlaybackFailed") {
      playAudio(descriptor);
      return;
    }
    resume();
  };
  const playPauseLabel = isPlaying ? "Pause" : "Play";

  const hasActiveAudioEffects = areAudioEffectsActive(presentation.audioEffects);
  const nextDisabled = transportLocked || nextPreview.kind === "None";
  const previewText = nextPreviewText(nextPreview);
  const silenceTimeSavedSeconds = presentation.silenceTimeSavedMs / 1000;

  const openLecternFromMobileExpanded = () => {
    miniExpandButtonRef.current?.focus();
    setMobileExpanded(false);
    requestOpenInAppPane("/lectern", { labelHint: "Lectern" });
  };
  const openLecternFromDesktopMore = () => {
    moreButtonRef.current?.focus();
    setMoreOpen(false);
    requestOpenInAppPane("/lectern", { labelHint: "Lectern" });
  };
  const getWalknoteReviewReturnFocusTarget = () =>
    isMobile ? markButtonMobileRef.current : markButtonDesktopRef.current;

  const chapterLabel =
    currentChapter.kind === "Present"
      ? `Chapter ${currentChapterIndex >= 0 ? currentChapterIndex + 1 : 1}: ${currentChapter.value.title}`
      : null;

  return (
    <footer
      className={styles.footer}
      role="region"
      aria-label="Media player"
      data-mobile-view={isMobile ? (mobileExpanded ? "expanded" : "minibar") : undefined}
    >
      {/* Polite live region for walknote status + track-change announcements. */}
      <span role="status" aria-live="polite" className={styles.srOnly}>
        {liveStatus}
      </span>
      <span role="status" aria-live="polite" className={styles.srOnly}>
        {nowPlaying}
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
              <span className={styles.miniTitle}>{descriptor.title}</span>
            </Button>
            <Button
              variant="secondary"
              size="sm"
              className={styles.transportButton}
              onClick={onPlayPause}
              aria-label={playPauseLabel}
            >
              {playPauseLabel}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              className={styles.transportButton}
              onClick={() => skipBy(PLAYER_SKIP_FORWARD_SECONDS * 1000)}
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
              <a href={`/media/${descriptor.mediaId}`} className={styles.trackLink}>
                {descriptor.title}
              </a>
              {chapterLabel && <span className={styles.chapterLabel}>{chapterLabel}</span>}
              {previewText && (
                <span className={styles.nextPreview} data-testid="player-next-preview">
                  {previewText}
                </span>
              )}
            </div>
          </div>

          <div className={styles.controlsRow} role="group" aria-label="Media player controls">
            <Button
              variant="secondary"
              size="sm"
              className={styles.transportButton}
              onClick={previous}
              disabled={transportLocked}
              aria-label="Previous"
            >
              ⏮
            </Button>

            <Button
              variant="secondary"
              size="sm"
              className={styles.transportButton}
              onClick={() => skipBy(-PLAYER_SKIP_BACK_SECONDS * 1000)}
              aria-label="Back 15 seconds"
            >
              ◄◄ 15s
            </Button>

            <Button
              variant="secondary"
              size="sm"
              className={styles.transportButton}
              onClick={onPlayPause}
              aria-label={isPlaying ? "Pause media player" : "Play media player"}
            >
              {playPauseLabel}
            </Button>

            <Button
              variant="secondary"
              size="sm"
              className={styles.transportButton}
              onClick={() => skipBy(PLAYER_SKIP_FORWARD_SECONDS * 1000)}
              aria-label="Forward 30 seconds"
            >
              30s ►►
            </Button>

            <Button
              variant="secondary"
              size="sm"
              className={styles.transportButton}
              onClick={next}
              disabled={nextDisabled}
              aria-label="Next"
            >
              ⏭
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
              className={styles.walknoteButton}
              onClick={() => setWalknoteReviewOpen(true)}
              aria-label={`Review waypoints (${waypointCount})`}
            >
              Waypoints
              <span className={styles.walknoteBadge} aria-hidden="true">{waypointCount}</span>
            </Button>

            <div className={styles.seekArea}>
              <div className={styles.seekTrack} style={seekTrackStyle} aria-hidden="true" />
              {markers.length > 0 && (
                <div className={styles.chapterTicks} aria-hidden="true">
                  {markers.map((chapter) => (
                    <span
                      key={`${chapter.index}-${chapter.startMs}`}
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

            <StatusArea
              playbackError={playbackError}
              completionRetry={completionRetry}
              retryPlayback={retryPlayback}
              sourceUrl={sourceUrl}
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

              <label className={styles.volumeControl}>
                <span className={styles.controlLabel}>Volume</span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={presentation.volume}
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
                  className={styles.walknoteButton}
                  onClick={openLecternFromDesktopMore}
                  aria-label="Open Lectern"
                >
                  Open Lectern
                </Button>
              </div>

              {effectsOpen && (
                <EffectsPanel
                  audioEffects={presentation.audioEffects}
                  audioEffectsAvailable={presentation.audioEffectsAvailable}
                  setAudioEffects={setAudioEffects}
                  silenceTimeSavedSeconds={silenceTimeSavedSeconds}
                  isSilenceTrimming={presentation.isSilenceTrimming}
                />
              )}
            </div>
          )}
        </>
      )}

      {/* Expanded bottom sheet (mobile). Stays mounted; `active` gates it. */}
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
              alt={descriptor.title}
              width={240}
              height={240}
              className={styles.expandedArtwork}
            />
          ) : (
            <div className={styles.expandedArtworkFallback} aria-hidden="true" />
          )}

          <div className={styles.expandedMeta}>
            <a href={`/media/${descriptor.mediaId}`} className={styles.trackLink}>
              {descriptor.title}
            </a>
            {chapterLabel && <span className={styles.chapterLabel}>{chapterLabel}</span>}
            {previewText && <span className={styles.nextPreview}>{previewText}</span>}
          </div>

          <div className={styles.seekArea}>
            <div className={styles.seekTrack} style={seekTrackStyle} aria-hidden="true" />
            {markers.length > 0 && (
              <div className={styles.chapterTicks} aria-hidden="true">
                {markers.map((chapter) => (
                  <span
                    key={`${chapter.index}-${chapter.startMs}`}
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

          <StatusArea
            playbackError={playbackError}
            completionRetry={completionRetry}
            retryPlayback={retryPlayback}
            sourceUrl={sourceUrl}
            isBuffering={isBuffering}
            currentSafe={currentSafe}
            durationSafe={durationSafe}
          />

          <div className={styles.expandedTransport}>
            <Button
              variant="secondary"
              size="sm"
              className={styles.transportButton}
              onClick={previous}
              disabled={transportLocked}
              aria-label="Previous"
            >
              ⏮
            </Button>
            <Button
              variant="secondary"
              size="sm"
              className={styles.transportButton}
              onClick={() => skipBy(-PLAYER_SKIP_BACK_SECONDS * 1000)}
              aria-label="Back 15 seconds"
            >
              ◄◄ 15s
            </Button>
            <Button
              variant="secondary"
              size="sm"
              className={styles.transportButton}
              onClick={onPlayPause}
              aria-label={playPauseLabel}
            >
              {playPauseLabel}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              className={styles.transportButton}
              onClick={() => skipBy(PLAYER_SKIP_FORWARD_SECONDS * 1000)}
              aria-label="Forward 30 seconds"
            >
              30s ►►
            </Button>
            <Button
              variant="secondary"
              size="sm"
              className={styles.transportButton}
              onClick={next}
              disabled={nextDisabled}
              aria-label="Next"
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
              className={styles.walknoteButton}
              onClick={openLecternFromMobileExpanded}
              aria-label="Open Lectern"
            >
              Open Lectern
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
              className={styles.walknoteButton}
              onClick={() => setWalknoteReviewOpen(true)}
              aria-label={`Review waypoints (${waypointCount})`}
            >
              Waypoints
              <span className={styles.walknoteBadge} aria-hidden="true">{waypointCount}</span>
            </Button>
          </div>

          {effectsOpen && (
            <EffectsPanel
              audioEffects={presentation.audioEffects}
              audioEffectsAvailable={presentation.audioEffectsAvailable}
              setAudioEffects={setAudioEffects}
              silenceTimeSavedSeconds={silenceTimeSavedSeconds}
              isSilenceTrimming={presentation.isSilenceTrimming}
            />
          )}
        </div>
      </MobileSheet>

      <audio
        ref={bindAudioElement}
        preload="none"
        src={streamUrl}
        className={styles.hiddenAudio}
        aria-label="Media player audio"
      />

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
