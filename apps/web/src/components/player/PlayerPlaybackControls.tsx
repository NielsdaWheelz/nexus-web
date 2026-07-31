"use client";

import { forwardRef, type Ref } from "react";
import { Gauge, Minus, Plus } from "lucide-react";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import MobileSheet from "@/components/ui/MobileSheet";
import Select from "@/components/ui/Select";
import { presenceValueOr } from "@/lib/api/presence";
import { formatClock } from "@/lib/formatClock";
import {
  usePlayerCommands,
  usePlayerSettings,
  usePlayerTimeline,
} from "@/lib/player/globalPlayer";
import {
  adjustedRemainingMs,
  formatPlaybackRate,
  isPlaybackRateStepAligned,
  PLAYBACK_RATE_MAX,
  PLAYBACK_RATE_MIN,
  PLAYBACK_RATE_PRESETS,
  PLAYBACK_RATE_STEP,
  snapPlaybackRateToStep,
  stepPlaybackRate,
} from "@/lib/player/playbackRate";
import { pauseShorteningModeLabel } from "@/lib/player/pauseShortening";
import PlayerOutputEffectsControls from "./PlayerOutputEffectsControls";
import mobileStyles from "./MobileNowPlaying.module.css";
import styles from "./PlayerPlaybackControls.module.css";

function rateText(rate: number): string {
  return formatPlaybackRate(rate).slice(0, -1);
}

function sameRate(left: number, right: number): boolean {
  return Math.abs(left - right) < 0.0001;
}

export function playbackRateAccessibleName(rate: number): string {
  return sameRate(rate, 1)
    ? "Playback speed, normal"
    : `Playback speed, ${rateText(rate)} times`;
}

export function PlaybackRateEditor({
  value,
  onChange,
  label,
  description,
}: {
  readonly value: number;
  readonly onChange: (value: number) => void;
  readonly label: string;
  readonly description?: string;
}) {
  return (
    <div className={styles.editor}>
      <div className={styles.summary}>
        <div>
          <span className={styles.eyebrow}>{label}</span>
          <strong className={styles.value}>{formatPlaybackRate(value)}</strong>
        </div>
        {description ? (
          <span className={styles.remaining}>{description}</span>
        ) : null}
      </div>
      <div className={styles.presets} role="group" aria-label={`${label} presets`}>
        {PLAYBACK_RATE_PRESETS.map((preset) => (
          <Button
            key={preset}
            variant={sameRate(value, preset) ? "primary" : "secondary"}
            size="sm"
            aria-pressed={sameRate(value, preset)}
            onClick={() => onChange(preset)}
          >
            {formatPlaybackRate(preset)}
          </Button>
        ))}
      </div>
      <div className={styles.adjuster}>
        <Button
          variant="secondary"
          size="lg"
          iconOnly
          disabled={value <= PLAYBACK_RATE_MIN}
          aria-label={`Decrease ${label.toLocaleLowerCase()}`}
          onClick={() => onChange(stepPlaybackRate(value, -1))}
        >
          <Minus aria-hidden="true" />
        </Button>
        <input
          className={styles.range}
          data-playback-rate-range
          type="range"
          min={PLAYBACK_RATE_MIN}
          max={PLAYBACK_RATE_MAX}
          step={
            isPlaybackRateStepAligned(value) ? PLAYBACK_RATE_STEP : "any"
          }
          value={value}
          aria-label={label}
          aria-valuetext={
            sameRate(value, 1)
              ? "Normal speed"
              : `${rateText(value)} times normal`
          }
          onKeyDown={(event) => {
            if (event.key === "ArrowRight" || event.key === "ArrowUp") {
              event.preventDefault();
              onChange(stepPlaybackRate(value, 1));
            } else if (
              event.key === "ArrowLeft" ||
              event.key === "ArrowDown"
            ) {
              event.preventDefault();
              onChange(stepPlaybackRate(value, -1));
            } else if (event.key === "Home") {
              event.preventDefault();
              onChange(PLAYBACK_RATE_MIN);
            } else if (event.key === "End") {
              event.preventDefault();
              onChange(PLAYBACK_RATE_MAX);
            }
          }}
          onInput={(event) =>
            onChange(
              snapPlaybackRateToStep(Number(event.currentTarget.value)),
            )
          }
        />
        <Button
          variant="secondary"
          size="lg"
          iconOnly
          disabled={value >= PLAYBACK_RATE_MAX}
          aria-label={`Increase ${label.toLocaleLowerCase()}`}
          onClick={() => onChange(stepPlaybackRate(value, 1))}
        >
          <Plus aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}

export const PlayerPlaybackRateButton = forwardRef(function PlayerPlaybackRateButton(
  {
    onClick,
    className,
  }: {
    readonly onClick: () => void;
    readonly className?: string;
  },
  ref: Ref<HTMLButtonElement>,
) {
  const settings = usePlayerSettings();
  return (
    <Button
      ref={ref}
      variant="ghost"
      size="lg"
      className={[styles.rateButton, className].filter(Boolean).join(" ")}
      data-player-playback
      aria-label={playbackRateAccessibleName(settings.playbackRate.base)}
      onClick={onClick}
      leadingIcon={<Gauge aria-hidden="true" />}
    >
      {formatPlaybackRate(settings.playbackRate.base)}
    </Button>
  );
});

export function PlayerPlaybackPanel({
  podcastTitle,
}: {
  readonly podcastTitle: string | null;
}) {
  const settings = usePlayerSettings();
  const timeline = usePlayerTimeline();
  const commands = usePlayerCommands();
  const rate = settings.playbackRate;
  const remainingMs = adjustedRemainingMs(
    timeline.durationMs,
    timeline.positionMs,
    rate.base,
  );
  const canonical = rate.scope.kind === "Canonical" ? rate.scope : null;
  const podcastPreference =
    canonical?.podcastPreference.kind === "Present"
      ? canonical.podcastPreference.value
      : null;
  const inheritedRate =
    podcastPreference === null
      ? 1
      : presenceValueOr(podcastPreference.value, 1);
  const preferredDiffersFromInherited =
    canonical !== null && !sameRate(rate.preferred, inheritedRate);
  const rememberAvailable =
    podcastPreference !== null &&
    preferredDiffersFromInherited &&
    rate.remember.kind !== "Unavailable" &&
    !(rate.remember.kind === "Failed" && !rate.remember.retryable);
  const pauseShortening = settings.pauseShortening;
  const pauseScope =
    pauseShortening.kind === "Available"
      ? pauseShortening.provenance === "Session"
        ? "This session"
        : pauseShortening.provenance === "Podcast"
          ? "This podcast"
          : "Device default"
      : null;
  const inheritedPauseMode =
    pauseShortening.kind === "Available"
      ? pauseShortening.podcastOverride.kind === "Present"
        ? pauseShortening.podcastOverride.value
        : pauseShortening.deviceDefaultMode
      : null;
  const pausePodcastActionAvailable =
    pauseShortening.kind === "Available" &&
    podcastPreference !== null &&
    inheritedPauseMode !== null &&
    pauseShortening.effectiveMode !== inheritedPauseMode;
  const pauseDeviceActionAvailable =
    pauseShortening.kind === "Available" &&
    pauseShortening.effectiveMode !== pauseShortening.deviceDefaultMode;
  const pauseMutation =
    pauseShortening.kind === "Available"
      ? pauseShortening.mutation
      : null;
  const savedOnDeviceMs =
    timeline.pauseShorteningSavedOnDeviceMs.kind === "Present"
      ? timeline.pauseShorteningSavedOnDeviceMs.value
      : 0;

  return (
    <div className={styles.panel}>
      <PlaybackRateEditor
        value={rate.base}
        onChange={commands.setPlaybackRate}
        label="Playback speed"
        description={`About ${formatClock(remainingMs / 1000)} remaining`}
      />

      {!sameRate(rate.preferred, 1) ? (
        <Button
          variant="secondary"
          size="lg"
          onClick={commands.toggleTemporaryNormalRate}
        >
          {rate.temporaryNormal
            ? `Return to ${formatPlaybackRate(rate.preferred)}`
            : "Temporarily use 1x"}
        </Button>
      ) : null}

      {canonical !== null ? (
        <div className={styles.scope}>
          <p>
            This episode {formatPlaybackRate(rate.preferred)} ·{" "}
            {podcastPreference === null
              ? "Default 1x"
              : `Podcast default ${formatPlaybackRate(inheritedRate)}`}
          </p>
          {preferredDiffersFromInherited ? (
            <Button
              variant="secondary"
              size="lg"
              onClick={commands.useInheritedPlaybackRate}
            >
              {podcastPreference === null
                ? "Use default speed 1x"
                : `Use podcast speed ${formatPlaybackRate(inheritedRate)}`}
            </Button>
          ) : null}
          {rememberAvailable ? (
            <Button
              variant="secondary"
              size="lg"
              disabled={rate.remember.kind === "Pending"}
              onClick={
                rate.remember.kind === "Failed" &&
                rate.remember.retry !== undefined
                  ? rate.remember.retry
                  : commands.rememberPlaybackRateForPodcast
              }
            >
              {rate.remember.kind === "Pending"
                ? "Remembering playback speed…"
                : rate.remember.kind === "Failed"
                  ? `Retry remembering ${formatPlaybackRate(
                      rate.remember.attemptedRate ?? rate.preferred,
                    )}`
                : `Remember ${formatPlaybackRate(rate.preferred)} for ${
                    podcastTitle ?? "this podcast"
                  }`}
            </Button>
          ) : null}
          {rate.remember.kind === "Failed" ? (
            <FeedbackNotice feedback={rate.remember.error} announce={false} />
          ) : null}
        </div>
      ) : null}

      {canonical !== null && pauseShortening.kind === "Available" ? (
        <section
          className={styles.pauseShortening}
          aria-labelledby="player-pause-shortening-title"
        >
          <h3 id="player-pause-shortening-title">Shorten pauses</h3>
          <label className={styles.pauseSetting}>
            <span>Mode</span>
            <Select
              size="lg"
              disabled={pauseMutation?.kind === "Pending"}
              value={pauseShortening.effectiveMode}
              onChange={(event) =>
                commands.setSessionPauseShorteningMode(
                  event.currentTarget.value === "Natural"
                    ? "Natural"
                    : "Off",
                )
              }
            >
              <option value="Off">Off</option>
              <option value="Natural">Natural</option>
            </Select>
          </label>
          <p>
            {pauseScope} ·{" "}
            {pauseShorteningModeLabel(pauseShortening.effectiveMode)}
          </p>
          <div className={styles.pauseActions}>
            {pauseShortening.sessionOverride.kind === "Present" ? (
              <Button
                variant="secondary"
                size="lg"
                disabled={pauseMutation?.kind === "Pending"}
                onClick={commands.clearSessionPauseShorteningMode}
              >
                {pauseShortening.podcastOverride.kind === "Present"
                  ? "Use podcast setting"
                  : "Use device setting"}
              </Button>
            ) : null}
            {pausePodcastActionAvailable ? (
              <Button
                variant="secondary"
                size="lg"
                disabled={pauseMutation?.kind === "Pending"}
                onClick={commands.rememberPauseShorteningForPodcast}
              >
                {pauseMutation?.kind === "Pending" &&
                pauseMutation.scope === "Podcast"
                  ? "Remembering for this podcast…"
                  : "Remember for this podcast"}
              </Button>
            ) : null}
            {pauseDeviceActionAvailable ? (
              <Button
                variant="secondary"
                size="lg"
                disabled={pauseMutation?.kind === "Pending"}
                onClick={() =>
                  commands.setDeviceDefaultPauseShorteningMode(
                    pauseShortening.effectiveMode,
                  )
                }
              >
                {pauseMutation?.kind === "Pending" &&
                pauseMutation.scope === "Device"
                  ? "Updating device default…"
                  : "Make default on this device"}
              </Button>
            ) : null}
          </div>
          {savedOnDeviceMs > 0 ? (
            <p>
              Saved on this device ·{" "}
              {formatClock(savedOnDeviceMs / 1000)}
            </p>
          ) : null}
          {pauseMutation?.kind === "Failed" ? (
            <div className={styles.pauseFailure}>
              <FeedbackNotice feedback={pauseMutation.error} />
              {pauseMutation.retryable ? (
                <Button
                  variant="secondary"
                  size="lg"
                  onClick={pauseMutation.retry}
                >
                  Retry
                </Button>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : null}

      <section className={styles.effects} aria-labelledby="player-effects-title">
        <h3 id="player-effects-title">Output effects</h3>
        <PlayerOutputEffectsControls />
      </section>
    </div>
  );
}

export function PlayerPlaybackSheet({
  active,
  podcastTitle,
  onDismiss,
  returnFocusTo,
}: {
  readonly active: boolean;
  readonly podcastTitle: string | null;
  readonly onDismiss: () => void;
  readonly returnFocusTo: () => HTMLElement | null;
}) {
  return (
    <MobileSheet
      active={active}
      onDismiss={onDismiss}
      ariaLabel="Playback"
      returnFocusTo={returnFocusTo}
      returnFocusFallback={() =>
        document.querySelector<HTMLElement>("[data-player-playback]")
      }
    >
      <div
        className={mobileStyles.sheetFrame}
        role="region"
        aria-label="Media player"
      >
        <header className={mobileStyles.sheetHeader}>
          <div>
            <span className={mobileStyles.kicker}>Listening tools</span>
            <h2 className={mobileStyles.sheetTitle}>Playback</h2>
          </div>
          <Button variant="ghost" size="lg" onClick={onDismiss}>
            Done
          </Button>
        </header>
        <div className={mobileStyles.sheetBody}>
          <PlayerPlaybackPanel podcastTitle={podcastTitle} />
        </div>
      </div>
    </MobileSheet>
  );
}
