"use client";

/** Episode removal reviews physical destinations and retains exact guards in the
 * account owner. Closing the dialog never retires an uncertain request. */
import { useLayoutEffect, useRef, useState } from "react";
import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { useChangeStamp } from "@/lib/api/changes";
import { usePaneFreeServerValue } from "@/lib/api/serverState";
import { libraryDisplayName } from "@/lib/collections/presenters/library";
import { getEpisodeRemovalPreview } from "@/lib/podcasts/api";
import { podcastErrorMessage } from "@/lib/podcasts/paneState";
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
  const [stale, setStale] = useState(false);
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
    if (source.status !== "ready" || source.error !== null || source.refreshing || stale || sending || pending !== null || !source.data.can_execute) return;
    const preview = source.data;
    setSending(true);
    const accepted = await ctx.podcasts.submit({ subject, title, onAccepted: () => { if (live.current) onClose(); }, command: {
      kind: "EpisodeRemove", mediaId, body: { expected_removal_revision: preview.removal_revision,
        destinations: preview.destinations.map(destination => ({ library_id: destination.library_id,
          expected_subscription_id: destination.subscription_id, expected_import_id: destination.import_id,
          expected_import_attempt_version: destination.import_attempt_version, expected_order_revision: destination.order_revision })),
      },
    } });
    if (live.current) { setSending(false); if (!accepted) setStale(true); }
  };
  return <Dialog open title="remove from all?" onClose={onClose} returnFocusTo={returnFocusTo} returnFocusFallback={returnFocusFallback}>
    <div className={styles.form}>
      <p>{title}</p>
      {source.status === "loading" ? <PaneLoadingState label="checking episode placements…" announcement="Polite" /> : source.status === "failed"
        ? <FeedbackNotice content={podcastErrorMessage(source.error, "couldn’t check episode placements.")} announcement="Polite" actions={[{ label: "retry", onClick: source.refetch }]} /> : <>
          <p>remove this episode from every affected library:</p>
          <ul className={styles.destinations}>{source.data.destinations.map(destination => <li key={destination.library_id}>{libraryDisplayName(destination)}{destination.is_shared ? " · shared library" : ""}</li>)}</ul>
          <p>transcripts, notes, highlights, listening history, queue, lectern and device downloads stay.</p>
          {source.data.blocked.length > 0 ? <FeedbackNotice content={{ tone: "Warning", title: source.data.blocked.some(item => item.reason === "subscription_active")
            ? "included by a podcast subscription" : "a library admin must remove this episode.",
            message: source.data.blocked.some(item => item.reason === "subscription_active") ? "unsubscribe from every contributing library before removing this episode from all." : source.data.blocked.map(item => item.name).join(", "),
          }} announcement="Polite" /> : null}
          {source.error !== null ? <FeedbackNotice content={podcastErrorMessage(source.error, "couldn’t refresh episode placements.")} announcement="Polite" /> : null}
        </>}
      {stale || pending !== null && pending.phase !== "Sending" ? <FeedbackNotice content={{ tone: "Warning", title: pending?.phase === "Unknown" ? "change not confirmed" : "episode placements changed. review them before confirming.",
        message: pending?.phase === "Unknown" ? "the request may have succeeded. exact-request recovery remains in workspace feedback." : "this confirmation is disarmed.",
      }} announcement="Polite" actions={pending?.phase === "Refused" ? [{ label: "review placements", onClick: () => { ctx.podcasts.review(pending.key); source.refetch(); setStale(false); } }] : undefined} /> : null}
      <div className={styles.actions}>
        <Button emphasis="strong" tone="danger" disabled={source.status !== "ready" || source.error !== null || source.refreshing || !source.data.can_execute || stale || sending || pending !== null}
          aria-busy={sending || pending?.phase === "Sending" || undefined} onClick={() => void submit()}>remove from all</Button>
        <Button onClick={onClose}>cancel</Button>
      </div>
    </div>
  </Dialog>;
}
