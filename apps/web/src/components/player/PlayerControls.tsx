"use client";

import {
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
  type Ref,
} from "react";
import {
  Gauge,
  List,
  Mic,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  SkipBack,
  SkipForward,
  Volume2,
} from "lucide-react";
import { presenceValueOr } from "@/lib/api/presence";
import { formatClock } from "@/lib/formatClock";
import {
  PLAYER_SKIP_BACK_SECONDS,
  PLAYER_SKIP_FORWARD_SECONDS,
  usePlayerCommands,
  usePlayerSettings,
  usePlayerTimeline,
} from "@/lib/player/globalPlayer";
import { chapterMarkers } from "@/lib/player/chapters";
import {
  playerTransportLocked,
  type PlayerChromeModel,
} from "@/lib/player/playerChromeModel";
import {
  SUBSCRIPTION_PLAYBACK_SPEED_OPTIONS,
  formatPlaybackSpeedLabel,
  type SubscriptionPlaybackSpeedOption,
} from "@/lib/player/subscriptionPlaybackSpeed";
import Button from "@/components/ui/Button";
import MediaImage from "@/components/ui/MediaImage";
import Select from "@/components/ui/Select";
import type { PlayerCaptureController } from "@/lib/walknotes/usePlayerCapture";
import styles from "./PlayerControls.module.css";

export type PresentPlayerChrome = Exclude<
  PlayerChromeModel,
  { readonly kind: "Absent" }
>;

export function playerTitle(model: PresentPlayerChrome): string {
  return model.state.session.descriptor.title;
}

export function playerSourceHref(model: PresentPlayerChrome): string {
  return model.kind === "Canonical"
    ? model.state.session.descriptor.activation.sourceUrl
    : model.state.session.descriptor.sourceHref;
}

export function playerTargetHref(model: PresentPlayerChrome): string {
  return model.kind === "Canonical"
    ? `/media/${model.state.session.descriptor.mediaId}`
    : model.state.session.descriptor.previewHref;
}

export function PlayerArtwork({
  model,
  size,
  className,
  fluid = false,
}: {
  readonly model: PresentPlayerChrome;
  readonly size: number;
  readonly className?: string;
  readonly fluid?: boolean;
}) {
  const title = playerTitle(model);
  const placeholder = (
    <span
      className={[styles.artworkPlaceholder, className]
        .filter(Boolean)
        .join(" ")}
      aria-hidden="true"
      style={fluid ? undefined : { width: size, height: size }}
    >
      {title.trim().charAt(0).toLocaleUpperCase() || "N"}
    </span>
  );

  if (model.kind === "Canonical") {
    const image = presenceValueOr(
      model.state.session.descriptor.activation.artworkUrl,
      null,
    );
    return image === null ? (
      placeholder
    ) : (
      <MediaImage
        kind="proxied"
        remoteUrl={image}
        alt=""
        width={size}
        height={size}
        className={className}
      />
    );
  }
  const image = presenceValueOr(model.state.session.descriptor.imageUrl, null);
  return image === null ? (
    placeholder
  ) : (
    <MediaImage
      kind="proxy-src"
      src={image}
      alt=""
      width={size}
      height={size}
      className={className}
    />
  );
}

export function PlayerIdentity({
  model,
  onOpen,
  artworkSize,
  className,
  ariaLabel,
  buttonRef,
}: {
  readonly model: PresentPlayerChrome;
  readonly onOpen: () => void;
  readonly artworkSize: number;
  readonly className?: string;
  readonly ariaLabel?: string;
  readonly buttonRef?: Ref<HTMLButtonElement>;
}) {
  const subtitle =
    model.kind === "Canonical"
      ? presenceValueOr(model.state.session.descriptor.subtitle, null)
      : `Preview from ${model.state.session.descriptor.source}`;
  const title = playerTitle(model);

  return (
    <Button
      ref={buttonRef}
      variant="ghost"
      className={[styles.identity, className].filter(Boolean).join(" ")}
      onClick={onOpen}
      aria-label={ariaLabel ?? `Open ${title}`}
    >
      <PlayerArtwork
        model={model}
        size={artworkSize}
        className={styles.identityArtwork}
      />
      <span className={styles.identityCopy}>
        <span className={styles.kicker}>
          {model.kind === "Canonical" ? "Now playing" : "Listening preview"}
        </span>
        <span className={styles.identityTitle}>{title}</span>
        {subtitle ? (
          <span className={styles.identitySubtitle}>{subtitle}</span>
        ) : model.kind === "Canonical" ? (
          <PlayerCurrentChapterLine />
        ) : null}
      </span>
    </Button>
  );
}

export function PlayerCurrentChapterLine({
  className,
}: {
  readonly className?: string;
} = {}) {
  const timeline = usePlayerTimeline();
  return timeline.currentChapter.kind === "Present" ? (
    <span
      className={[styles.identitySubtitle, className].filter(Boolean).join(" ")}
      aria-label="Current chapter"
    >
      {timeline.currentChapter.value.title}
    </span>
  ) : null;
}

function isPlaying(model: PresentPlayerChrome): boolean {
  return (
    (model.state.kind === "Active" || model.state.kind === "PreviewAudio") &&
    model.state.phase === "Playing"
  );
}

export function PlayerTransport({
  model,
  compact = false,
}: {
  readonly model: PresentPlayerChrome;
  readonly compact?: boolean;
}) {
  const commands = usePlayerCommands();
  const playing = isPlaying(model);
  const locked = playerTransportLocked(model);

  const togglePlayback = () => {
    if (playing) {
      commands.pause();
      return;
    }
    if (model.state.kind === "PausedAtEnd") {
      commands.playAudio(model.state.session.descriptor);
      return;
    }
    if (model.state.kind === "PreviewAudioAtEnd") {
      commands.playPreviewAudio(model.state.session.descriptor);
      return;
    }
    if (
      model.state.kind === "PlaybackFailed" ||
      model.state.kind === "PreviewAudioFailed"
    ) {
      model.state.retry();
      return;
    }
    commands.resume();
  };

  const nextUnavailable =
    model.kind === "Canonical" && model.nextPreview.kind === "None";

  return (
    <div
      className={[styles.transport, compact ? styles.transportCompact : ""]
        .filter(Boolean)
        .join(" ")}
      role="group"
      aria-label="Media player controls"
    >
      {model.kind === "Canonical" && !compact ? (
        <Button
          variant="ghost"
          size="lg"
          iconOnly
          onClick={commands.previous}
          disabled={locked}
          aria-label="Previous"
        >
          <SkipBack aria-hidden="true" />
        </Button>
      ) : null}
      {!compact ? (
        <Button
          variant="ghost"
          size="lg"
          iconOnly
          onClick={() => commands.skipBy(-PLAYER_SKIP_BACK_SECONDS * 1000)}
          aria-label="Back 15 seconds"
        >
          <RotateCcw aria-hidden="true" />
        </Button>
      ) : null}
      <Button
        variant="primary"
        size="lg"
        iconOnly
        className={styles.playPause}
        onClick={togglePlayback}
        disabled={locked}
        aria-label={playing ? "Pause media player" : "Play media player"}
      >
        {playing ? (
          <Pause aria-hidden="true" fill="currentColor" />
        ) : (
          <Play aria-hidden="true" fill="currentColor" />
        )}
      </Button>
      <Button
        variant="ghost"
        size="lg"
        iconOnly
        onClick={() => commands.skipBy(PLAYER_SKIP_FORWARD_SECONDS * 1000)}
        aria-label="Forward 30 seconds"
      >
        <RotateCw aria-hidden="true" />
      </Button>
      {model.kind === "Canonical" && !compact ? (
        <Button
          variant="ghost"
          size="lg"
          iconOnly
          onClick={commands.next}
          disabled={locked || nextUnavailable}
          aria-label="Next"
        >
          <SkipForward aria-hidden="true" />
        </Button>
      ) : null}
      <span className={styles.srOnly}>{playerTitle(model)}</span>
    </div>
  );
}

function clampPosition(positionMs: number, durationMs: number): number {
  if (!Number.isFinite(positionMs)) return 0;
  return Math.max(0, Math.min(durationMs, positionMs));
}

export function PlayerSeek({
  model,
  compact = false,
}: {
  readonly model: PresentPlayerChrome;
  readonly compact?: boolean;
}) {
  const timeline = usePlayerTimeline();
  const commands = usePlayerCommands();
  const pointerActive = useRef(false);
  const draftRef = useRef<number | null>(null);
  const [draftMs, setDraftMs] = useState<number | null>(null);
  const durationMs =
    Number.isFinite(timeline.durationMs) && timeline.durationMs > 0
      ? timeline.durationMs
      : 0;
  const positionMs = clampPosition(draftMs ?? timeline.positionMs, durationMs);
  const bufferedMs = clampPosition(timeline.bufferedMs, durationMs);
  const progress = durationMs > 0 ? (positionMs / durationMs) * 100 : 0;
  const buffered = durationMs > 0 ? (bufferedMs / durationMs) * 100 : 0;
  const chapters =
    model.kind === "Canonical"
      ? model.state.session.descriptor.activation.chapters
      : [];
  const markers = chapterMarkers(chapters, durationMs);

  const commitDraft = () => {
    const draft = draftRef.current;
    pointerActive.current = false;
    draftRef.current = null;
    setDraftMs(null);
    if (draft !== null) commands.seekTo(draft);
  };

  const updateDraft = (value: string) => {
    const next = clampPosition(Number(value), durationMs);
    if (pointerActive.current) {
      draftRef.current = next;
      setDraftMs(next);
      return;
    }
    commands.seekTo(next);
  };

  const beginPointerScrub = (event: PointerEvent<HTMLInputElement>) => {
    pointerActive.current = true;
    draftRef.current = Number(event.currentTarget.value);
  };

  return (
    <div
      className={[styles.seek, compact ? styles.seekCompact : ""]
        .filter(Boolean)
        .join(" ")}
      style={
        {
          "--player-progress": `${progress}%`,
          "--player-buffered": `${Math.max(progress, buffered)}%`,
        } as CSSProperties
      }
    >
      <span className={styles.timecode}>{formatClock(positionMs / 1000)}</span>
      <span className={styles.seekTrack} aria-hidden="true" />
      {markers.length > 0 ? (
        <span className={styles.chapterTicks} aria-hidden="true">
          {markers.map((chapter) => (
            <span
              key={`${chapter.index}-${chapter.startMs}`}
              className={styles.chapterTick}
              style={{ left: `${chapter.leftPercent}%` }}
            />
          ))}
        </span>
      ) : null}
      <input
        type="range"
        min={0}
        max={durationMs}
        step={1000}
        value={positionMs}
        disabled={durationMs <= 0}
        className={styles.seekInput}
        aria-label="Seek playback position"
        aria-valuetext={`${formatClock(positionMs / 1000)} of ${formatClock(
          durationMs / 1000,
        )}`}
        onPointerDown={beginPointerScrub}
        onInput={(event) => updateDraft(event.currentTarget.value)}
        onPointerUp={commitDraft}
        onPointerCancel={commitDraft}
        onBlur={() => {
          if (pointerActive.current) commitDraft();
        }}
      />
      <span className={styles.timecode}>{formatClock(durationMs / 1000)}</span>
    </div>
  );
}

export function PlayerStatus({
  model,
}: {
  readonly model: PresentPlayerChrome;
}) {
  let message: string | null = null;
  let retry: (() => void) | null = null;

  if (
    (model.state.kind === "Active" || model.state.kind === "PreviewAudio") &&
    model.state.phase === "Buffering"
  ) {
    message = "Buffering";
  } else if (
    model.state.kind === "PlaybackFailed" ||
    model.state.kind === "PreviewAudioFailed"
  ) {
    message = model.state.error.message;
    retry = model.state.retry;
  } else if (model.state.kind === "Completing") {
    message = "Finishing";
  } else if (model.state.kind === "CompletionFailed") {
    message = "Progress not saved";
    retry = model.state.retry;
  } else if (
    model.kind === "Canonical" &&
    model.persistence.kind === "Suspended"
  ) {
    message = "Progress sync paused";
    retry = model.persistence.retryGet;
  }

  if (message === null) return null;
  return (
    <div className={styles.status} aria-label="Player status">
      <span className={styles.statusDot} aria-hidden="true" />
      <span>{message}</span>
      {retry ? (
        <Button variant="ghost" size="sm" onClick={retry}>
          Retry
        </Button>
      ) : null}
      {model.state.kind === "PlaybackFailed" ||
      model.state.kind === "PreviewAudioFailed" ? (
        <a
          href={playerSourceHref(model)}
          target="_blank"
          rel="noopener noreferrer"
        >
          Open source
        </a>
      ) : null}
    </div>
  );
}

export function PlayerSpeedControl() {
  const settings = usePlayerSettings();
  const commands = usePlayerCommands();
  const value = isPlaybackSpeedOption(settings.playbackRate)
    ? settings.playbackRate
    : 1;

  return (
    <label className={styles.setting}>
      <Gauge size={16} aria-hidden="true" />
      <span>Speed</span>
      <Select
        size="sm"
        aria-label="Playback speed"
        value={value}
        onChange={(event) =>
          commands.setPlaybackRate(Number(event.currentTarget.value))
        }
      >
        {SUBSCRIPTION_PLAYBACK_SPEED_OPTIONS.map((speed) => (
          <option key={speed} value={speed}>
            {formatPlaybackSpeedLabel(speed)}
          </option>
        ))}
      </Select>
    </label>
  );
}

function isPlaybackSpeedOption(
  value: number,
): value is SubscriptionPlaybackSpeedOption {
  return SUBSCRIPTION_PLAYBACK_SPEED_OPTIONS.some((option) => option === value);
}

export function PlayerVolumeControl() {
  const settings = usePlayerSettings();
  const commands = usePlayerCommands();
  return (
    <label className={styles.setting}>
      <Volume2 size={16} aria-hidden="true" />
      <span className={styles.srOnly}>Volume</span>
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={settings.volume}
        aria-label="Volume"
        onInput={(event) =>
          commands.setVolume(Number(event.currentTarget.value))
        }
      />
    </label>
  );
}

export function PlayerCaptureButton({
  model,
  capture,
  className,
  afterCapture,
}: {
  readonly model: Extract<PresentPlayerChrome, { readonly kind: "Canonical" }>;
  readonly capture: PlayerCaptureController;
  readonly className?: string;
  readonly afterCapture?: () => void;
}) {
  const timeline = usePlayerTimeline();
  return (
    <Button
      variant="ghost"
      size="lg"
      className={[styles.capture, className].filter(Boolean).join(" ")}
      data-player-capture
      data-recording={capture.isRecording ? "true" : "false"}
      aria-label="Capture this moment"
      onPointerDown={(event) =>
        capture.handlePointerDown(event, {
          mediaId: model.state.session.descriptor.mediaId,
          positionMs: timeline.positionMs,
        })
      }
      onPointerUp={() => {
        capture.handlePointerUp();
        afterCapture?.();
      }}
      onPointerCancel={capture.handlePointerCancel}
      onClick={(event) => {
        if (event.detail !== 0) return;
        capture.captureTap({
          mediaId: model.state.session.descriptor.mediaId,
          positionMs: timeline.positionMs,
        });
        afterCapture?.();
      }}
      leadingIcon={<Mic aria-hidden="true" />}
    >
      Capture
      {capture.waypointCount > 0 ? (
        <span
          className={styles.count}
          aria-label={`${capture.waypointCount} captures`}
        >
          {capture.waypointCount}
        </span>
      ) : null}
    </Button>
  );
}

export function PlayerMiniProgress() {
  const timeline = usePlayerTimeline();
  const progress =
    timeline.durationMs > 0
      ? Math.max(
          0,
          Math.min(100, (timeline.positionMs / timeline.durationMs) * 100),
        )
      : 0;
  return (
    <span
      className={styles.miniProgress}
      style={{ "--player-progress": `${progress}%` } as CSSProperties}
      aria-hidden="true"
    />
  );
}

export function PlayerContentsButton({
  onClick,
}: {
  readonly onClick: () => void;
}) {
  return (
    <Button
      variant="ghost"
      size="lg"
      onClick={onClick}
      leadingIcon={<List aria-hidden="true" />}
    >
      Contents
    </Button>
  );
}
