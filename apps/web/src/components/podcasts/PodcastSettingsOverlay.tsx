"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useTransportVerbs } from "@/components/feedback/Feedback";
import { Fact, Failed } from "@/components/feedback/Fact";
import { Ruling } from "@/components/feedback/Ruling";
import { type Line } from "@/components/feedback/stage";
import { PlaybackRateEditor, SkipSilenceField } from "@/components/player/PlayerPlaybackControls";
import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import { useAuthenticatedAccount } from "@/lib/account/authenticatedAccount";
import { useChangeStamp } from "@/lib/api/changes";
import type { ApiError } from "@/lib/api/client";
import { staleBuild, transportOf } from "@/lib/api/failure";
import { usePaneFreeServerValue } from "@/lib/api/serverState";
import { formatPlaybackRate } from "@/lib/player/playbackRate";
import { getPodcastDetail, type PodcastDetail, type PodcastSettings } from "@/lib/podcasts/api";
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
    load: async signal => (await getPodcastDetail(podcastId, signal)).data,
  });
  return source.status === "ready" ? (
    <SettingsForm key={`${accountId}:${podcastId}`} {...props} source={source.data} readError={source.error} />
  ) : (
    <Dialog open title="playback defaults" onClose={onClose}>
      {source.status === "loading" ? <Ruling />
        : source.error.code === "E_NOT_FOUND" ? <Fact line={{ fact: "this podcast isn’t available." }} speak />
        : <Failed error={source.error} noun="playback defaults" retry={{ run: source.refetch, busy: source.retrying }} />}
    </Dialog>
  );
}

function SettingsForm({ podcastId, onClose, source, readError }: Props & {
  readonly source: PodcastDetail;
  readonly readError: ApiError | null;
}) {
  const [opening] = useState(source.playback_settings);
  const guard = useWorkGuard();
  const { accountId } = useAuthenticatedAccount();
  const missing = readError?.code === "E_NOT_FOUND";
  // A refresh failure heals unseen, except a stale build, which gates the form until reload.
  const reloadRequired = readError !== null && !missing && transportOf(readError) === "Update";
  const live = useRef(false);
  useLayoutEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const gateId = useId();
  const transportVerbs = useTransportVerbs();
  const save = usePodcastSettingsSave(podcastId, source.podcast.title, `${accountId}:${podcastId}`, () => live.current);
  const operation = save.state;
  useEffect(() => {if (operation?.kind === "Accepted") onClose();}, [operation, onClose]);
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
  const defaults = (speed: number | null, mode: PodcastSettings["pause_shortening_mode"]) =>
    `speed ${speed === null ? "not set (1×)" : formatPlaybackRate(speed)} · skip silence on android: ${mode === null ? "not set (off)" : mode === "Natural" ? "on" : "off"}`;
  const unread = operation?.kind === "ReadFailed" && operation.reason === "Conflict";
  const fact: Line | null = reloadRequired ? { fact: staleBuild() }
    : replaced ? { fact: "these defaults were replaced elsewhere." }
    : absent ? { fact: "this podcast isn’t available." }
    : operation?.kind === "Review" ? { fact: operation.reason === "Conflict" ? "these defaults changed elsewhere." : "the saved defaults differ from this change." }
    : unread ? { fact: "these defaults changed elsewhere.", reason: "couldn’t load the current ones." }
    : needsCheck ? { fact: "check the saved defaults before saving again." }
    : null;
  const check = { label: "check", commandKey: `check podcast defaults ${podcastId}`, run: save.check };
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
      {fact ? <div id={gateId}><Fact line={fact}
        verbs={reloadRequired ? transportVerbs("Update") ?? undefined : needsCheck ? [check] : undefined} /></div> : null}
      {reviewed && !replaced && !absent && operation?.kind === "Review" ? <div className={styles.comparison}>
        <p>saved defaults: {defaults(reviewed.default_playback_speed, reviewed.pause_shortening_mode)}</p>
        <p>proposed defaults: {defaults(default_playback_speed, pause_shortening_mode)}</p>
      </div> : null}
      <div className={styles.actions}>
        {!absent && !replaced ? <Button emphasis="strong" size="comfortable" disabled={save.busy || needsCheck || reloadRequired} aria-busy={save.busy || undefined} aria-describedby={fact ? gateId : undefined} aria-label="save playback defaults" onClick={() => void submit()}>
          save
        </Button> : null}
        <Button size="comfortable" aria-label="close playback defaults" onClick={() => { if (requestDismiss()) onClose(); }}>close</Button>
      </div>
    </div>
  </Dialog>;
}
