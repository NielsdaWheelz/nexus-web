"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import Dialog from "@/components/ui/Dialog";
import Button from "@/components/ui/Button";
import LibraryChooser, { type ChooserRow } from "@/components/libraries/LibraryChooser";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { useChangeStamp } from "@/lib/api/changes";
import { usePaneFreeServerValue } from "@/lib/api/serverState";
import { libraryDestinations } from "@/lib/libraries/api";
import { getPodcastDetail, type PodcastTarget } from "@/lib/podcasts/api";
import { podcastErrorMessage } from "@/lib/podcasts/paneState";
import type { ReturnFocusTarget } from "@/lib/ui/overlay";
import { AcquisitionReview } from "./PodcastAcquisitionDialog";
import { StopReview } from "./PodcastStopDialog";
import styles from "./PodcastCommands.module.css";

type Step = { readonly kind: "Choose" } | { readonly kind: "SubscribeReview" | "UnsubscribeReview"; readonly libraryId: string; readonly libraryName: string; readonly created: boolean };

/** Checks are confirmed subscriptions; one choice mounts one existing review body. */
export default function PodcastLibrariesDialog({ target, title, returnFocusTo, returnFocusFallback, successFocus, onClose }: {
  readonly target: PodcastTarget;
  readonly title: string;
  readonly returnFocusTo: ReturnFocusTarget;
  readonly returnFocusFallback: ReturnFocusTarget;
  readonly onClose: () => void;
  readonly successFocus?: ReturnFocusTarget;
}) {
  const { ctx } = useActionRuntime();
  const acceptedRemoval = useRef(false);
  const [step, setStep] = useState<Step>({ kind: "Choose" });
  const session = useRef<{ active: boolean; choosing: boolean }>({ active: true, choosing: true });
  useLayoutEffect(() => { const current = session.current; current.active = true; return () => { current.active = false; }; }, []);
  session.current.choosing = step.kind === "Choose";
  const scope = JSON.stringify(target);
  const creation = ctx.podcastLibraryCreation.forScope(scope);
  const stamp = useChangeStamp("Libraries", "Podcasts", "Entries");
  const source = usePaneFreeServerValue({ key: `podcast-library-manager:${ctx.accountId}:${scope}`, stale: stamp,
    load: async signal => {
      const [catalog, detail] = await Promise.all([libraryDestinations(signal), target.kind === "Canonical" ? getPodcastDetail(target.podcast_id, signal) : Promise.resolve(null)]);
      return { catalog, detail };
    },
  });
  const stage = useCallback((node: HTMLDivElement | null) => { node?.focus({ preventScroll: true }); }, []);
  const choose = (libraryId: string, libraryName: string, included: boolean, created = false) => setStep({ kind: included ? "UnsubscribeReview" : "SubscribeReview", libraryId, libraryName, created });
  const current = source.status === "ready" ? source.data : null;
  const subscriptions = current?.detail?.destinations.filter(item => !item.is_default) ?? [];
  const destinations = new Map((current?.catalog.destinations ?? []).map(item => [item.id, { id: item.id, name: item.name, writable: true }]));
  for (const item of subscriptions) if (!destinations.has(item.library_id)) destinations.set(item.library_id, { id: item.library_id, name: item.name, writable: item.can_add_content });
  const rows: ChooserRow[] = [...destinations.values()].map(item => {
    const included = subscriptions.some(subscription => subscription.library_id === item.id);
    const importing = current?.detail?.imports.some(operation => operation.library_id === item.id && (operation.state === "pending" || operation.state === "running" || operation.state === "failed")) === true;
    const reason = source.status !== "ready" || source.error !== null || source.refreshing ? "checking destination…"
      : included && !item.writable ? "a library admin must remove this subscription."
      : !included && importing ? "an unfinished import already exists in this library. review its progress." : null;
    return { id: item.id, name: item.name, confirmed: { included: included ? 1 : 0, total: 1 }, intended: null, progress: "Settled",
      note: reason !== null ? reason : undefined,
      action: reason === null ? { kind: "Set", included: !included, label: included ? "review removal" : "review subscription" } : { kind: "Blocked", reason } };
  });
  const dialogTitle = step.kind === "Choose" ? "libraries" : step.kind === "SubscribeReview" ? `subscribe in ${step.libraryName}?` : `remove from ${step.libraryName}?`;
  return <Dialog open title={dialogTitle} onClose={onClose} returnFocusTo={returnFocusTo} returnFocusFallback={() => {
    const opener = returnFocusTo();
    const element = opener instanceof HTMLElement ? opener : opener?.element;
    return (acceptedRemoval.current && !element?.isConnected ? successFocus?.() : null) ?? returnFocusFallback();
  }}>
    <div key={step.kind === "Choose" ? "choose" : `${step.kind}:${step.libraryId}`} ref={stage} tabIndex={-1} role="group" aria-label={step.kind === "Choose" ? "choose a library" : step.kind === "SubscribeReview" ? "review subscription" : "review removal"} className={styles.form}>
      {step.kind === "Choose" ? <>
        <p>{title}</p>
        {source.status === "loading" ? <PaneLoadingState label="checking libraries…" announcement="Polite" /> : source.status === "failed"
          ? <FeedbackNotice content={podcastErrorMessage(source.error, "couldn’t load libraries.")} announcement="Polite" actions={[{ label: "retry", onClick: source.refetch, busy: source.retrying }]} />
          : <LibraryChooser context={`podcast-libraries:${scope}`} membershipKind="Confirmed" rows={rows} loading={source.refreshing}
            summary={null} status={creation.status} empty="no named libraries available"
            error={creation.error ?? (source.error === null ? null : { content: podcastErrorMessage(source.error, "couldn’t refresh libraries."), retry: source.refetch })}
            onToggle={({ id }) => {
              const row = rows.find(item => item.id === id);
              if (row?.action.kind !== "Set") return false;
              choose(id, row.name, row.confirmed?.included === 1); return true;
            }}
            create={{ available: !creation.creating && source.error === null && !source.refreshing, pendingNames: creation.pendingNames,
              onCreate: name => ctx.podcastLibraryCreation.admit({ name, scope, onCreated: destination => {
                if (!ctx.isActive()) return;
                if (session.current.active && session.current.choosing) { choose(destination.id, destination.name, false, true); return; }
                ctx.feedback.receipt({ tone: "Success", title: `library created · ${destination.name}; subscription not started` });
              } }) }} />}
        <div className={styles.actions}><Button onClick={onClose}>cancel</Button></div>
      </> : step.kind === "SubscribeReview"
        ? <AcquisitionReview target={target} title={title} mode="follow" libraryId={step.libraryId} createdLibrary={step.created} onClose={onClose} onChangeDestination={() => setStep({ kind: "Choose" })} />
        : target.kind === "Canonical" ? <StopReview podcastId={target.podcast_id} title={title} libraryId={step.libraryId} episodes="keep" onClose={onClose} onSaved={() => { acceptedRemoval.current = true; onClose(); }} /> : null}
    </div>
  </Dialog>;
}
