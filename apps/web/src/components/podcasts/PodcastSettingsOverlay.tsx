"use client";

import { useState } from "react";
import { FeedbackNotice, FeedbackState, type FeedbackContent, type FeedbackActions } from "@/components/feedback/Feedback";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import { PlaybackRateEditor, SkipSilenceField } from "@/components/player/PlayerPlaybackControls";
import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import { useAuthenticatedAccount } from "@/lib/account/authenticatedAccount";
import { assertNever } from "@/lib/assertNever";
import { useChangeStamp } from "@/lib/api/changes";
import type { ApiError } from "@/lib/api/client";
import { usePaneFreeServerValue } from "@/lib/api/serverState";
import { formatPlaybackRate } from "@/lib/player/playbackRate";
import { getPodcastDetail, type PodcastDetail, type PodcastSettings } from "@/lib/podcasts/api";
import { podcastErrorMessage } from "@/lib/podcasts/paneState";
import { usePodcastSettingsSave } from "@/lib/podcasts/usePodcastSettingsSave";
import { useResourceDraft } from "@/lib/resourceGraph/useResourceDraft";
import { useWorkGuard } from "@/lib/unsavedWork";
import styles from "./PodcastSettingsOverlay.module.css";

interface Props {
  readonly podcastId: string;
  readonly onClose: () => void;
}

/** An opening read supplies the draft's identity and version; refresh never rebases it. */
export default function PodcastSettingsOverlay(props: Props) {
  const { podcastId, onClose } = props;
  const { accountId } = useAuthenticatedAccount();
  const stamp = useChangeStamp("Podcasts");
  const source = usePaneFreeServerValue({
    key: `podcast-detail:${accountId}:${podcastId}`,
    stale: stamp,
    load: signal => getPodcastDetail(podcastId, signal),
  });
  return source.status === "ready" ? (
    <SettingsForm key={`${accountId}:${podcastId}`} {...props} source={source.data} readError={source.error} retryRead={source.refetch} />
  ) : (
    <Dialog open title="playback defaults" onClose={onClose}>
      {source.status === "failed" ? <FeedbackState content={source.error.code === "E_NOT_FOUND"
        ? { tone: "Warning", title: "this podcast is no longer available." }
        : podcastErrorMessage(source.error, "couldn’t load playback defaults.")}
        announcement="Polite" actions={source.error.code === "E_NOT_FOUND" ? undefined : [{ label: "retry loading", busy: source.retrying, onClick: source.refetch }]} />
        : <PaneLoadingState label="loading playback defaults…" announcement="Polite" />}
    </Dialog>
  );
}

function SettingsForm({ podcastId, onClose, source, readError, retryRead }: Props & {
  readonly source: PodcastDetail;
  readonly readError: ApiError | null;
  readonly retryRead: () => void;
}) {
  const [opening] = useState(source.playback_settings);
  const guard = useWorkGuard();
  const { accountId } = useAuthenticatedAccount();
  const missing = readError?.code === "E_NOT_FOUND";
  const readFeedback = readError === null || missing ? null : podcastErrorMessage(readError, "couldn’t reload playback defaults.");
  const reloadRequired = readFeedback?.reload === true;
  const save = usePodcastSettingsSave(podcastId, `${accountId}:${podcastId}`);
  const operation = save.state;
  const reviewed = operation?.kind === "Review" ? operation.current : null;
  const baseline = reviewed ?? opening;
  const draft = useResourceDraft(`PodcastSettings:${podcastId}:${opening.id ?? "absent"}:${opening.settings_version}`, () => ({
    default_playback_speed: opening.default_playback_speed,
    pause_shortening_mode: opening.pause_shortening_mode,
  }), value => ({
    changed: value.default_playback_speed !== baseline.default_playback_speed ||
      value.pause_shortening_mode !== baseline.pause_shortening_mode,
    unconfirmed: false,
    stopsBrowserWork: false,
  }));
  const { default_playback_speed, pause_shortening_mode } = draft.value;
  const pairChanged = default_playback_speed !== baseline.default_playback_speed || pause_shortening_mode !== baseline.pause_shortening_mode;
  const replaced = !missing && (operation?.kind === "Replaced" || (source.playback_settings.id !== null && source.playback_settings.id !== opening.id && source.playback_settings.id !== operation?.command.patch.id));
  const absent = !replaced && (operation?.kind === "Absent" || missing);
  const needsCheck = operation?.kind === "Unknown" || operation?.kind === "ReadFailed";
  const requestDismiss = () => {
    if (save.busy || needsCheck) return true;
    if (!guard.confirmLoss({ scopes: [], ownerIds: [draft.owner] })) return false;
    draft.set({
      default_playback_speed: baseline.default_playback_speed,
      pause_shortening_mode: baseline.pause_shortening_mode,
    });
    return true;
  };
  const submit = async () => {
    if (save.busy || absent || replaced || needsCheck || reloadRequired) return;
    if (!pairChanged && reviewed === null) { onClose(); return; }
    const accepted = await save.save({
      id: baseline.id ?? crypto.randomUUID(),
      expected_settings_version: baseline.settings_version,
      default_playback_speed,
      pause_shortening_mode,
    });
    if (accepted) onClose();
  };
  const check = () => { void save.check().then(accepted => { if (accepted) onClose(); }); };
  const defaults = (speed: number | null, mode: PodcastSettings["pause_shortening_mode"]) =>
    `speed ${speed === null ? "not set (1×)" : formatPlaybackRate(speed)} · skip silence on android: ${mode === null ? "not set (off)" : mode === "Natural" ? "on" : "off"}`;
  let feedback: FeedbackContent | null = null;
  let actions: FeedbackActions | undefined;
  if (operation) {
    switch (operation.kind) {
      case "Saving":
        feedback = { tone: "Neutral", title: "saving…" };
        break;
      case "Reading":
        feedback = { tone: "Neutral", title: "checking saved settings…" };
        break;
      case "Rejected":
        feedback = podcastErrorMessage(operation.error, "couldn’t save playback defaults.");
        if (default_playback_speed === operation.command.patch.default_playback_speed &&
          pause_shortening_mode === operation.command.patch.pause_shortening_mode) {
          actions = [{ label: "try again", commandKey: JSON.stringify(operation.command.patch), onClick: () => { void save.retry().then(accepted => { if (accepted) onClose(); }); } }];
        }
        break;
      case "Unknown":
        feedback = { tone: "Warning", title: "save not confirmed.", message: "the request may have succeeded. check the saved settings before trying again.", requestId: operation.error.requestId };
        actions = [{ label: "check saved settings", commandKey: JSON.stringify(operation.command.patch), onClick: check }];
        break;
      case "ReadFailed":
        feedback = podcastErrorMessage(operation.error, "couldn’t check saved settings.");
        actions = [{ label: "check saved settings", commandKey: JSON.stringify(operation.command.patch), onClick: check }];
        break;
      case "Review":
        feedback = { tone: "Warning", title: operation.reason === "Conflict" ? "playback defaults changed elsewhere." : "the saved settings do not confirm this request." };
        break;
      case "Absent":
        feedback = { tone: "Warning", title: "this podcast is no longer available." };
        break;
      case "Replaced":
        feedback = { tone: "Warning", title: "playback defaults changed. reopen settings before saving." };
        break;
      case "Accepted":
        break;
      default:
        assertNever(operation);
    }
  }
  if (replaced) {
    feedback = { tone: "Warning", title: "playback defaults changed. reopen settings before saving." };
    actions = undefined;
  } else if (absent) {
    feedback = { tone: "Warning", title: "this podcast is no longer available." };
    actions = undefined;
  }
  if (reloadRequired) {
    feedback = readFeedback;
    actions = undefined;
  }
  return <Dialog open onClose={onClose} title="playback defaults"
    onDismissRequest={() => requestDismiss() ? "accepted" : "blocked"}
    initialFocus={card => card.querySelector<HTMLElement>('input[type="range"]')}>
    <div className={styles.form}>
      <p className={styles.podcastName}>{source.podcast.title}</p>
      <p className={styles.note}>edit this podcast’s defaults. saving leaves current playback unchanged.</p>
      <fieldset className={styles.fields} disabled={save.busy || absent || replaced || needsCheck || reloadRequired}>
        <PlaybackRateEditor value={default_playback_speed ?? 1} label="speed"
          onChange={default_playback_speed => draft.set(value => ({ ...value, default_playback_speed }))} />
        <SkipSilenceField checked={pause_shortening_mode === "Natural"} label="skip silence on android"
          onChange={checked => draft.set(value => ({ ...value, pause_shortening_mode: checked ? "Natural" : "Off" }))} />
      </fieldset>
      {feedback ? <FeedbackNotice content={feedback} announcement="Polite" actions={actions} /> : null}
      {readFeedback && !reloadRequired ? <FeedbackNotice content={readFeedback} announcement="Polite" actions={[{ label: "retry loading", onClick: retryRead }]} /> : null}
      {reviewed && !replaced && !absent && operation?.kind === "Review" ? <div className={styles.comparison}>
        <p>saved defaults: {defaults(reviewed.default_playback_speed, reviewed.pause_shortening_mode)}</p>
        <p>proposed defaults: {defaults(default_playback_speed, pause_shortening_mode)}</p>
      </div> : null}
      <div className={styles.actions}>
        {!absent && !replaced ? <Button emphasis="strong" size="comfortable" disabled={save.busy || needsCheck || reloadRequired} aria-label={save.busy ? "saving playback defaults" : reviewed ? "save my settings" : "save playback defaults"} onClick={() => void submit()}>
          {save.busy ? "saving…" : reviewed ? "save my settings" : "save"}
        </Button> : null}
        <Button size="comfortable" aria-label="close playback defaults" onClick={() => { if (requestDismiss()) onClose(); }}>close</Button>
      </div>
    </div>
  </Dialog>;
}
