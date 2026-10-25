"use client";

/** One reviewed destination. The primary subscribe action fixes follow mode;
 * library organization chooses podcast or once-only episodes before admission. */
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import RadioGroup from "@/components/ui/RadioGroup";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { useChangeStamp } from "@/lib/api/changes";
import { usePaneFreeServerValue } from "@/lib/api/serverState";
import { libraryDisplayName } from "@/lib/collections/presenters/library";
import { getLibrary } from "@/lib/libraries/api";
import { getDefaultPodcastLibrary, getLibraryPodcast, getLibraryPodcasts, type PodcastTarget } from "@/lib/podcasts/api";
import { podcastErrorMessage } from "@/lib/podcasts/paneState";
import type { ReturnFocusTarget } from "@/lib/ui/overlay";
import PodcastImportProgress from "./PodcastImportProgress";
import styles from "./PodcastCommands.module.css";

interface AcquisitionProps {
  readonly target: PodcastTarget;
  readonly title: string;
  readonly mode: "follow" | "choose";
  readonly libraryId: string | null;
  readonly onAccepted?: () => void;
  readonly onChangeDestination?: () => void;
  readonly onUnsubscribe?: () => void;
  readonly createdLibrary?: boolean;
  readonly returnFocusTo?: ReturnFocusTarget;
  readonly returnFocusFallback?: ReturnFocusTarget;
  readonly onClose: () => void;
}
export default function PodcastAcquisitionDialog(props: AcquisitionProps) {
  const [mode, setMode] = useState<"follow" | "current_episodes">("follow");
  const focusStage = useCallback((element: HTMLDivElement | null) => { element?.focus({ preventScroll: true }); }, []);
  const handoff = useRef(false);
  const pending = useActionRuntime().ctx.podcasts.pending(`admission:${JSON.stringify([props.libraryId, props.target.kind, props.target.kind === "Canonical" ? props.target.podcast_id : props.target.target])}`);
  return <Dialog open onClose={props.onClose} returnFocusTo={props.returnFocusTo} returnFocusFallback={props.returnFocusFallback} skipReturnFocus={() => handoff.current}
    title={props.mode === "follow" ? `subscribe to ${props.title}?` : "add to library"}>
    <div className={styles.form}>
      {props.mode === "choose" ? <p>{props.title}</p> : null}
      {props.onChangeDestination ? <Button disabled={pending !== null} onClick={() => { handoff.current = true; props.onChangeDestination?.(); }}>change destination</Button> : null}
      <div key={`${props.libraryId ?? "personal"}:${mode}`} ref={focusStage} tabIndex={-1} role="group" aria-label="review addition" className={styles.form}>
        <AcquisitionReview {...props} mode={props.mode === "follow" ? "follow" : mode}
          onModeChange={props.mode === "choose" ? value => {
            if (value !== "follow" && value !== "current_episodes") throw new Error("unknown podcast addition mode");
            setMode(value);
          } : null}
          onUnsubscribe={props.onUnsubscribe ? () => { handoff.current = true; props.onUnsubscribe?.(); } : undefined} />
      </div>
    </div>
  </Dialog>;
}
function AcquisitionReview({ target, title, mode, libraryId, onAccepted, createdLibrary, onClose, onModeChange, onUnsubscribe }: Omit<AcquisitionProps, "mode"> & {
  readonly mode: "follow" | "current_episodes";
  readonly onModeChange: ((value: string) => void) | null;
}) {
  const { ctx } = useActionRuntime();
  const [sending, setSending] = useState(false);
  const live = useRef(false);
  useLayoutEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const [refused, setRefused] = useState(false);
  const [dispatched, setDispatched] = useState(false);
  const stamp = useChangeStamp("Podcasts", "Entries", "Libraries");
  const source = usePaneFreeServerValue({ key: `podcast-admission:${JSON.stringify([libraryId, target, mode])}`, stale: stamp,
    load: async signal => {
      const id = libraryId ?? await getDefaultPodcastLibrary(signal);
      const [library, facts] = await Promise.all([
        getLibrary(id, signal).then(read => read.data),
        target.kind === "Canonical" ? getLibraryPodcast(id, target.podcast_id, signal) : getLibraryPodcasts(id, signal).then(read => read.data),
      ]);
      return { id, library, facts };
    },
  });
  if (source.status !== "ready") return <>
    {source.status === "loading" ? <PaneLoadingState label="checking destination…" announcement="Polite" />
      : <FeedbackNotice content={podcastErrorMessage(source.error, "couldn’t load the destination.")} announcement="Polite" actions={[{ label: "retry loading", onClick: source.refetch }]} />}
    <div className={styles.actions}>
      <Button onClick={onClose}>cancel</Button>
    </div>
  </>;
  const { id, library, facts } = source.data;
  const destination = library.is_default ? "all" : libraryDisplayName(library);
  const subject = `admission:${JSON.stringify([id, target.kind, target.kind === "Canonical" ? target.podcast_id : target.target])}`;
  const pending = ctx.podcasts.pending(subject);
  const following = "subscription" in facts && facts.subscription !== null;
  const operation = "import" in facts ? facts.import : null;
  const unfinished = operation !== null && (operation.state === "pending" || operation.state === "running" || operation.state === "failed");
  const blocked = !facts.can_add_content || unfinished || following;
  const submit = async () => {
    if (source.error !== null || source.refreshing || blocked || pending !== null || sending || refused) return;
    const guards = { target, expected_order_revision: facts.order_revision, expected_removal_revision: facts.removal_revision };
    setDispatched(true);
    setSending(true);
    const accepted = await ctx.podcasts.submit({ subject, title: `${title} · ${destination}`, onAccepted: () => {
      if (mode === "follow") onAccepted?.();
      if (live.current) onClose();
    }, command: mode === "follow"
      ? { kind: "Admission", libraryId: id, mode, body: { ...guards, id: crypto.randomUUID(), import_id: crypto.randomUUID() } }
      : { kind: "Admission", libraryId: id, mode, body: { ...guards, id: crypto.randomUUID() } } });
    setSending(false);
    if (!accepted && live.current) setRefused(true);
  };
  return <>
    {createdLibrary && (!dispatched || pending?.phase === "Refused") ? <p>library created; addition not started</p> : null}
    <p>destination: {destination}</p>
    {onModeChange !== null ? <RadioGroup label="add" value={mode} choices={[
      { value: "follow", label: "podcast" }, { value: "current_episodes", label: "episodes", disabled: following },
    ]} disabled={pending !== null || sending || source.refreshing || source.error !== null} onChange={onModeChange} /> : null}
    <p>{mode === "follow" ? "add available history and new episodes automatically." : "add available history once. subscriptions stay unchanged."}</p>
    <p className={styles.note}>history is limited to what the publisher makes available. this does not download audio or request transcripts.</p>
    {!facts.can_add_content ? <FeedbackNotice content={{ tone: "Warning", title: following ? "a library admin must change this subscription." : "only a library admin can add this podcast." }} announcement="Polite" /> : null}
    {following ? <FeedbackNotice content={{ tone: "Neutral", title: `already subscribed in ${destination}.` }} announcement="Polite" /> : null}
    {operation !== null ? <PodcastImportProgress operation={operation} title={title} /> : null}
    {source.error !== null ? <FeedbackNotice content={podcastErrorMessage(source.error, "couldn’t refresh the destination.")} announcement="Polite" /> : null}
    {refused || pending !== null && pending.phase !== "Sending" ? <FeedbackNotice content={{ tone: "Warning", title: pending?.phase === "Unknown" ? "change not confirmed" : "review the current destination before choosing again.", message: pending?.phase === "Unknown" ? "the request may have succeeded. recovery remains available in workspace feedback." : "this confirmation is disarmed." }} announcement="Polite" actions={pending?.phase === "Refused" ? [{ label: "review destination", onClick: () => { ctx.podcasts.review(pending.key); source.refetch(); setRefused(false); } }] : undefined} /> : null}
    <div className={styles.actions}>
      <Button emphasis="strong" aria-busy={sending || pending?.phase === "Sending" || undefined} disabled={sending || refused || pending !== null || source.error !== null || source.refreshing || blocked} onClick={() => void submit()}>{mode === "follow" ? "subscribe" : "add episodes"}</Button>
      {following && onUnsubscribe ? <Button disabled={sending || pending !== null || source.error !== null || source.refreshing || !facts.can_add_content} onClick={onUnsubscribe}>unsubscribe…</Button> : null}
      <Button onClick={onClose}>cancel</Button>
    </div>
  </>;
}
