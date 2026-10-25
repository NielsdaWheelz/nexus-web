"use client";

import { useLayoutEffect, useRef, useState } from "react";
import PickerSurface from "@/components/ui/PickerSurface";
import LibraryChooser, { type ChooserRow } from "@/components/libraries/LibraryChooser";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { useChangeStamp } from "@/lib/api/changes";
import { usePaneFreeServerValue } from "@/lib/api/serverState";
import { assertNever } from "@/lib/assertNever";
import { libraryDestinations } from "@/lib/libraries/api";
import { getPodcastDetail, type PodcastTarget } from "@/lib/podcasts/api";
import { podcastErrorMessage } from "@/lib/podcasts/paneState";
import type { ReturnFocusTarget } from "@/lib/ui/overlay";
import PodcastAcquisitionDialog from "./PodcastAcquisitionDialog";
import PodcastStopDialog from "./PodcastStopDialog";

type Step =
  | { readonly kind: "Choose" }
  | { readonly kind: "SubscribeReview"; readonly libraryId: string; readonly created: boolean }
  | { readonly kind: "UnsubscribeReview"; readonly libraryId: string };

/** Confirmed checks hand focus to one complete review dialog. Account-owned
 * library creation survives dismissal; only its live chooser advances.
 */
export default function PodcastLibrariesOverlay({ target, title, returnFocusTo, returnFocusFallback, successFocus, onClose }: {
  readonly target: PodcastTarget;
  readonly title: string;
  readonly returnFocusTo: ReturnFocusTarget;
  readonly returnFocusFallback: ReturnFocusTarget;
  readonly onClose: () => void;
  readonly successFocus?: ReturnFocusTarget;
}) {
  const { ctx } = useActionRuntime();
  const [step, setStep] = useState<Step>({ kind: "Choose" });
  const session = useRef<{ active: boolean; choosing: boolean }>({ active: true, choosing: true });
  useLayoutEffect(() => { const current = session.current; current.active = true; return () => { current.active = false; }; }, []);
  const scope = JSON.stringify(target);
  const creation = ctx.podcastLibraryCreation.forScope(scope);
  const stamp = useChangeStamp("Libraries", "Podcasts", "Entries");
  const source = usePaneFreeServerValue({ key: step.kind === "Choose" ? `podcast-library-picker:${ctx.accountId}:${scope}` : null, stale: stamp,
    load: async signal => {
      const [catalog, detail] = await Promise.all([libraryDestinations(signal), target.kind === "Canonical" ? getPodcastDetail(target.podcast_id, signal).then(read => read.data) : Promise.resolve(null)]);
      return { catalog, detail };
    },
  });
  const dismiss = () => { session.current.active = false; onClose(); };
  const choose = (libraryId: string, included: boolean, created = false) => {
    session.current.choosing = false;
    setStep(included ? { kind: "UnsubscribeReview", libraryId } : { kind: "SubscribeReview", libraryId, created });
  };
  const current = source.status === "ready" ? source.data : null;
  const ready = source.status === "ready" && source.error === null && !source.refreshing;
  const loading = source.status === "loading" || (source.status === "failed" ? source.retrying : source.refreshing);
  const subscriptions = current?.detail?.destinations.filter(item => !item.is_default) ?? [];
  const destinations = new Map((current?.catalog.destinations ?? []).map(item => [item.id, { id: item.id, name: item.name, writable: true }]));
  for (const item of subscriptions) if (!destinations.has(item.library_id)) destinations.set(item.library_id, { id: item.library_id, name: item.name, writable: item.can_add_content });
  const rows: ChooserRow[] = [...destinations.values()].map(item => {
    const included = subscriptions.some(subscription => subscription.library_id === item.id);
    const importing = current?.detail?.imports.some(operation => operation.library_id === item.id && (operation.state === "pending" || operation.state === "running" || operation.state === "failed")) === true;
    const reason = !ready ? "checking destination…"
      : included && !item.writable ? "a library admin must remove this subscription."
      : !included && importing ? "an unfinished import already exists in this library. review its progress." : null;
    return { id: item.id, name: item.name, confirmed: { included: included ? 1 : 0, total: 1 }, intended: null, progress: "Settled",
      note: reason !== null ? reason : undefined,
      action: reason === null ? { kind: "Set", included: !included, label: included ? "review removal" : "review subscription" } : { kind: "Blocked", reason } };
  });
  const readError = source.status === "loading" || source.error === null ? null : {
    content: podcastErrorMessage(source.error, source.status === "failed" ? "couldn’t load libraries." : "couldn’t refresh libraries."),
    retry: source.refetch, busy: loading,
  };
  switch (step.kind) {
    case "Choose":
      return <PickerSurface active title="library subscriptions" onClose={dismiss}
        anchor={returnFocusTo} returnFocusFallback={returnFocusFallback}
        skipReturnFocus={() => !session.current.choosing}>
        <LibraryChooser context={`podcast-libraries:${scope}`} membershipKind="Confirmed" rows={rows} loading={loading}
          summary={null} status={creation.status} empty="no named libraries available"
          error={readError ?? creation.error}
          onToggle={({ id }) => {
            const row = rows.find(item => item.id === id);
            if (row?.action.kind !== "Set") return false;
            choose(id, row.confirmed?.included === 1); return true;
          }}
          create={{ available: ready && !creation.creating, pendingNames: creation.pendingNames,
            onCreate: name => ctx.podcastLibraryCreation.admit({ name, scope, onCreated: destination => {
              if (!ctx.isActive()) return;
              if (session.current.active && session.current.choosing) { choose(destination.id, false, true); return; }
              // The chooser has closed: nothing else says the subscription still needs choosing.
              ctx.feedback.receipt({ tone: "Info", title: `library created · ${destination.name}; subscription not started` });
            } }) }} />
      </PickerSurface>;
    case "SubscribeReview":
      return <PodcastAcquisitionDialog target={target} title={title} mode="follow" libraryId={step.libraryId}
        createdLibrary={step.created} returnFocusTo={returnFocusTo} returnFocusFallback={returnFocusFallback} onClose={dismiss} />;
    case "UnsubscribeReview":
      // justify-defect: only canonical detail supplies confirmed subscriptions.
      if (target.kind !== "Canonical") throw new Error("subscription removal requires a canonical podcast");
      return <PodcastStopDialog podcastId={target.podcast_id} title={title} libraryId={step.libraryId} episodes="keep"
        returnFocusTo={returnFocusTo} returnFocusFallback={returnFocusFallback} successFocus={successFocus} onClose={dismiss} />;
    default: return assertNever(step);
  }
}
