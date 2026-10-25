"use client";

/** Fixed subscription or finite import. A single dialog owns destination choice
 * and review; canonical admission reads the exact selected relationship.
 */
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import { podcastPendingNotice } from "@/lib/podcasts/commands";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { useChangeStamp } from "@/lib/api/changes";
import { usePaneFreeServerValue } from "@/lib/api/serverState";
import { libraryDisplayName } from "@/lib/collections/presenters/library";
import { getLibrary } from "@/lib/libraries/api";
import { getDefaultPodcastLibrary, getLibraryPodcast, getLibraryPodcasts, type PodcastTarget } from "@/lib/podcasts/api";
import { podcastErrorMessage } from "@/lib/podcasts/paneState";
import type { ReturnFocusTarget } from "@/lib/ui/overlay";
import PodcastDestinationChooser from "./PodcastDestinationChooser";
import PodcastImportProgress from "./PodcastImportProgress";
import styles from "./PodcastCommands.module.css";

interface AcquisitionProps {
  readonly target: PodcastTarget;
  readonly title: string;
  readonly mode: "follow" | "current_episodes";
  readonly libraryId: string | null;
  readonly onAccepted?: () => void;
  readonly createdLibrary?: boolean;
  readonly returnFocusTo?: ReturnFocusTarget;
  readonly returnFocusFallback?: ReturnFocusTarget;
  readonly onClose: () => void;
}
export default function PodcastAcquisitionDialog(props: AcquisitionProps) {
  const [destination, setDestination] = useState<string | null>(null);
  const focusStage = useCallback((element: HTMLDivElement | null) => { element?.focus({ preventScroll: true }); }, []);
  const choosing = props.mode === "current_episodes" && destination === null;
  const libraryId = props.mode === "follow" ? props.libraryId : destination;
  return <Dialog open onClose={props.onClose} returnFocusTo={props.returnFocusTo} returnFocusFallback={props.returnFocusFallback}
    title={props.mode === "follow" ? `subscribe to ${props.title}?` : "import available episodes"}>
    <div className={styles.form}>
      {props.mode === "current_episodes" ? <p>{props.title}</p> : null}
      <div key={choosing ? "choose" : libraryId ?? "personal"} ref={focusStage} tabIndex={-1} role="group" aria-label={choosing ? "choose an import destination" : props.mode === "follow" ? "review subscription" : "review import"} className={styles.form}>
        {choosing ? <>
          <p>choose one destination for this import.</p>
          <PodcastDestinationChooser target={props.target} onChoose={setDestination} />
          <div className={styles.actions}><Button onClick={props.onClose}>cancel</Button></div>
        </> : <AcquisitionReview {...props} libraryId={libraryId} onChangeDestination={() => setDestination(null)} />}
      </div>
    </div>
  </Dialog>;
}
function AcquisitionReview({ target, title, mode, libraryId, onAccepted, createdLibrary, onClose, onChangeDestination }: AcquisitionProps & { readonly onChangeDestination: () => void }) {
  const { ctx } = useActionRuntime();
  const [sending, setSending] = useState(false);
  const live = useRef(false);
  useLayoutEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const [refused, setRefused] = useState(false);
  const [dispatched, setDispatched] = useState(false);
  const stamp = useChangeStamp("Podcasts", "Entries", "Libraries");
  const source = usePaneFreeServerValue({ key: `podcast-admission:${JSON.stringify([libraryId, target])}`, stale: stamp,
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
      {mode === "current_episodes" ? <Button onClick={onChangeDestination}>change destination</Button> : null}
      <Button onClick={onClose}>cancel</Button>
    </div>
  </>;
  const { id, library, facts } = source.data;
  const destination = libraryDisplayName(library);
  const subject = `admission:${JSON.stringify([id, target.kind, target.kind === "Canonical" ? target.podcast_id : target.target])}`;
  const pending = ctx.podcasts.pending(subject);
  const notice = pending === null ? null : podcastPendingNotice(pending);
  const following = "subscription" in facts && facts.subscription !== null;
  const operation = "import" in facts ? facts.import : null;
  const blocked = !facts.can_add_content || operation !== null || mode === "follow" && following;
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
    {createdLibrary && (!dispatched || pending?.phase === "Refused") ? <p>library created; subscription not started</p> : null}
    <p>{mode === "follow" ? `subscribe to ${title} in ${destination}.` : `import available episodes once to ${destination}. subscriptions stay unchanged.`}</p>
    {mode === "follow" ? <p>add available episodes now and new episodes automatically.</p> : null}
    <p className={styles.note}>history is limited to what the publisher makes available. this does not download audio or request transcripts.</p>
    {!facts.can_add_content ? <FeedbackNotice content={{ tone: "Warning", title: "only a library admin can add this podcast." }} announcement="Polite" /> : null}
    {mode === "follow" && following ? <FeedbackNotice content={{ tone: "Neutral", title: `already subscribed in ${destination}.` }} announcement="Polite" /> : null}
    {operation !== null ? <PodcastImportProgress operation={operation} title={title} following={following} /> : null}
    {source.error !== null ? <FeedbackNotice content={podcastErrorMessage(source.error, "couldn’t refresh the destination.")} announcement="Polite" /> : null}
    {pending?.phase === "Unknown" && notice !== null ? <FeedbackNotice content={notice} announcement="Polite"
      actions={[{ label: "check change", onClick: () => { void ctx.podcasts.check(pending.key); } }, { label: "stop tracking", onClick: () => ctx.podcasts.review(pending.key) }]} />
      : refused || pending?.phase === "Refused" ? <FeedbackNotice content={{ tone: "Warning", title: "review the current destination before choosing again.", message: "this confirmation is disarmed." }} announcement="Polite" actions={pending?.phase === "Refused" ? [{ label: "review destination", onClick: () => { ctx.podcasts.review(pending.key); source.refetch(); setRefused(false); } }] : undefined} /> : null}
    <div className={styles.actions}>
      <Button emphasis="strong" aria-busy={sending || pending?.phase === "Sending" || undefined} disabled={sending || refused || pending !== null || source.error !== null || source.refreshing || blocked} onClick={() => void submit()}>{mode === "follow" ? "subscribe" : "import episodes"}</Button>
      {mode === "current_episodes" ? <Button disabled={sending || pending?.phase === "Sending"} onClick={onChangeDestination}>change destination</Button> : null}
      <Button onClick={onClose}>cancel</Button>
    </div>
  </>;
}
