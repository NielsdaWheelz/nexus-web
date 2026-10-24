"use client";

/** Fixed keep/remove intent. Cleanup discovers scopes from all/remove, then
 * keys only its inner review: each scope reads and submits its own exact guards.
 */
import { useId, useLayoutEffect, useRef, useState } from "react";
import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import Select from "@/components/ui/Select";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { useChangeStamp } from "@/lib/api/changes";
import { usePaneFreeServerValue } from "@/lib/api/serverState";
import { libraryDisplayName } from "@/lib/collections/presenters/library";
import { getLibrary } from "@/lib/libraries/api";
import { getPodcastRemovalPreview } from "@/lib/podcasts/api";
import { podcastErrorMessage } from "@/lib/podcasts/paneState";
import type { ReturnFocusTarget } from "@/lib/ui/overlay";
import styles from "./PodcastCommands.module.css";

interface Props {
  readonly podcastId: string;
  readonly title: string;
  readonly libraryId: string | null;
  readonly episodes: "keep" | "remove";
  readonly onClose: () => void;
  readonly returnFocusTo?: ReturnFocusTarget;
  readonly returnFocusFallback?: ReturnFocusTarget;
  readonly successFocus?: ReturnFocusTarget;
}
export default function PodcastStopDialog(props: Props) {
  const { ctx } = useActionRuntime();
  const scopeId = useId();
  const [scope, setScope] = useState<{ readonly id: string; readonly name: string } | null>(null);
  const accepted = useRef(false);
  const cleanup = props.episodes === "remove";
  const libraryId = cleanup ? scope?.id ?? null : props.libraryId;
  const sending = ctx.podcasts.pending(`stop:${props.podcastId}`)?.phase === "Sending";
  const stamp = useChangeStamp("Libraries", "Podcasts", "Entries");
  const library = usePaneFreeServerValue({ key: !cleanup && libraryId !== null ? `podcast-stop-library:${libraryId}` : null, stale: stamp,
    load: signal => {
      // justify-defect: the null key disables this loader when no local library exists.
      if (libraryId === null) throw new Error("a local unsubscribe requires a library");
      return getLibrary(libraryId, signal);
    },
  });
  const scopes = usePaneFreeServerValue({ key: cleanup ? `podcast-cleanup-scopes:${props.podcastId}` : null, stale: stamp,
    load: signal => getPodcastRemovalPreview(props.podcastId, "all", "remove", null, signal),
  });
  const namedScopes = scopes.status === "ready"
    ? scopes.data.destinations.filter(destination => !destination.is_default).map(destination => ({ id: destination.library_id, name: destination.name })) : [];
  if (scope !== null && !namedScopes.some(destination => destination.id === scope.id)) namedScopes.push(scope);
  const local = !cleanup && libraryId !== null;
  const localReady = !local || library.status === "ready";
  const name = library.status === "ready" ? libraryDisplayName(library.data) : "library";
  const title = cleanup ? `remove ${props.title} and episodes?` : libraryId === null ? `unsubscribe from ${props.title}?` : `remove ${props.title} from ${name}?`;
  return <Dialog open onClose={props.onClose}
    returnFocusTo={() => (accepted.current ? props.successFocus?.() : null) ?? props.returnFocusTo?.() ?? null}
    returnFocusFallback={props.returnFocusFallback} title={title}>
    <div className={styles.form}>
      {local && library.status === "loading" ? <PaneLoadingState label="checking library…" announcement="Polite" /> : null}
      {local && (library.status === "failed" || library.status === "ready" && library.error !== null) ? <FeedbackNotice content={podcastErrorMessage(library.error, "couldn’t load the library.")} announcement="Polite" actions={[{ label: "retry library", onClick: library.refetch }]} /> : null}
      {cleanup ? scopes.status === "loading" ? <PaneLoadingState label="checking removal scopes…" announcement="Polite" />
        : scopes.status === "failed" ? <FeedbackNotice content={podcastErrorMessage(scopes.error, "couldn’t check removal scopes.")} announcement="Polite" actions={[{ label: "retry scopes", onClick: scopes.refetch }]} />
          : <>
            <div className={styles.scope}>
              <label htmlFor={scopeId}>scope</label>
              <Select id={scopeId} aria-label="removal scope" value={scope?.id ?? "all"} disabled={sending} onChange={event => {
                if (event.currentTarget.value === "all") { setScope(null); return; }
                setScope({ id: event.currentTarget.value, name: event.currentTarget.selectedOptions[0].label });
              }}>
                <option value="all">everywhere</option>
                {namedScopes.map(destination => <option key={destination.id} value={destination.id} label={destination.name}>{destination.name}</option>)}
              </Select>
            </div>
            {scopes.error !== null ? <FeedbackNotice content={podcastErrorMessage(scopes.error, "couldn’t refresh removal scopes.")} announcement="Polite" actions={[{ label: "retry scopes", onClick: scopes.refetch }]} /> : null}
          </> : null}
      {localReady && (!cleanup || scopes.status === "ready") ? <StopPreview key={libraryId ?? "all"} {...props} libraryId={libraryId}
        onSaved={() => { accepted.current = true; props.onClose(); }} /> : <div className={styles.actions}><Button onClick={props.onClose}>cancel</Button></div>}
    </div>
  </Dialog>;
}
function StopPreview({ podcastId, title, libraryId, episodes, onClose, onSaved }: Props & { readonly onSaved: () => void }) {
  const { ctx } = useActionRuntime();
  const [sending, setSending] = useState(false);
  const live = useRef(false);
  useLayoutEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const [stale, setStale] = useState(false);
  const stamp = useChangeStamp("Libraries", "Podcasts", "Entries");
  const source = usePaneFreeServerValue({ key: `podcast-stop-preview:${ctx.accountId}:${podcastId}:${libraryId ?? "all"}:${episodes}`, stale: stamp,
    load: signal => getPodcastRemovalPreview(podcastId, libraryId === null ? "all" : "library", episodes, libraryId, signal),
  });
  const subject = `stop:${podcastId}`;
  const pending = ctx.podcasts.pending(subject);
  if (source.status !== "ready") return <>
    {source.status === "loading" ? <PaneLoadingState label="checking affected libraries and episodes…" announcement="Polite" />
      : <FeedbackNotice content={podcastErrorMessage(source.error, "couldn’t check affected libraries.")} announcement="Polite" actions={[{ label: "retry preview", onClick: source.refetch }]} />}
    <div className={styles.actions}><Button onClick={onClose}>cancel</Button></div>
  </>;
  const preview = source.data;
  const all = libraryId === null;
  const count = preview.episode_count;
  const submit = async () => {
    if (sending || stale || source.error !== null || source.refreshing || !preview.can_execute || pending !== null) return;
    setSending(true);
    const accepted = await ctx.podcasts.submit({ subject, title: `${title} · ${all ? "everywhere" : preview.destinations.map(libraryDisplayName).join(", ")}`, onAccepted: () => { if (live.current) onSaved(); }, command: { kind: "Stop", podcastId, body: {
      scope: preview.scope, episodes: preview.episodes, expected_removal_revision: preview.removal_revision,
      destinations: preview.destinations.map(destination => ({ library_id: destination.library_id,
        expected_subscription_id: destination.subscription_id, expected_import_id: destination.import_id,
        expected_import_attempt_version: destination.import_attempt_version,
        expected_order_revision: episodes === "remove" ? destination.order_revision : null })),
    } } });
    setSending(false);
    if (!accepted && live.current) setStale(true);
  };
  return <>
    <p>{all ? "affected libraries:" : "library:"}</p>
    <ul className={styles.destinations}>{preview.destinations.map(destination => <li key={destination.library_id}>{libraryDisplayName(destination)}{destination.is_shared ? " · shared library; other members’ access may change" : ""}</li>)}</ul>
    {episodes === "remove" ? <p>{count} distinct {count === 1 ? "episode" : "episodes"}{all ? " will be removed from the affected libraries and your lectern, including individually added episodes." : " will be removed from this library, including individually added episodes."}</p> : null}
    <p>stop new episodes and cancel unfinished imports{all ? " in the affected libraries." : " in this library."}</p>
    {episodes === "keep" ? <p>episodes already added stay.</p> : <>
      {!all ? <p>personal retention and placements in other libraries stay.</p> : null}
      <p>notes, highlights, listening history and playback settings stay.</p>
    </>}
    {preview.blocked.length > 0 ? <FeedbackNotice content={{ tone: "Warning", title: "this change needs a library admin.", message: preview.blocked.map(item => item.name).join(", ") }} announcement="Polite" /> : null}
    {source.error !== null ? <FeedbackNotice content={podcastErrorMessage(source.error, "couldn’t refresh this preview.")} announcement="Polite" /> : null}
    {stale || pending !== null && pending.phase !== "Sending" ? <FeedbackNotice content={{ tone: "Warning", title: pending?.phase === "Unknown" ? "change not confirmed" : "the affected libraries changed. review them before confirming.", message: pending?.phase === "Unknown" ? "the request may have succeeded. recovery remains available in workspace feedback." : "this confirmation is disarmed." }} announcement="Polite" actions={pending?.phase === "Refused" ? [{ label: "review this scope", onClick: () => { ctx.podcasts.review(pending.key); source.refetch(); setStale(false); } }] : undefined} /> : null}
    <div className={styles.actions}>
      <Button emphasis="strong" tone={episodes === "remove" ? "danger" : undefined} aria-busy={sending || pending?.phase === "Sending" || undefined} disabled={sending || stale || source.error !== null || source.refreshing || !preview.can_execute || pending !== null} onClick={() => void submit()}>
        {episodes === "remove" ? `remove podcast and ${count} episodes${all ? " everywhere" : ""}` : all ? "unsubscribe" : "remove from library"}
      </Button>
      <Button onClick={onClose}>cancel</Button>
    </div>
  </>;
}
