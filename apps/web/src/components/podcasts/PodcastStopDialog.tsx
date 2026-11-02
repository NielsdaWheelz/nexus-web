"use client";

/** Fixed keep/remove intent. Cleanup discovers scopes from all/remove, then
 * keys only its inner review: each scope reads and submits its own exact guards.
 */
import { useId, useLayoutEffect, useRef, useState } from "react";
import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import Select from "@/components/ui/Select";
import RadioGroup from "@/components/ui/RadioGroup";
import { Fact, Failed } from "@/components/feedback/Fact";
import CommandRefusal from "./CommandRefusal";
import { Ruling } from "@/components/feedback/Ruling";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { useChangeStamp } from "@/lib/api/changes";
import { usePaneFreeServerValue } from "@/lib/api/serverState";
import { libraryDisplayName } from "@/lib/collections/presenters/library";
import { getLibrary } from "@/lib/libraries/api";
import { getPodcastRemovalPreview } from "@/lib/podcasts/api";
import type { ReturnFocusTarget } from "@/lib/ui/overlay";
import styles from "./PodcastCommands.module.css";

interface StopProps {
  readonly podcastId: string;
  readonly title: string;
  readonly libraryId: string | null;
  readonly episodes: "keep" | "remove";
  readonly onClose: () => void;
  readonly returnFocusTo?: ReturnFocusTarget;
  readonly returnFocusFallback?: ReturnFocusTarget;
  readonly successFocus?: ReturnFocusTarget;
}
export default function PodcastStopDialog(props: StopProps) {
  const { ctx } = useActionRuntime();
  const scopeId = useId();
  const [scope, setScope] = useState<{ readonly id: string; readonly name: string } | null>(null);
  const accepted = useRef(false);
  const cleanup = props.episodes === "remove";
  const [episodes, setEpisodes] = useState<"keep" | "remove">("keep");
  const reviewedEpisodes = cleanup ? "remove" : episodes;
  const libraryId = cleanup ? scope?.id ?? null : props.libraryId;
  const sending = ctx.podcasts.pending(`stop:${props.podcastId}`)?.phase === "Sending";
  const stamp = useChangeStamp("Libraries", "Podcasts", "Entries");
  const library = usePaneFreeServerValue({ key: !cleanup && libraryId !== null ? `podcast-stop-library:${libraryId}` : null, stale: stamp,
    load: async signal => {
      // justify-defect: the null key disables this loader when no local library exists.
      if (libraryId === null) throw new Error("a local unsubscribe requires a library");
      return (await getLibrary(libraryId, signal)).data;
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
  const title = cleanup ? "remove episodes from libraries?" : libraryId === null ? `unsubscribe from ${props.title}?` : `unsubscribe in ${name}?`;
  return <Dialog open onClose={props.onClose}
    returnFocusTo={() => (accepted.current ? props.successFocus?.() : null) ?? props.returnFocusTo?.() ?? null}
    returnFocusFallback={props.returnFocusFallback} title={title}>
    <div className={styles.form}>
      {!cleanup ? <RadioGroup label="episodes" value={episodes} disabled={sending} choices={[
        { value: "keep", label: "keep episodes" },
        { value: "remove", label: props.libraryId === null ? "remove episodes from all libraries" : "remove episodes from this library" },
      ]} onChange={value => {
        if (value !== "keep" && value !== "remove") throw new Error("unknown unsubscribe mode");
        setEpisodes(value);
      }} /> : null}
      {local && library.status === "loading" ? <Ruling /> : null}
      {local && library.status === "failed" ? <Failed error={library.error} noun="library details" retry={{ run: library.refetch }} /> : null}
      {cleanup ? scopes.status === "loading" ? <Ruling />
        : scopes.status === "failed" ? <Failed error={scopes.error} noun="affected libraries" retry={{ run: scopes.refetch }} />
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
          </> : null}
      {localReady && (!cleanup || scopes.status === "ready") ? <StopReview key={`${libraryId ?? "all"}:${reviewedEpisodes}`} {...props} libraryId={libraryId} episodes={reviewedEpisodes} cleanup={cleanup}
        onSaved={() => { accepted.current = true; props.onClose(); }} /> : <div className={styles.actions}><Button onClick={props.onClose}>cancel</Button></div>}
    </div>
  </Dialog>;
}
function StopReview({ podcastId, title, libraryId, episodes, onClose, onSaved, cleanup }: StopProps & { readonly onSaved: () => void; readonly cleanup: boolean }) {
  const { ctx } = useActionRuntime();
  const [sending, setSending] = useState(false);
  const live = useRef(false);
  useLayoutEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const stamp = useChangeStamp("Libraries", "Podcasts", "Entries");
  const source = usePaneFreeServerValue({ key: `podcast-stop-preview:${ctx.accountId}:${podcastId}:${libraryId ?? "all"}:${episodes}`, stale: stamp,
    load: signal => getPodcastRemovalPreview(podcastId, libraryId === null ? "all" : "library", episodes, libraryId, signal),
  });
  const subject = `stop:${podcastId}`;
  const pending = ctx.podcasts.pending(subject);
  if (source.status !== "ready") return <>
    {source.status === "loading" ? <Ruling /> : <Failed error={source.error} noun="affected libraries" retry={{ run: source.refetch }} />}
    <div className={styles.actions}><Button onClick={onClose}>cancel</Button></div>
  </>;
  const preview = source.data;
  const all = libraryId === null;
  const count = preview.episode_count;
  const hasRules = preview.destinations.some(destination => destination.subscription_id !== null);
  const scope = all ? "all libraries" : preview.destinations.map(libraryDisplayName).join(", ");
  const submit = async () => {
    if (sending || source.error !== null || source.refreshing || !preview.can_execute || pending !== null) return;
    setSending(true);
    await ctx.podcasts.submit({ subject, title, shown: () => live.current, onAccepted: () => { if (live.current) onSaved(); }, command: { kind: "Stop", podcastId, body: {
      scope: preview.scope, episodes: preview.episodes, expected_removal_revision: preview.removal_revision,
      destinations: preview.destinations.map(destination => ({ library_id: destination.library_id,
        expected_subscription_id: destination.subscription_id, expected_import_id: destination.import_id,
        expected_import_attempt_version: destination.import_attempt_version,
        expected_order_revision: episodes === "remove" ? destination.order_revision : null })),
    } } });
    setSending(false);
  };
  return <>
    <p>{all ? "affected libraries:" : "library:"}</p>
    <ul className={styles.destinations}>{preview.destinations.map(destination => <li key={destination.library_id}>{libraryDisplayName(destination)}{destination.is_shared ? " · shared library; other members’ access may change" : ""}</li>)}</ul>
    {episodes === "remove" ? <>
      <p>remove {count} episodes from {scope}?</p>
      <p>includes individually added episodes. unfinished additions in this scope will be cancelled.</p>
    </> : <p>episodes already added stay. independent once-only additions keep running.</p>}
    {hasRules ? <p>stop automatic delivery and this subscription’s unfinished initial history{all ? " in the affected libraries." : " in this library."}</p> : null}
    <p>catalogue access, transcripts, notes, highlights, listening history, playback settings, queue, lectern and device downloads stay.</p>
    {preview.blocked.length > 0 ? <Fact line={{ fact: `only a library admin can change ${preview.blocked.map(item => item.name).join(", ")}.` }} /> : null}
    {source.error !== null ? <Fact line={{ fact: "couldn’t refresh affected libraries.", reason: "they may be out of date." }}
      verbs={[{ label: "retry", commandKey: "retry affected libraries", run: source.refetch }]} /> : null}
    <CommandRefusal subject={subject} reread={source.refetch} />
    <div className={styles.actions}>
      <Button emphasis="strong" tone={episodes === "remove" ? "danger" : undefined} aria-busy={sending || pending?.phase === "Sending" || undefined} disabled={sending || source.error !== null || source.refreshing || !preview.can_execute || pending !== null} onClick={() => void submit()}>
        {cleanup ? `remove ${count} episodes` : episodes === "remove" ? "unsubscribe and remove episodes" : "unsubscribe"}
      </Button>
      <Button onClick={onClose}>cancel</Button>
    </div>
  </>;
}
