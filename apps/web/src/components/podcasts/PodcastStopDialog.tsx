"use client";

/** This preview is the final confirmation. Mode changes remount its read and
 * disarm submission; a stale response cannot confirm another mode's scope.
 */
import { useState } from "react";
import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { usePaneFreeServerValue } from "@/lib/api/serverState";
import { getPodcastRemovalPreview } from "@/lib/podcasts/api";
import { podcastErrorMessage } from "@/lib/podcasts/paneState";
import type { ReturnFocusTarget } from "@/lib/ui/overlay";
import styles from "./PodcastCommands.module.css";

interface Props {
  readonly podcastId: string;
  readonly title: string;
  readonly libraryId: string | null;
  readonly episodes: "keep" | "remove";
  readonly removeOnly?: boolean;
  readonly onClose: () => void;
  readonly returnFocusTo?: ReturnFocusTarget;
  readonly returnFocusFallback?: ReturnFocusTarget;
}
export default function PodcastStopDialog(props: Props) {
  const [episodes, setEpisodes] = useState(props.episodes);
  const [removeAfterStop, setRemoveAfterStop] = useState(false);
  const [stoppedFirst, setStoppedFirst] = useState(false);
  const { ctx } = useActionRuntime();
  const sending = ctx.podcasts.pending(`stop:${props.podcastId}`)?.phase === "Sending";
  return <Dialog open onClose={props.onClose} returnFocusTo={props.returnFocusTo} returnFocusFallback={props.returnFocusFallback} title={props.libraryId === null ? `${props.removeOnly ? "remove episodes from" : "stop"} ${props.title} everywhere?` : `stop adding ${props.title}?`}>
    <div className={styles.form}>
      {!props.removeOnly ? <fieldset className={styles.choices} disabled={sending}>
        <legend className="sr-only">episode removal</legend>
        <label><input type="radio" name="podcast-stop-mode" checked={episodes === "keep"} onChange={() => setEpisodes("keep")} />keep episodes</label>
        <label><input type="radio" name="podcast-stop-mode" checked={episodes === "remove"} onChange={() => setEpisodes("remove")} />remove podcast and episodes</label>
      </fieldset> : null}
      {stoppedFirst ? <p>automatic additions are stopped. review the current episode count before removing episodes.</p> : null}
      <StopPreview key={episodes} {...props} episodes={episodes}
        onKeep={() => { setRemoveAfterStop(true); setEpisodes("keep"); }}
        onSaved={() => {
          if (removeAfterStop && episodes === "keep") { setRemoveAfterStop(false); setStoppedFirst(true); setEpisodes("remove"); }
          else props.onClose();
        }} />
    </div>
  </Dialog>;
}
function StopPreview({ podcastId, title, libraryId, episodes, removeOnly, onClose, onKeep, onSaved }: Props & { onKeep: () => void; onSaved: () => void }) {
  const { ctx } = useActionRuntime();
  const [sending, setSending] = useState(false);
  const [stale, setStale] = useState(false);
  const source = usePaneFreeServerValue({ key: `podcast-stop-preview:${ctx.accountId}:${podcastId}:${libraryId ?? "all"}:${episodes}`, stale: "opening",
    load: signal => getPodcastRemovalPreview(podcastId, libraryId === null ? "all" : "library", episodes, libraryId, signal),
  });
  const subject = `stop:${podcastId}`;
  const pending = ctx.podcasts.pending(subject);
  if (source.status === "loading") return <PaneLoadingState label="checking affected libraries and episodes…" announcement="Polite" />;
  if (source.status === "failed") return <FeedbackNotice content={podcastErrorMessage(source.error, "couldn’t check affected libraries.")} announcement="Polite" actions={[{ label: "retry preview", onClick: source.refetch }]} />;
  const preview = source.data;
  const all = libraryId === null;
  const count = preview.episode_count;
  const submit = async () => {
    if (sending || stale || source.error !== null || source.refreshing || !preview.can_execute || pending !== null) return;
    setSending(true);
    const accepted = await ctx.podcasts.submit({ subject, title, command: { kind: "Stop", podcastId, body: {
      scope: preview.scope, episodes: preview.episodes, expected_removal_revision: preview.removal_revision,
      destinations: preview.destinations.map(destination => ({ library_id: destination.library_id,
        expected_subscription_id: destination.subscription_id, expected_import_id: destination.import_id,
        expected_import_attempt_version: destination.import_attempt_version,
        expected_order_revision: episodes === "remove" ? destination.order_revision : null })),
    } } });
    setSending(false);
    if (accepted) onSaved(); else setStale(true);
  };
  const review = () => {
    if (pending?.phase !== "Refused") return;
    ctx.podcasts.review(pending.key); source.refetch(); setStale(false);
  };
  const stopKeeping = () => {
    if (pending?.phase !== "Refused") return;
    ctx.podcasts.review(pending.key); onKeep();
  };
  return <>
    <p>{all ? "affected libraries:" : "library:"}</p>
    <ul className={styles.destinations}>{preview.destinations.map(destination => <li key={destination.library_id}>{destination.is_default ? "all (personal retention)" : destination.name}{destination.is_shared ? " · shared library; other members’ access may change" : ""}</li>)}</ul>
    <p>{count} distinct {count === 1 ? "episode" : "episodes"}{episodes === "keep" ? " will stay." : all ? " will be removed from the affected libraries and your lectern." : " will be removed from this library, including individually added episodes."}</p>
    <p>{episodes === "keep" ? "stop automatic additions and unfinished imports. keep episodes already added." : "your notes, highlights and listening progress are kept. playback defaults are kept."}</p>
    {!all && episodes === "remove" ? <p>episodes stay in all and your other libraries.</p> : null}
    {preview.blocked.length > 0 ? <FeedbackNotice content={{ tone: "Warning", title: "this change needs a library admin.", message: preview.blocked.map(item => item.name).join(", ") }} announcement="Polite" /> : null}
    {source.error !== null ? <FeedbackNotice content={podcastErrorMessage(source.error, "couldn’t refresh this preview.")} announcement="Polite" /> : null}
    {stale ? <FeedbackNotice content={{ tone: "Warning", title: pending?.phase === "Unknown" ? "change not confirmed" : "library changed. review it and choose again.", message: "this confirmation is disarmed. close and reopen it to review the current state." }} announcement="Polite" actions={pending?.phase === "Refused" ? episodes === "remove" && !removeOnly
      ? [{ label: "review this scope", onClick: review }, { label: "stop adding; keep episodes instead", onClick: stopKeeping }]
      : [{ label: "review this scope", onClick: review }] : undefined} /> : null}
    <div className={styles.actions}>
      <Button emphasis="strong" tone={episodes === "remove" ? "danger" : undefined} aria-busy={sending || undefined} disabled={sending || stale || source.error !== null || source.refreshing || !preview.can_execute || pending !== null} onClick={() => void submit()}>
        {episodes === "remove" ? `remove podcast and ${count} episodes${all ? " everywhere" : ""}` : all ? "stop everywhere; keep episodes" : "stop adding; keep episodes"}
      </Button>
      <Button onClick={onClose}>close</Button>
    </div>
  </>;
}
