"use client";

import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { usePaneFreeServerValue } from "@/lib/api/serverState";
import { prepareCollectionConsumption, type CollectionSelection } from "@/lib/consumption/api";
import { installedApp } from "@/lib/native/admission";
import { podcastErrorMessage } from "@/lib/podcasts/paneState";
import type { ReturnFocusTarget } from "@/lib/ui/overlay";
import styles from "@/components/podcasts/PodcastCommands.module.css";

/** Review freezes the complete selection. Only the account owner sends its bytes. */
export default function CollectionConsumptionDialog({ selection, desiredState, title, returnFocusTo, returnFocusFallback, onClose }: {
  readonly selection: CollectionSelection;
  readonly desiredState: "finished" | "unread";
  readonly title: string;
  readonly returnFocusTo: ReturnFocusTarget;
  readonly returnFocusFallback: ReturnFocusTarget;
  readonly onClose: () => void;
}) {
  const { ctx } = useActionRuntime();
  const source = usePaneFreeServerValue({ key: `collection-state-review:${ctx.accountId}:${JSON.stringify(selection)}`, stale: "", load: signal => prepareCollectionConsumption(selection, signal) });
  const podcast = selection.kind === "Podcast";
  const verb = podcast ? desiredState === "finished" ? "played" : "unplayed" : desiredState === "finished" ? "finished" : "unread";
  const target = selection.kind === "Podcast" ? { kind: "Podcast" as const, podcast_id: selection.podcast_id } : selection;
  const pending = ctx.consumption.pendingCollection(target);
  const connectionRequired = installedApp && !ctx.online;
  const scopeLabel = selection.kind === "Podcast" && selection.state !== "all"
    ? `all ${selection.state === "in_progress" ? "in-progress" : selection.state} episodes`
    : podcast ? "the whole podcast" : "the whole library";
  const submit = () => {
    if (connectionRequired || source.status !== "ready" || source.refreshing || source.error !== null || source.data.items.length === 0 || pending !== null) return;
    const outcome = ctx.consumption.submitCollection({ title: source.data.label, scopeLabel,
      request: { target, desired_state: desiredState, items: source.data.items } });
    if (outcome === "Started") onClose();
  };
  return <Dialog open title={`mark ${verb}`} onClose={onClose} returnFocusTo={returnFocusTo} returnFocusFallback={returnFocusFallback}>
    <div className={styles.form}>
      {source.status === "loading" ? <PaneLoadingState label="checking selected items…" announcement="Polite" /> : source.status === "failed"
        ? <FeedbackNotice content={podcastErrorMessage(source.error, "couldn’t check selected items.")} announcement="Polite" actions={[{ label: "retry", onClick: source.refetch, busy: source.retrying }]} />
        : <>
          <p>{source.data.label}</p>
          <p>{source.data.items.length} {podcast ? "episode" : "item"}{source.data.items.length === 1 ? "" : "s"} selected · {scopeLabel}.</p>
          <p>{podcast ? "includes known episodes beyond this page. new episodes found later are unchanged." : "this includes accessible items beyond the loaded page. sort, text and view filters do not narrow it."}</p>
          {selection.kind === "Podcast" && selection.state !== "all" ? <p>this state selection ignores text filters and sort.</p> : null}
          <p>positions, observed history and lectern membership stay. progress is saved before changing state.</p>
          <p>undo restores the explicit states changed by the acknowledged request. it remains available in this account session; reload or sign-out clears it.</p>
          {source.data.items.length === 0 ? <FeedbackNotice content={{ tone: "Neutral", title: "no items in this selection." }} announcement="Polite" /> : null}
          {source.error !== null ? <FeedbackNotice content={podcastErrorMessage(source.error, "couldn’t check selected items.")} announcement="Polite" actions={[{ label: "review selection again", onClick: source.refetch }]} /> : null}
        </>}
      {pending !== null ? <FeedbackNotice content={{ tone: "Warning", title: pending.phase === "Sending" ? "changing selected items…" : "change not confirmed", message: pending.phase === "Sending" ? "this request remains available in workspace feedback." : "the request may have succeeded. recovery remains available in workspace feedback." }} announcement="Polite" /> : null}
      {connectionRequired ? <FeedbackNotice content={{ tone: "Neutral", title: "requires a connection" }} announcement="Polite" /> : null}
      <div className={styles.actions}>
        <Button emphasis="strong" disabled={connectionRequired || source.status !== "ready" || source.error !== null || source.refreshing || source.data.items.length === 0 || pending !== null} onClick={submit}>mark {verb}</Button>
        <Button onClick={onClose}>cancel</Button>
      </div>
      {source.status === "loading" ? <span className="sr-only">{title}</span> : null}
    </div>
  </Dialog>;
}
