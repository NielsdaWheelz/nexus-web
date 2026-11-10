"use client";

import { useId, useState, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import { Fact, Failed } from "@/components/feedback/Fact";
import { Hold, useOutcome, useResendFeedback } from "@/components/feedback/Feedback";
import { Ruling } from "@/components/feedback/Ruling";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { isApiError } from "@/lib/api/client";
import { usePaneFreeServerValue, useThrowLater } from "@/lib/api/serverState";
import { admissionReason, UNKNOWN_OUTCOME_REASON } from "@/lib/api/failure";
import type { CollectionTarget } from "@/lib/consumption/api";
import { prepareCollectionLectern } from "@/lib/lectern/api";
import { LecternReadFailure } from "@/lib/lectern/lectern";
import { remoteAdmission, subscribeAdmission } from "@/lib/native/admission";
import type { ReturnFocusTarget } from "@/lib/ui/overlay";
import styles from "@/components/feeds/FeedCommands.module.css";

/** One complete, fixed-order append enters the existing account lectern lane. An unknown append
 * holds here with its retry, gated as admission stands, while the dialog is open, named when it
 * is another collection's; the lane blocks other changes meanwhile. A
 * refusal, or a retry that finds the lectern moved, rereads what moved, and the confirm re-arms
 * when the reads land. The confirm waits busy on its reads and on admission's check; one they
 * cannot vouch for stays disabled and says why. */
export default function CollectionLecternDialog({ target, title, returnFocusTo, returnFocusFallback, onClose }: {
  readonly target: CollectionTarget;
  readonly title: string;
  readonly returnFocusTo: ReturnFocusTarget;
  readonly returnFocusFallback: ReturnFocusTarget;
  readonly onClose: () => void;
}) {
  const { ctx } = useActionRuntime();
  const resendFeedback = useResendFeedback();
  const fail = useThrowLater();
  const outcome = useOutcome();
  const pending = ctx.lectern.collectionPending;
  const ownPending = pending !== null && JSON.stringify(pending.target) === JSON.stringify(target);
  // The owner sends only while admission is ready, in either host. Subscribed, so the reasons
  // below read admission as it stands.
  const admission = useSyncExternalStore(subscribeAdmission, remoteAdmission, remoteAdmission);
  const admitted = admission === "Ready";
  const checking = admission === "Checking";
  const lectern = ctx.lectern.read;
  const [sending, setSending] = useState(false);
  const gateId = useId();
  const source = usePaneFreeServerValue({ key: `collection-lectern-review:${ctx.accountId}:${JSON.stringify(target)}`, stale: "", load: signal => prepareCollectionLectern(target, signal) });
  const accountReady = lectern.status === "ready" && lectern.error === null && !lectern.refreshing;
  const reviewing = lectern.status === "loading" || (lectern.status === "ready" ? lectern.refreshing : lectern.retrying)
    || source.status === "loading" || (source.status === "ready" ? source.refreshing : source.retrying);
  const prepared = source.status === "ready" ? source.data : null;
  const needed = prepared === null ? 0 : prepared.media_ids.length - prepared.already_present_count;
  const capacity = prepared !== null && needed > prepared.available_slots;
  const armed = admitted && prepared !== null && source.status === "ready" && source.error === null && !source.refreshing
    && prepared.media_ids.length > 0 && !capacity && !sending && pending === null && accountReady;
  const gate = !admitted ? admissionReason()
    : source.status === "ready" && source.error !== null ? "the selection couldn’t refresh."
      : lectern.status === "ready" && lectern.error !== null ? "the lectern couldn’t refresh." : null;
  const submit = async () => {
    if (!armed || prepared === null) return;
    const fact = `couldn’t add “${prepared.label}” to the lectern.`;
    const reread = () => { lectern.refetch(); source.refetch(); };
    setSending(true);
    try {
      const result = await ctx.lectern.addCollection({ title: prepared.label, onAcknowledged: () => flushSync(onClose), request: { target, media_ids: prepared.media_ids, expected_order_revision: prepared.expected_order_revision } });
      if (result === "Busy") { outcome.say({ fact, reason: "another lectern change isn’t settled yet." }); reread(); }
      else if (result === "Moved") { outcome.say({ fact }); reread(); }
    } catch (error) {
      outcome.fail(error, fact);
      reread();
    } finally { setSending(false); }
  };
  return <Dialog open title="add unfinished items to lectern" onClose={onClose} returnFocusTo={returnFocusTo} returnFocusFallback={returnFocusFallback}>
    <div className={styles.form}>
      {source.status === "loading" ? <Ruling /> : source.status === "failed"
        ? isApiError(source.error) && source.error.status === 404
          ? <Fact line={{ fact: target.kind === "Feed" && target.feed_kind === "podcast" ? "this podcast is no longer available." : "this library is no longer available." }} />
          : <Failed error={source.error} noun="selected items" retry={{ run: source.refetch, busy: source.retrying }} />
        : <>
          <p>{source.data.label}</p>
          <p>{source.data.media_ids.length} unfinished item{source.data.media_ids.length === 1 ? "" : "s"} selected, including in-progress items.</p>
          <p>{needed} new · {source.data.already_present_count} already in lectern. existing items keep their positions.</p>
          <p>{target.kind === "Feed" && target.feed_kind === "podcast" ? "episodes append oldest publication first." : "contents append in the library’s stored order; all uses newest added first."} this captures the whole accessible collection, ignoring page, sort, text and filters. new arrivals are excluded; future items are not added automatically.</p>
          {source.data.media_ids.length === 0 ? <Fact line={{ fact: "no unfinished items to add." }} /> : null}
          {capacity ? <Fact line={{ fact: source.data.available_slots === 0 ? "the lectern is full." : `the lectern has room for ${source.data.available_slots} of ${needed}.`,
            reason: "nothing is added until all fit." }} /> : null}
        </>}
      {lectern.status === "failed" ? <LecternReadFailure error={lectern.error} retry={{ run: lectern.refetch, busy: lectern.retrying }} /> : null}
      {pending !== null && pending.phase !== "Sending" ? <Hold id="lectern-collection" attempt={pending.attempt}
        {...resendFeedback({ line: { fact: ownPending ? "not sure that saved." : `not sure adding “${pending.title}” to the lectern saved.`, reason: UNKNOWN_OUTCOME_REASON }, resend: { label: "retry", commandKey: "lectern-collection", busy: pending.phase === "Checking",
          run: () => void pending.check().then(settled => { if (settled === "Superseded") source.refetch(); }, (error: unknown) => fail({ error })) } })} /> : null}
      <div className={styles.actions}>
        <Button emphasis="strong" aria-busy={sending || reviewing || checking || undefined} aria-describedby={gate === null ? undefined : gateId}
          disabled={!armed} onClick={() => void submit()}>add to lectern</Button>
        <Button onClick={onClose}>cancel</Button>
        {gate === null ? null : <span id={gateId} className={styles.note}>{gate}</span>}
      </div>
      {source.status === "loading" ? <span className="sr-only">{title}</span> : null}
    </div>
  </Dialog>;
}
