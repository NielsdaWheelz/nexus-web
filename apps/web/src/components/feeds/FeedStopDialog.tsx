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
import FeedRemovalBlockers from "./FeedRemovalBlockers";
import { Ruling } from "@/components/feedback/Ruling";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { useChangeStamp } from "@/lib/api/changes";
import { usePaneFreeServerValue } from "@/lib/api/serverState";
import { libraryDisplayName } from "@/lib/collections/presenters/library";
import { getLibrary } from "@/lib/libraries/api";
import { getFeedRemovalPreview } from "@/lib/feeds/api";

import type { ReturnFocusTarget } from "@/lib/ui/overlay";
import styles from "./FeedCommands.module.css";

interface StopProps {
  readonly feedId: string;
  readonly feedKind: "podcast" | "article";
  readonly title: string;
  readonly libraryId: string | null;
  readonly items: "keep" | "remove";
  readonly onClose: () => void;
  readonly returnFocusTo?: ReturnFocusTarget;
  readonly returnFocusFallback?: ReturnFocusTarget;
  readonly successFocus?: ReturnFocusTarget;
}
export default function FeedStopDialog(props: StopProps) {
  const { ctx } = useActionRuntime();
  const scopeId = useId();
  const [scope, setScope] = useState<{ readonly id: string; readonly name: string } | null>(null);
  const accepted = useRef(false);
  const noun = props.feedKind === "podcast" ? "episodes" : "articles";
  const cleanup = props.items === "remove";
  const [items, setItems] = useState<"keep" | "remove">("keep");
  const reviewedItems = cleanup ? "remove" : items;
  const libraryId = cleanup ? scope?.id ?? null : props.libraryId;
  const sending = ctx.feeds.pending(`stop:${props.feedId}`)?.phase === "Sending";
  const stamp = useChangeStamp("Libraries", "Feeds", "Entries");
  const library = usePaneFreeServerValue({ key: !cleanup && libraryId !== null ? `podcast-stop-library:${libraryId}` : null, stale: stamp,
    load: async signal => {
      // justify-defect: the null key disables this loader when no local library exists.
      if (libraryId === null) throw new Error("a local unsubscribe requires a library");
      return (await getLibrary(libraryId, signal)).data;
    },
  });
  const scopes = usePaneFreeServerValue({ key: cleanup ? `podcast-cleanup-scopes:${props.feedId}` : null, stale: stamp,
    load: signal => getFeedRemovalPreview(props.feedId, "all", "remove", null, signal),
  });
  const namedScopes = scopes.status === "ready"
    ? scopes.data.destinations.filter(destination => !destination.is_default).map(destination => ({ id: destination.library_id, name: destination.name })) : [];
  if (scope !== null && !namedScopes.some(destination => destination.id === scope.id)) namedScopes.push(scope);
  const local = !cleanup && libraryId !== null;
  const localReady = !local || library.status === "ready";
  const name = library.status === "ready" ? libraryDisplayName(library.data) : "library";
  const title = cleanup ? `remove ${noun} from libraries?` : libraryId === null ? `unsubscribe from ${props.title}?` : `unsubscribe in ${name}?`;
  return <Dialog open onClose={props.onClose}
    returnFocusTo={() => (accepted.current ? props.successFocus?.() : null) ?? props.returnFocusTo?.() ?? null}
    returnFocusFallback={props.returnFocusFallback} title={title}>
    <div className={styles.form}>
      {!cleanup ? <RadioGroup label={noun} value={items} disabled={sending} choices={[
        { value: "keep", label: `keep ${noun}` },
        { value: "remove", label: props.libraryId === null ? `remove ${noun} from all libraries` : `remove ${noun} from this library` },
      ]} onChange={value => {
        if (value !== "keep" && value !== "remove") throw new Error("unknown unsubscribe mode");
        setItems(value);
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
      {localReady && (!cleanup || scopes.status === "ready") ? <StopReview key={`${libraryId ?? "all"}:${reviewedItems}`} {...props} libraryId={libraryId} items={reviewedItems} cleanup={cleanup}
        onSaved={() => { accepted.current = true; props.onClose(); }} /> : <div className={styles.actions}><Button onClick={props.onClose}>cancel</Button></div>}
    </div>
  </Dialog>;
}
function StopReview({ feedId, feedKind, title, libraryId, items, onClose, onSaved, cleanup }: StopProps & { readonly onSaved: () => void; readonly cleanup: boolean }) {
  const { ctx } = useActionRuntime();
  const [sending, setSending] = useState(false);
  const waitingId = useId();
  const live = useRef(false);
  useLayoutEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const stamp = useChangeStamp("Libraries", "Feeds", "Entries");
  const source = usePaneFreeServerValue({ key: `podcast-stop-preview:${ctx.accountId}:${feedId}:${libraryId ?? "all"}:${items}`, stale: stamp,
    load: signal => getFeedRemovalPreview(feedId, libraryId === null ? "all" : "library", items, libraryId, signal),
  });
  const noun = feedKind === "podcast" ? "episodes" : "articles";
  const subject = `stop:${feedId}`;
  const pending = ctx.feeds.pending(subject);
  if (source.status !== "ready") return <>
    {source.status === "loading" ? <Ruling /> : <Failed error={source.error} noun="affected libraries" retry={{ run: source.refetch }} />}
    <div className={styles.actions}><Button onClick={onClose}>cancel</Button></div>
  </>;
  const preview = source.data;
  const all = libraryId === null;
  const count = preview.entry_count;
  const hasRules = preview.destinations.some(destination => destination.subscription_id !== null);
  const scope = all ? "all libraries" : preview.destinations.map(libraryDisplayName).join(", ");
  const submit = async () => {
    if (sending || source.error !== null || source.refreshing || !preview.can_execute || pending !== null) return;
    setSending(true);
    await ctx.feeds.submit({ subject, title, shown: () => live.current, onAccepted: () => { if (live.current) onSaved(); }, command: { kind: "Stop", feedId, body: {
      scope: preview.scope, items: preview.items, expected_removal_revision: preview.removal_revision,
      destinations: preview.destinations.map(destination => ({ library_id: destination.library_id,
        expected_subscription_id: destination.subscription_id, expected_import_id: destination.import_id,
        expected_import_attempt_version: destination.import_attempt_version,
        expected_order_revision: items === "remove" ? destination.order_revision : null })),
    } } });
    if (live.current) setSending(false);
  };
  return <>
    <p>{all ? "affected libraries:" : "library:"}</p>
    <ul className={styles.destinations}>{preview.destinations.map(destination => <li key={destination.library_id}>{libraryDisplayName(destination)}{destination.is_shared ? " · shared library; other members’ access may change" : ""}</li>)}</ul>
    {items === "remove" ? <>
      <p>remove {count} {noun} from {scope}?</p>
      <p>includes individually added {noun}. unfinished additions in this scope will be cancelled.</p>
    </> : <p>{noun} already added stay. independent once-only additions keep running.</p>}
    {hasRules ? <p>stop automatic delivery and this subscription’s unfinished initial history{all ? " in the affected libraries." : " in this library."}</p> : null}
    <p>notes, highlights, reading history and lectern stay.{feedKind === "podcast" ? " transcripts, playback settings, queue and device downloads stay." : ""}</p>
    <FeedRemovalBlockers blocked={preview.blocked} destinations={preview.destinations} />
    {source.error !== null ? <Fact line={{ fact: "couldn’t refresh affected libraries.", reason: "they may be out of date." }}
      verbs={[{ label: "retry", commandKey: "retry affected libraries", run: source.refetch }]} /> : null}
    {source.refreshing ? <span id={waitingId} className="sr-only">checking affected libraries</span> : null}
    <CommandRefusal subject={subject} reread={source.refetch} />
    <div className={styles.actions}>
      <Button emphasis="strong" aria-describedby={source.refreshing ? waitingId : undefined} tone={items === "remove" ? "danger" : undefined} aria-busy={sending || pending?.phase === "Sending" || undefined} disabled={sending || source.error !== null || source.refreshing || !preview.can_execute || pending !== null} onClick={() => void submit()}>
        {cleanup ? `remove ${count} ${noun}` : items === "remove" ? `unsubscribe and remove ${noun}` : "unsubscribe"}
      </Button>
      <Button onClick={onClose}>cancel</Button>
    </div>
  </>;
}
