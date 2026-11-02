"use client";

import { useId, useSyncExternalStore } from "react";
import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import { Fact, Failed } from "@/components/feedback/Fact";
import { Hold } from "@/components/feedback/Feedback";
import { Ruling } from "@/components/feedback/Ruling";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { isApiError } from "@/lib/api/client";
import { usePaneFreeServerValue } from "@/lib/api/serverState";
import { admissionReason } from "@/lib/collections/admissionReason";
import { prepareCollectionConsumption, type CollectionSelection } from "@/lib/consumption/api";
import { remoteAdmission, subscribeAdmission } from "@/lib/native/admission";
import type { ReturnFocusTarget } from "@/lib/ui/overlay";
import styles from "@/components/podcasts/PodcastCommands.module.css";

/** Review freezes the complete selection. Only the account owner sends its bytes. The confirm
 * waits busy on the review's read and on admission's check; one the review or admission cannot
 * vouch for stays disabled and says why.
 * An unknown outcome holds inside this dialog, in its own frame, while the dialog is open. */
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
  // The owner sends only while admission is ready, in either host. Subscribed, so the reasons
  // below read admission as it stands.
  const admission = useSyncExternalStore(subscribeAdmission, remoteAdmission, remoteAdmission);
  const admitted = admission === "Ready";
  const checking = admission === "Checking";
  const gateId = useId();
  const gate = !admitted ? admissionReason()
    : source.status === "ready" && source.error !== null ? "the selection couldn’t refresh." : null;
  const scopeLabel = selection.kind === "Podcast" && selection.state !== "all"
    ? `all ${selection.state === "in_progress" ? "in-progress" : selection.state} episodes`
    : podcast ? "the whole podcast" : "the whole library";
  const armed = admitted && source.status === "ready" && !source.refreshing && source.error === null && source.data.items.length > 0 && pending === null;
  const reviewing = source.status === "loading" || (source.status === "ready" ? source.refreshing : source.retrying);
  const submit = () => {
    if (!armed || source.status !== "ready") return;
    const outcome = ctx.consumption.submitCollection({ title: source.data.label, scopeLabel,
      request: { target, desired_state: desiredState, items: source.data.items } });
    if (outcome === "Started") onClose();
  };
  return <Dialog open title={`mark ${verb}`} onClose={onClose} returnFocusTo={returnFocusTo} returnFocusFallback={returnFocusFallback}>
    <div className={styles.form}>
      {source.status === "loading" ? <Ruling /> : source.status === "failed"
        ? isApiError(source.error) && source.error.status === 404
          ? <Fact line={{ fact: podcast ? "this podcast is no longer available." : "this library is no longer available." }} />
          : <Failed error={source.error} noun="selected items" retry={{ run: source.refetch, busy: source.retrying }} />
        : <>
          <p>{source.data.label}</p>
          <p>{source.data.items.length} {podcast ? "episode" : "item"}{source.data.items.length === 1 ? "" : "s"} selected · {scopeLabel}.</p>
          <p>{podcast ? "includes known episodes beyond this page. new episodes found later are unchanged." : "this includes accessible items beyond the loaded page. sort, text and view filters do not narrow it."}</p>
          {selection.kind === "Podcast" && selection.state !== "all" ? <p>this state selection ignores text filters and sort.</p> : null}
          <p>positions, observed history and lectern membership stay. progress is saved before changing state.</p>
          <p>undo stays available until you reload or sign out.</p>
          {source.data.items.length === 0 ? <Fact line={{ fact: `no items to mark ${verb}.` }} /> : null}
        </>}
      {pending?.failed ? <Hold id={pending.commandKey} attempt={pending.attempt}
        line={{ fact: "not sure that saved.", reason: "it may have gone through." }}
        verbs={[
          { label: "retry", commandKey: `retry ${pending.commandKey}`, busy: pending.phase === "Sending" || checking,
            disabledReason: admissionReason() ?? undefined, run: () => ctx.consumption.retry(pending.commandKey) },
          { label: "forget", commandKey: `forget ${pending.commandKey}`, busy: pending.phase === "Sending", run: () => ctx.consumption.forget(pending.commandKey) },
        ]} /> : null}
      <div className={styles.actions}>
        <Button emphasis="strong" aria-busy={pending?.phase === "Sending" || reviewing || checking || undefined} aria-describedby={gate === null ? undefined : gateId}
          disabled={!armed} onClick={submit}>mark {verb}</Button>
        <Button onClick={onClose}>cancel</Button>
        {gate === null ? null : <span id={gateId} className={styles.note}>{gate}</span>}
      </div>
      {source.status === "loading" ? <span className="sr-only">{title}</span> : null}
    </div>
  </Dialog>;
}
