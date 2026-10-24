"use client";

import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { usePaneFreeServerValue } from "@/lib/api/serverState";
import { forecastEpisodeTranscripts, type EpisodeState } from "@/lib/podcasts/api";
import { installedApp } from "@/lib/native/admission";
import { podcastErrorMessage } from "@/lib/podcasts/paneState";
import type { ReturnFocusTarget } from "@/lib/ui/overlay";
import styles from "./PodcastCommands.module.css";

/** Existing transcript eligibility and admission, shown before an account command. */
export default function PodcastTranscriptDialog({ podcastId, title, state, returnFocusTo, returnFocusFallback, onClose }: {
  readonly podcastId: string;
  readonly title: string;
  readonly state: EpisodeState;
  readonly returnFocusTo: ReturnFocusTarget;
  readonly returnFocusFallback: ReturnFocusTarget;
  readonly onClose: () => void;
}) {
  const { ctx } = useActionRuntime();
  const source = usePaneFreeServerValue({ key: `podcast-transcript-review:${ctx.accountId}:${podcastId}:${state}`, stale: "", load: signal => forecastEpisodeTranscripts(podcastId, state, signal) });
  const pending = ctx.podcastEpisodes.pending(podcastId);
  const connectionRequired = installedApp && !ctx.online;
  const scopeLabel = state === "all" ? "all episodes" : `all ${state === "in_progress" ? "in-progress" : state} episodes`;
  const submit = () => {
    if (connectionRequired || source.status !== "ready" || source.error !== null || source.refreshing || source.data.eligible_count === 0 || pending !== null) return;
    const outcome = ctx.podcastEpisodes.submit({ podcastId, title, scopeLabel, command: { kind: "Transcripts", body: {
      target: { kind: "PodcastEpisodeQuery", podcast_id: podcastId, selection: { state }, reason: "search" }, selection_fingerprint: source.data.selection_fingerprint,
    } } });
    if (outcome === "Started") onClose();
  };
  return <Dialog open title="transcribe episodes" onClose={onClose} returnFocusTo={returnFocusTo} returnFocusFallback={returnFocusFallback}>
    <div className={styles.form}>
      <p>{title}</p>
      {source.status === "loading" ? <PaneLoadingState label="checking selected items…" announcement="Polite" /> : source.status === "failed"
        ? <FeedbackNotice content={podcastErrorMessage(source.error, "couldn’t check eligible episodes.")} announcement="Polite" actions={[{ label: "retry", onClick: source.refetch, busy: source.retrying }]} />
        : <>
          <p>{source.data.eligible_count} eligible episode{source.data.eligible_count === 1 ? "" : "s"} · {scopeLabel}.</p>
          <p>this selection includes episodes beyond the loaded page. sort and text filters do not narrow it.</p>
          {source.data.eligible_count === 0 ? <FeedbackNotice content={{ tone: "Neutral", title: "no eligible episodes to transcribe." }} announcement="Polite" /> : null}
          {source.error !== null ? <FeedbackNotice content={podcastErrorMessage(source.error, "couldn’t refresh transcript eligibility.")} announcement="Polite" /> : null}
        </>}
      {pending !== null ? <FeedbackNotice content={{ tone: "Warning", title: "resolve the pending episode action first." }} announcement="Polite" /> : null}
      {connectionRequired ? <FeedbackNotice content={{ tone: "Neutral", title: "requires a connection" }} announcement="Polite" /> : null}
      <div className={styles.actions}><Button emphasis="strong" disabled={connectionRequired || source.status !== "ready" || source.error !== null || source.refreshing || source.data.eligible_count === 0 || pending !== null} onClick={submit}>transcribe episodes</Button><Button onClick={onClose}>cancel</Button></div>
    </div>
  </Dialog>;
}
