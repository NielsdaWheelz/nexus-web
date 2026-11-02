"use client";

import { FeedbackFailure, FeedbackNotice, useFeedbackOccurrence, type FeedbackContent } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import ChoiceField from "@/components/ui/ChoiceField";
import { useAuthenticatedAccount } from "@/lib/account/authenticatedAccount";
import { useChangeStamp } from "@/lib/api/changes";
import { usePaneFreeServerValue } from "@/lib/api/serverState";
import { assertNever } from "@/lib/assertNever";
import { formatClock } from "@/lib/formatClock";
import { formatPlaybackRate } from "@/lib/player/playbackRate";
import * as Player from "@/lib/player/playerRuntime";
import { getPodcastSettings, type PodcastSettings } from "@/lib/podcasts/api";
import { podcastErrorMessage } from "@/lib/podcasts/paneState";
import { usePodcastSettingsSave } from "@/lib/podcasts/usePodcastSettingsSave";
import { cx } from "@/lib/ui/cx";
import PlaybackRateEditor from "./PlaybackRateEditor";
import { PlayerFailures } from "./PlayerFailures";
import styles from "./PlaybackSettings.module.css";

type Loaded = Extract<Player.PlayerState, { kind: "Loaded" }>;
export type PlaybackSettings = ReturnType<typeof usePlaybackSettings>;

/**
 * The loaded podcast's saved defaults and this load's save. The player root owns it:
 * its status reaches identity while the panel is closed, and a save outlives the picker.
 */
export function usePlaybackSettings({ loaded, playbackSubject, preferences, opening }: {
  readonly loaded: Loaded | null;
  readonly playbackSubject: string | null;
  readonly preferences: Player.PlaybackPreferences | null;
  /** each opening of the panel rereads the saved defaults. */
  readonly opening: number;
}) {
  const { accountId } = useAuthenticatedAccount();
  const podcastId = loaded?.source.descriptor.podcast_id ?? null;
  const stamp = useChangeStamp("Podcasts");
  const read = usePaneFreeServerValue({
    key: podcastId === null ? null : `podcast-settings:${accountId}:${podcastId}:${playbackSubject}`,
    stale: `${stamp}:${opening}`,
    load: signal => {
      if (podcastId === null) throw new Error("a podcast read requires a podcast");
      return getPodcastSettings(podcastId, signal);
    },
  });
  const readOccurrence = useFeedbackOccurrence(read.status !== "loading" && read.error !== null, podcastId);
  const save = usePodcastSettingsSave(podcastId, playbackSubject === null ? null : `${accountId}:${playbackSubject}`);
  const operation = save.state;
  let status: string | null = null;
  let failed = false;
  if (operation !== null) {
    switch (operation.kind) {
      case "Saving": break;
      case "Reading": break;
      case "Unknown":
      case "ReadFailed": status = "save not confirmed. open playback settings to check."; failed = true; break;
      case "Rejected": status = "couldn’t save podcast defaults. open playback settings to try again."; failed = true; break;
      case "Review":
      case "Replaced":
      case "Absent": status = "saved settings need review. open playback settings."; failed = true; break;
      case "Accepted": break;
      default: assertNever(operation);
    }
  }
  if (preferences !== null) {
    switch (preferences.application.kind) {
      case "Ready": break;
      case "Applying": break;
      case "Failed": status = "couldn’t apply playback settings. open playback settings to try again."; failed = true; break;
      default: assertNever(preferences.application);
    }
  }
  return { status, failed, read, readOccurrence, save };
}

/** Live fields, then this podcast's saved defaults. The caller owns every state shown here. */
export function PlaybackPanel({ loaded, preferences, supportsSilenceSkipping, settings, presentation }: {
  readonly loaded: Loaded;
  readonly preferences: Player.PlaybackPreferences;
  readonly supportsSilenceSkipping: boolean;
  readonly settings: PlaybackSettings;
  readonly presentation: "Popup" | "Embedded";
}) {
  const commands = Player.usePlayerCommands();
  const { read, readOccurrence, save } = settings;
  const episode = loaded.source.descriptor;
  const podcast = episode.subtitle ?? "this podcast";
  const saved = read.status === "ready" ? read.data : null;
  const defaults = (rate: number | null, mode: PodcastSettings["pause_shortening_mode"]) =>
    `speed ${rate === null ? "not set (1×)" : formatPlaybackRate(rate)} · android default: skip silence ${mode === null ? "not set (off)" : mode === "Natural" ? "on" : "off"}`;
  const operation = save.state;
  const reviewed = operation?.kind === "Review" ? operation.current : null;
  const baseline = reviewed ?? saved;
  const confirmedMissing = (read.status === "failed" || read.status === "ready") && read.error?.code === "E_NOT_FOUND";
  const replaced = !confirmedMissing && (operation?.kind === "Replaced" || Boolean(operation && saved && operation.command.patch.id !== saved.id && saved.id !== null));
  const missing = confirmedMissing || (!replaced && operation?.kind === "Absent");
  const needsCheck = operation?.kind === "Unknown" || operation?.kind === "ReadFailed";
  const readReady = read.status === "ready" && read.error === null && !read.refreshing;
  const remember = () => {
    if (!baseline || !readReady || preferences.application.kind !== "Ready" || save.busy || needsCheck || missing || replaced) return;
    void save.save({
      id: baseline.id ?? crypto.randomUUID(),
      expected_settings_version: baseline.settings_version,
      default_playback_speed: preferences.rate,
      pause_shortening_mode: supportsSilenceSkipping ? (preferences.skipSilence ? "Natural" : "Off") : baseline.pause_shortening_mode,
    });
  };
  let feedback: FeedbackContent | null = null;
  if (replaced) feedback = { tone: "Warning", title: "playback defaults changed. reopen settings before saving." };
  else if (missing) feedback = { tone: "Warning", title: "this podcast is unavailable. current playback is unchanged." };
  else if (operation?.kind === "Review") feedback = { tone: "Warning",
    title: operation.reason === "Conflict" ? "podcast defaults changed elsewhere." : "the saved settings do not confirm this request.",
    message: `${podcast}: ${defaults(operation.command.patch.default_playback_speed, operation.command.patch.pause_shortening_mode)}` };
  return <section className={cx(styles.panel, presentation === "Popup" ? styles.popup : styles.embedded)} aria-label="playback">
    <div className={styles.panelHeading}>
      <h2>playback</h2>
      <p className={styles.podcastName}>{podcast}</p>
    </div>
    <PlaybackRateEditor value={preferences.rate} onChange={commands.setPlaybackRate} label="speed" />
    {supportsSilenceSkipping ? <SkipSilenceField checked={preferences.skipSilence} onChange={commands.setShortenPauses} label="skip silence" />
      : <p className={styles.eyebrow}>skip silence · android app only</p>}
    <SavedSilence />
    <PlayerFailures />
    {save.feedback}
    {episode.podcast_id !== null ? <div className={styles.panelRow}>
      {!missing && !replaced ? <Button reserveIcon busyKey={operation?.command} size="comfortable" className={styles.remember} aria-busy={save.busy || undefined} disabled={!readReady || save.busy || preferences.application.kind !== "Ready" || needsCheck} onClick={remember}>
        {supportsSilenceSkipping ? "remember settings for this podcast" : "remember speed for this podcast"}
      </Button> : null}
      {feedback ? <FeedbackNotice content={feedback} announcement="None" /> : null}
      {operation && operation.kind !== "Accepted" && operation.kind !== "Saving" && !missing && !replaced ? <p className={styles.eyebrow}>requested for {podcast}: {defaults(operation.command.patch.default_playback_speed, operation.command.patch.pause_shortening_mode)}</p> : null}
      {reviewed && !replaced ? <div className={styles.comparison}>
        <p>saved defaults: {defaults(reviewed.default_playback_speed, reviewed.pause_shortening_mode)}</p>
        <p>proposed defaults: {defaults(preferences.rate, supportsSilenceSkipping ? (preferences.skipSilence ? "Natural" : "Off") : reviewed.pause_shortening_mode)}</p>
      </div> : null}
      {(!operation || operation.kind === "Accepted") && saved ? <p className={styles.eyebrow}>saved defaults: {defaults(saved.default_playback_speed, saved.pause_shortening_mode)}</p> : null}
      {!missing && ((read.status === "failed") || (read.status === "ready" && read.error)) ? <FeedbackFailure scope="Local" occurrence={readOccurrence} content={podcastErrorMessage(read.error, "couldn’t load podcast defaults.")} announcement="None" actions={[{ label: "retry loading", onClick: read.refetch }]} /> : null}
    </div> : null}
  </section>;
}

/** Only this line reads the clock, so the panel stays still while the estimate grows. */
function SavedSilence() {
  const { savedSilenceMs } = Player.usePlayerTimeline();
  return savedSilenceMs > 0 ? <p className={styles.eyebrow}>approx. time saved on this device · {formatClock(savedSilenceMs / 1000)}</p> : null;
}

/** The caller owns capability, live effects and saved defaults. */
export function SkipSilenceField({
  checked,
  onChange,
  label,
}: {
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly label: string;
}) {
  return <ChoiceField label={label} checked={checked} onChange={onChange}
    description="shorten quiet gaps between speech." />;
}
