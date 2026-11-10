"use client";

/** Entry removal reviews physical destinations and retains exact guards in the
 * account owner. Closing the dialog never retires an uncertain request. */
import { useLayoutEffect, useRef, useState } from "react";
import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import { Fact, Failed } from "@/components/feedback/Fact";
import CommandRefusal from "./CommandRefusal";
import FeedRemovalBlockers from "./FeedRemovalBlockers";
import { Ruling } from "@/components/feedback/Ruling";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { useChangeStamp } from "@/lib/api/changes";
import { usePaneFreeServerValue } from "@/lib/api/serverState";
import { libraryDisplayName } from "@/lib/collections/presenters/library";
import { getFeedEntryRemovalPreview } from "@/lib/feeds/api";
import type { ReturnFocusTarget } from "@/lib/ui/overlay";
import styles from "./FeedCommands.module.css";

export default function FeedEntryRemovalDialog({ mediaId, title, returnFocusTo, returnFocusFallback, onClose }: {
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
  const stamp = useChangeStamp("Libraries", "Feeds", "Entries");
  const source = usePaneFreeServerValue({ key: `episode-removal:${ctx.accountId}:${mediaId}`, stale: stamp,
    load: signal => getFeedEntryRemovalPreview(mediaId, signal),
  });
  const subject = `episode-remove:${mediaId}`;
  const pending = ctx.feeds.pending(subject);
  const submit = async () => {
    if (source.status !== "ready" || source.error !== null || source.refreshing || sending || pending !== null || !source.data.can_execute) return;
    const preview = source.data;
    setSending(true);
    await ctx.feeds.submit({ subject, title, shown: () => live.current, onAccepted: () => { if (live.current) onClose(); }, command: {
      kind: "EntryRemove", mediaId, body: { expected_removal_revision: preview.removal_revision,
        destinations: preview.destinations.map(destination => ({ library_id: destination.library_id,
          imports: destination.imports.map(item => ({ import_id: item.import_id, expected_attempt_version: item.attempt_version })), expected_order_revision: destination.order_revision })),
      },
    } });
    if (live.current) setSending(false);
  };
  return <Dialog open title="remove from all?" onClose={onClose} returnFocusTo={returnFocusTo} returnFocusFallback={returnFocusFallback}>
    <div className={styles.form}>
      <p>{title}</p>
      {source.status === "loading" ? <Ruling /> : source.status === "failed"
        ? <Failed error={source.error} noun="affected libraries" retry={{ run: source.refetch }} /> : <>
          <p>remove this item from every affected library:</p>
          <ul className={styles.destinations}>{source.data.destinations.map(destination => <li key={destination.library_id}>{libraryDisplayName(destination)}{destination.is_shared ? " · shared library" : ""}</li>)}</ul>
          <p>notes, highlights, history, lectern and device downloads stay.</p>
          <FeedRemovalBlockers blocked={source.data.blocked} destinations={source.data.destinations} />
          {source.error !== null ? <Fact line={{ fact: "couldn’t refresh affected libraries.", reason: "they may be out of date." }}
            verbs={[{ label: "retry", commandKey: "retry affected libraries", run: source.refetch }]} /> : null}
        </>}
      <CommandRefusal subject={subject} reread={source.refetch} />
      <div className={styles.actions}>
        <Button emphasis="strong" tone="danger" disabled={source.status !== "ready" || source.error !== null || source.refreshing || !source.data.can_execute || sending || pending !== null}
          aria-busy={sending || pending?.phase === "Sending" || undefined} onClick={() => void submit()}>remove from all</Button>
        <Button onClick={onClose}>cancel</Button>
      </div>
    </div>
  </Dialog>;
}
