"use client";

import { useState } from "react";
import { FeedbackNotice, FeedbackState, type FeedbackContent, type FeedbackActions } from "@/components/feedback/Feedback";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import { PlaybackPreferencesEditor } from "@/components/player/PlayerPlaybackControls";
import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import { useAuthenticatedAccount } from "@/lib/account/authenticatedAccount";
import { assertNever } from "@/lib/assertNever";
import { useChangeStamp } from "@/lib/api/changes";
import type { ApiError } from "@/lib/api/client";
import { usePaneFreeServerValue } from "@/lib/api/serverState";
import { formatPlaybackRate } from "@/lib/player/playbackRate";
import { getPodcastDetail, type PodcastDetail } from "@/lib/podcasts/api";
import { podcastErrorMessage } from "@/lib/podcasts/paneState";
import { useSubscriptionSettingsSave } from "@/lib/podcasts/useSubscriptionSettingsSave";
import { useResourceDraft } from "@/lib/resourceGraph/useResourceDraft";
import { useWorkGuard } from "@/lib/unsavedWork";
import styles from "./PodcastSubscriptionSettingsOverlay.module.css";

interface Props {
  readonly podcastId: string;
  readonly onClose: () => void;
}

/** An opening read supplies the draft's identity and version; refresh never rebases it. */
export default function PodcastSubscriptionSettingsOverlay(props: Props) {
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
    <Dialog open title="subscription settings" onClose={onClose}>
      {source.status === "failed" ? <FeedbackState content={source.error.code === "E_NOT_FOUND"
        ? { tone: "Warning", title: "this podcast is no longer followed." }
        : podcastErrorMessage(source.error, "couldn’t load subscription settings.")}
        announcement="Polite" actions={source.error.code === "E_NOT_FOUND" ? undefined : [{ label: "retry loading", busy: source.retrying, onClick: source.refetch }]} />
        : <PaneLoadingState label="loading subscription settings…" announcement="Polite" />}
    </Dialog>
  );
}

function SettingsForm({ podcastId, onClose, source, readError, retryRead }: Props & {
  readonly source: PodcastDetail;
  readonly readError: ApiError | null;
  readonly retryRead: () => void;
}) {
  const [opening] = useState(source.subscription);
  const guard = useWorkGuard();
  const draft = useResourceDraft(`PodcastSettings:${podcastId}`, () => ({
    rate: opening?.default_playback_speed ?? 1,
    skipSilence: opening?.pause_shortening_mode === "Natural",
  }), value => ({
    changed: value.rate !== (opening?.default_playback_speed ?? 1) ||
      value.skipSilence !== (opening?.pause_shortening_mode === "Natural"),
    unconfirmed: false,
    stopsBrowserWork: false,
  }));
  const { rate, skipSilence } = draft.value;
  const { accountId } = useAuthenticatedAccount();
  const missing = readError?.code === "E_NOT_FOUND";
  const readFeedback = readError === null || missing ? null : podcastErrorMessage(readError, "couldn’t reload subscription settings.");
  const reloadRequired = readFeedback?.reload === true;
  const identity = missing || source.subscription === null ? "absent" : source.subscription.subscription_id;
  const save = useSubscriptionSettingsSave(podcastId, opening === null ? null : `${accountId}:${podcastId}:${opening.subscription_id}:${identity}:${reloadRequired}`);
  const operation = save.state;
  const reviewed = operation?.kind === "Review" ? operation.current : null;
  const baseline = reviewed ?? opening;
  const pairChanged = rate !== (baseline?.default_playback_speed ?? 1) || skipSilence !== (baseline?.pause_shortening_mode === "Natural");
  const replaced = !missing && (operation?.kind === "Replaced" || (source.subscription !== null && source.subscription.subscription_id !== opening?.subscription_id));
  const absent = !replaced && (operation?.kind === "Absent" || missing || source.subscription === null);
  const needsCheck = operation?.kind === "Unknown" || operation?.kind === "ReadFailed";
  const requestDismiss = () => !save.busy && guard.confirmLoss({ scopes: [], ownerIds: [draft.owner, save.ownerId] });
  const submit = async () => {
    if (save.busy || absent || replaced || needsCheck || reloadRequired || baseline === null) return;
    if (!pairChanged) { onClose(); return; }
    const accepted = await save.save({
      expected_subscription_id: baseline.subscription_id,
      expected_settings_version: baseline.settings_version,
      default_playback_speed: rate,
      pause_shortening_mode: skipSilence ? "Natural" : "Off",
    });
    if (accepted) onClose();
  };
  const check = () => { void save.check().then(accepted => { if (accepted) onClose(); }); };
  const pair = (speed: number, on: boolean) => `${formatPlaybackRate(speed)} · silence ${on ? "on" : "off"}`;
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
        feedback = podcastErrorMessage(operation.error, "couldn’t save subscription settings.");
        if (rate === (operation.command.patch.default_playback_speed ?? 1) &&
          skipSilence === (operation.command.patch.pause_shortening_mode === "Natural")) {
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
        feedback = { tone: "Warning", title: operation.reason === "Conflict" ? "subscription settings changed elsewhere." : "the saved settings do not confirm this request." };
        break;
      case "Absent":
        feedback = { tone: "Warning", title: "this podcast is no longer followed." };
        break;
      case "Replaced":
        feedback = { tone: "Warning", title: "this podcast’s subscription changed. reopen settings before saving." };
        break;
      case "Accepted":
        break;
      default:
        assertNever(operation);
    }
  }
  if (replaced) {
    feedback = { tone: "Warning", title: "this podcast’s subscription changed. reopen settings before saving." };
    actions = undefined;
  } else if (absent) {
    feedback = { tone: "Warning", title: "this podcast is no longer followed." };
    actions = undefined;
  }
  if (reloadRequired) {
    feedback = readFeedback;
    actions = undefined;
  }
  return <Dialog open onClose={onClose} title="subscription settings"
    onDismissRequest={() => requestDismiss() ? "accepted" : "blocked"}
    initialFocus={card => card.querySelector<HTMLElement>('input[type="range"]')}>
    <div className={styles.form}>
      <p className={styles.podcastName}>{source.podcast.title}</p>
      <p className={styles.note}>edit this podcast’s defaults. saving leaves current playback unchanged.</p>
      {opening !== null ? <fieldset className={styles.fields} disabled={save.busy || absent || replaced || needsCheck || reloadRequired}>
        <PlaybackPreferencesEditor rate={rate} skipSilence={skipSilence}
          onRateChange={rate => draft.set(value => ({ ...value, rate }))}
          onSkipSilenceChange={skipSilence => draft.set(value => ({ ...value, skipSilence }))} />
      </fieldset> : null}
      {feedback ? <FeedbackNotice content={feedback} announcement="Polite" actions={actions} /> : null}
      {readFeedback && !reloadRequired ? <FeedbackNotice content={readFeedback} announcement="Polite" actions={[{ label: "retry loading", onClick: retryRead }]} /> : null}
      {reviewed && !replaced && !absent && operation?.kind === "Review" ? <div className={styles.comparison}>
        {pairChanged ? <>
          <p>saved playback: {pair(reviewed.default_playback_speed ?? 1, reviewed.pause_shortening_mode === "Natural")}</p>
          <p>proposed playback: {pair(rate, skipSilence)}</p>
        </> : null}
      </div> : null}
      <div className={styles.actions}>
        {!absent && !replaced ? <Button variant="primary" size="lg" disabled={save.busy || needsCheck || reloadRequired} aria-label={save.busy ? "saving subscription settings" : reviewed ? "save my settings" : "save subscription settings"} onClick={() => void submit()}>
          {save.busy ? "saving…" : reviewed ? "save my settings" : "save"}
        </Button> : null}
        <Button variant="secondary" size="lg" disabled={save.busy} aria-label="close subscription settings" onClick={() => { if (requestDismiss()) onClose(); }}>close</Button>
      </div>
    </div>
  </Dialog>;
}
