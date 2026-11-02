"use client";

/** Episode removal reviews physical destinations and retains exact guards in the
 * account owner. Closing the dialog never retires an uncertain request. */
import { useLayoutEffect, useRef, useState } from "react";
import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import { Fact, Failed } from "@/components/feedback/Fact";
import { Ruling } from "@/components/feedback/Ruling";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { useChangeStamp } from "@/lib/api/changes";
import { usePaneFreeServerValue } from "@/lib/api/serverState";
import { libraryDisplayName } from "@/lib/collections/presenters/library";
import { getEpisodeRemovalPreview } from "@/lib/podcasts/api";
import type { ReturnFocusTarget } from "@/lib/ui/overlay";
import styles from "./PodcastCommands.module.css";

export default function EpisodeRemovalDialog({ mediaId, title, returnFocusTo, returnFocusFallback, onClose }: {
  readonly mediaId: string;
  readonly title: string;
  readonly returnFocusTo: ReturnFocusTarget;
  readonly returnFocusFallback: ReturnFocusTarget;
  readonly onClose: () => void;
}) {
  const { ctx } = useActionRuntime();
  const [sending, setSending] = useState(false);
  const live = useRef(false);
  useLayoutEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const stamp = useChangeStamp("Libraries", "Podcasts", "Entries");
  const source = usePaneFreeServerValue({ key: `episode-removal:${ctx.accountId}:${mediaId}`, stale: stamp,
    load: signal => getEpisodeRemovalPreview(mediaId, signal),
  });
  const subject = `episode-remove:${mediaId}`;
  const pending = ctx.podcasts.pending(subject);
  const submit = async () => {
    if (source.status !== "ready" || source.error !== null || source.refreshing || sending || pending !== null || !source.data.can_execute) return;
    const preview = source.data;
    setSending(true);
    await ctx.podcasts.submit({ subject, title, shown: () => live.current, onAccepted: () => { if (live.current) onClose(); }, command: {
      kind: "EpisodeRemove", mediaId, body: { expected_removal_revision: preview.removal_revision,
        destinations: preview.destinations.map(destination => ({ library_id: destination.library_id,
          expected_subscription_id: destination.subscription_id, expected_import_id: destination.import_id,
          expected_import_attempt_version: destination.import_attempt_version, expected_order_revision: destination.order_revision })),
      },
    } });
    if (live.current) setSending(false);
  };
  return <Dialog open title="remove from all?" onClose={onClose} returnFocusTo={returnFocusTo} returnFocusFallback={returnFocusFallback}>
    <div className={styles.form}>
      <p>{title}</p>
      {source.status === "loading" ? <Ruling /> : source.status === "failed"
        ? <Failed error={source.error} noun="affected libraries" retry={{ run: source.refetch }} /> : <>
          <p>remove this episode from every affected library:</p>
          <ul className={styles.destinations}>{source.data.destinations.map(destination => <li key={destination.library_id}>{libraryDisplayName(destination)}{destination.is_shared ? " · shared library" : ""}</li>)}</ul>
          <p>transcripts, notes, highlights, listening history, queue, lectern and device downloads stay.</p>
          {source.data.blocked.length > 0 ? <Fact line={source.data.blocked.some(item => item.reason === "subscription_active")
            ? { fact: "a podcast subscription includes this episode.", reason: "unsubscribe from its podcast everywhere first." }
            : { fact: `only a library admin can remove it from ${source.data.blocked.map(item => item.name).join(", ")}.` }} /> : null}
          {source.error !== null ? <Fact line={{ fact: "couldn’t refresh affected libraries.", reason: "they may be out of date." }}
            verbs={[{ label: "retry", commandKey: "retry affected libraries", run: source.refetch }]} /> : null}
        </>}
      {pending?.phase === "Refused" && pending.refusal !== null ? <Fact line={pending.refusal} speak
        verbs={[{ label: "check", commandKey: `check ${pending.key}`, run: () => { ctx.podcasts.review(pending.key); source.refetch(); } }]} /> : null}
      <div className={styles.actions}>
        <Button emphasis="strong" tone="danger" disabled={source.status !== "ready" || source.error !== null || source.refreshing || !source.data.can_execute || sending || pending !== null}
          aria-busy={sending || pending?.phase === "Sending" || undefined} onClick={() => void submit()}>remove from all</Button>
        <Button onClick={onClose}>cancel</Button>
      </div>
    </div>
  </Dialog>;
}
