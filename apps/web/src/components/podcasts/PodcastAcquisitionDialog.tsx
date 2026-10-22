"use client";

/** One explicit destination, two acquisition modes. Opening never acquires. */
import { useId, useState } from "react";
import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { useChangeStamp } from "@/lib/api/changes";
import { usePaneFreeServerValue } from "@/lib/api/serverState";
import { getLibrary } from "@/lib/libraries/api";
import { getDefaultPodcastLibrary, getLibraryPodcasts, type PodcastTarget } from "@/lib/podcasts/api";
import { podcastErrorMessage } from "@/lib/podcasts/paneState";
import type { ReturnFocusTarget } from "@/lib/ui/overlay";
import styles from "./PodcastCommands.module.css";

export default function PodcastAcquisitionDialog({ target, title, libraryId, onAccepted, returnFocusTo, returnFocusFallback, onClose }: {
  readonly target: PodcastTarget;
  readonly title: string;
  readonly libraryId: string | null;
  readonly onAccepted?: () => void;
  readonly returnFocusTo?: ReturnFocusTarget;
  readonly returnFocusFallback?: ReturnFocusTarget;
  readonly onClose: () => void;
}) {
  const { ctx } = useActionRuntime();
  const modeId = useId();
  const [mode, setMode] = useState<"follow" | "current_episodes">("follow");
  const [sending, setSending] = useState(false);
  const [refused, setRefused] = useState(false);
  const stamp = useChangeStamp("Podcasts", "Entries", "Libraries");
  const source = usePaneFreeServerValue({ key: `podcast-destination:${ctx.accountId}:${libraryId ?? "default"}`, stale: stamp,
    load: async signal => {
      const id = libraryId ?? await getDefaultPodcastLibrary(signal);
      const [section, library] = await Promise.all([getLibraryPodcasts(id, signal), getLibrary(id, signal)]);
      return { id, section, library };
    },
  });
  const subject = `admission:${libraryId ?? "default"}:${target.kind === "Canonical" ? target.podcast_id : target.target}`;
  const pending = ctx.podcasts.pending(subject);
  const submit = async () => {
    if (source.status !== "ready" || source.error !== null || source.refreshing || !source.data.section.can_add_content || pending !== null || sending) return;
    const { id, section } = source.data;
    const guards = { target, expected_order_revision: section.order_revision, expected_removal_revision: section.removal_revision };
    setSending(true);
    const accepted = await ctx.podcasts.submit({ subject, title, onAccepted, command: mode === "follow"
      ? { kind: "Admission", libraryId: id, mode, body: { ...guards, id: crypto.randomUUID(), import_id: crypto.randomUUID() } }
      : { kind: "Admission", libraryId: id, mode, body: { ...guards, id: crypto.randomUUID() } } });
    setSending(false);
    if (accepted) onClose(); else setRefused(true);
  };
  return <Dialog open onClose={onClose} returnFocusTo={returnFocusTo} returnFocusFallback={returnFocusFallback} title={libraryId === null ? "add podcast…" : source.status === "ready" ? `add to ${source.data.library.name}` : "add podcast…"}>
    <div className={styles.form}>
      <p>{title}</p>
      <fieldset className={styles.choices} disabled={sending || pending !== null}>
        <legend className="sr-only">what to add</legend>
        <label><input type="radio" name="podcast-mode" aria-label="podcast + episodes" aria-describedby={`${modeId}-follow`} checked={mode === "follow"} onChange={() => setMode("follow")} /><span>podcast + episodes<small id={`${modeId}-follow`}>add available episodes now and new episodes automatically</small></span></label>
        <label><input type="radio" name="podcast-mode" aria-label="current episodes only" aria-describedby={`${modeId}-once`} checked={mode === "current_episodes"} onChange={() => setMode("current_episodes")} /><span>current episodes only<small id={`${modeId}-once`}>import available episodes once; no ongoing subscription</small></span></label>
      </fieldset>
      <p className={styles.note}>history is limited to what the publisher makes available. this does not download audio or request transcripts.</p>
      {source.status === "loading" ? <PaneLoadingState label="checking destination…" announcement="Polite" /> : source.error !== null ? <FeedbackNotice content={podcastErrorMessage(source.error, "couldn’t load the destination.")} announcement="Polite" actions={[{ label: "retry loading", onClick: source.refetch }]} /> : !source.data.section.can_add_content ? <FeedbackNotice content={{ tone: "Warning", title: "only a library admin can add this podcast." }} announcement="Polite" /> : null}
      {refused ? <FeedbackNotice content={{ tone: "Warning", title: pending?.phase === "Unknown" ? "add not confirmed" : "review the current destination before choosing again.", message: "pending requests remain available in workspace feedback after closing." }} announcement="Polite" actions={pending?.phase === "Refused" ? [{ label: "review destination", onClick: () => { ctx.podcasts.review(pending.key); source.refetch(); setRefused(false); } }] : undefined} /> : null}
      <div className={styles.actions}>
        <Button emphasis="strong" aria-busy={sending || undefined} disabled={sending || pending !== null || source.status !== "ready" || source.error !== null || source.refreshing || !source.data.section.can_add_content} onClick={() => void submit()}>{sending ? "adding…" : mode === "follow" ? "subscribe" : "add current episodes"}</Button>
        <Button onClick={onClose}>close</Button>
      </div>
    </div>
  </Dialog>;
}
