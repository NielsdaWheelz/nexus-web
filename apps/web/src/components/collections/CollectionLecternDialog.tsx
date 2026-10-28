"use client";

import { useState } from "react";
import { flushSync } from "react-dom";
import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { modeledApiError, usePaneFreeServerValue, useThrowLater } from "@/lib/api/serverState";
import type { CollectionTarget } from "@/lib/consumption/api";
import { prepareCollectionLectern } from "@/lib/lectern/api";
import { installedApp } from "@/lib/native/admission";
import { podcastErrorMessage } from "@/lib/podcasts/paneState";
import type { ReturnFocusTarget } from "@/lib/ui/overlay";
import styles from "@/components/podcasts/PodcastCommands.module.css";

/** One complete, fixed-order append enters the existing account lectern lane. An
 * unconfirmed append stays here with its check; the lane blocks other changes meanwhile. */
export default function CollectionLecternDialog({ target, title, returnFocusTo, returnFocusFallback, onClose }: {
  readonly target: CollectionTarget;
  readonly title: string;
  readonly returnFocusTo: ReturnFocusTarget;
  readonly returnFocusFallback: ReturnFocusTarget;
  readonly onClose: () => void;
}) {
  const { ctx } = useActionRuntime();
  const fail = useThrowLater();
  const pending = ctx.lectern.collectionPending;
  const connectionRequired = installedApp && !ctx.online;
  const lectern = ctx.lectern.read;
  const [sending, setSending] = useState(false);
  const [refused, setRefused] = useState(false);
  const source = usePaneFreeServerValue({ key: `collection-lectern-review:${ctx.accountId}:${JSON.stringify(target)}`, stale: "", load: signal => prepareCollectionLectern(target, signal) });
  const accountBusy = lectern.status === "loading" || (lectern.status === "ready" ? lectern.refreshing : lectern.retrying);
  const accountReady = lectern.status === "ready" && lectern.error === null && !lectern.refreshing;
  const selectionBusy = source.status === "loading" || (source.status === "ready" ? source.refreshing : source.retrying);
  const reviewing = accountBusy || selectionBusy;
  const accountError = lectern.status === "failed" || lectern.status === "ready" ? lectern.error : null;
  const prepared = source.status === "ready" ? source.data : null;
  const needed = prepared === null ? 0 : prepared.media_ids.length - prepared.already_present_count;
  const capacity = prepared !== null && needed > prepared.available_slots;
  const submit = async () => {
    if (connectionRequired || prepared === null || source.status !== "ready" || source.error !== null || source.refreshing || prepared.media_ids.length === 0 || capacity || sending || refused || pending !== null || !accountReady) return;
    setSending(true);
    try {
      const outcome = await ctx.lectern.addCollection({ title: prepared.label, onAcknowledged: () => flushSync(onClose), request: { target, media_ids: prepared.media_ids, expected_order_revision: prepared.expected_order_revision } });
      if (outcome === "Superseded") setRefused(true);
    } catch (error) {
      const modeled = modeledApiError(error, fail);
      if (modeled !== null) setRefused(true);
    } finally { setSending(false); }
  };
  const reviewAgain = () => {
    if (reviewing || sending || pending !== null) return;
    setRefused(false);
    lectern.refetch();
    source.refetch();
  };
  return <Dialog open title="add unfinished items to lectern" onClose={onClose} returnFocusTo={returnFocusTo} returnFocusFallback={returnFocusFallback}>
    <div className={styles.form}>
      {source.status === "loading" ? <PaneLoadingState label="checking selected items…" announcement="Polite" /> : source.status === "failed"
        ? <FeedbackNotice content={podcastErrorMessage(source.error, "couldn’t check selected items.")} announcement="Polite" actions={[{ label: "retry", onClick: source.refetch, busy: source.retrying }]} />
        : <>
          <p>{source.data.label}</p>
          <p>{source.data.media_ids.length} unfinished item{source.data.media_ids.length === 1 ? "" : "s"} selected, including in-progress items.</p>
          <p>{needed} new · {source.data.already_present_count} already in lectern. existing items keep their positions.</p>
          <p>{target.kind === "Podcast" ? "episodes append oldest publication first." : "contents append in the library’s stored order; all uses newest added first."} this captures the whole accessible collection, ignoring page, sort, text and filters. new arrivals are excluded; future items are not added automatically.</p>
          {source.data.media_ids.length === 0 ? <FeedbackNotice content={{ tone: "Neutral", title: "no items in this selection." }} announcement="Polite" /> : null}
          {capacity ? <FeedbackNotice content={{ tone: "Warning", title: "not enough lectern space", message: `${needed} slots required; ${source.data.available_slots} available. nothing will be added until the whole selection fits.` }} announcement="Polite" /> : null}
          {source.error !== null ? <FeedbackNotice content={podcastErrorMessage(source.error, "couldn’t check selected items.")} announcement="Polite" /> : null}
        </>}
      {accountBusy ? <PaneLoadingState label="checking lectern…" announcement="Polite" /> : null}
      {accountError !== null ? <FeedbackNotice content={podcastErrorMessage(accountError, "couldn’t load lectern.")} announcement="Polite"
        actions={[{ label: "retry loading lectern", onClick: lectern.refetch, busy: accountBusy, disabledReason: accountBusy ? "checking lectern…" : undefined }]} /> : null}
      {pending !== null ? <FeedbackNotice content={{ tone: "Warning", title: pending.phase === "Unconfirmed" ? "change not confirmed" : "updating lectern…", message: pending.phase === "Unconfirmed" ? "the request may have succeeded. checking retains the same reviewed order and items." : "resolve this lectern request before adding another selection." }} announcement="Polite"
        actions={pending.phase === "Sending" ? undefined : [{ label: "check lectern change", busy: pending.phase === "Checking",
          onClick: () => void pending.check().then(outcome => { if (outcome === "Superseded") setRefused(true); }, error => fail({ error })) }]} /> : null}
      {refused ? <FeedbackNotice content={{ tone: "Warning", title: "this selection needs another review", message: "the lectern or selected items changed. this confirmation is disarmed." }} announcement="Polite" actions={[{ label: "review selection again", onClick: reviewAgain, busy: reviewing, disabledReason: reviewing ? "checking lectern and selected items…" : sending || pending !== null ? "resolve the pending lectern change first." : undefined }]} /> : null}
      {connectionRequired ? <FeedbackNotice content={{ tone: "Neutral", title: "requires a connection" }} announcement="Polite" /> : null}
      <div className={styles.actions}>
        <Button emphasis="strong" aria-busy={sending || reviewing || undefined} disabled={connectionRequired || prepared === null || source.status !== "ready" || source.error !== null || source.refreshing || prepared.media_ids.length === 0 || capacity || sending || refused || pending !== null || !accountReady} onClick={() => void submit()}>add to lectern</Button>
        <Button onClick={onClose}>cancel</Button>
      </div>
      {source.status === "loading" ? <span className="sr-only">{title}</span> : null}
    </div>
  </Dialog>;
}
