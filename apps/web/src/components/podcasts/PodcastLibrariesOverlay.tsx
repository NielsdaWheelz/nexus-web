"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { useOutcome } from "@/components/feedback/Feedback";
import PickerSurface from "@/components/ui/PickerSurface";
import LibraryChooser, { type ChooserRow } from "@/components/libraries/LibraryChooser";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { useChangeStamp } from "@/lib/api/changes";
import { Failed } from "@/components/feedback/Fact";
import { usePaneFreeServerValue } from "@/lib/api/serverState";
import { assertNever } from "@/lib/assertNever";
import { libraryDisplayName } from "@/lib/collections/presenters/library";
import { libraryDestinations } from "@/lib/libraries/api";
import { getDefaultPodcastLibrary, getPodcastDetail, type PodcastTarget } from "@/lib/podcasts/api";
import type { ReturnFocusTarget } from "@/lib/ui/overlay";
import PodcastAcquisitionDialog from "./PodcastAcquisitionDialog";
import PodcastStopDialog from "./PodcastStopDialog";

type Step =
  | { readonly kind: "Choose" }
  | { readonly kind: "AdditionReview"; readonly libraryId: string; readonly created: boolean }
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
  const slipContent = useRef<HTMLDivElement>(null);
  const { say } = useOutcome();
  const [step, setStep] = useState<Step>({ kind: "Choose" });
  const session = useRef<{ active: boolean; choosing: boolean }>({ active: true, choosing: true });
  useLayoutEffect(() => { const current = session.current; current.active = true; return () => { current.active = false; }; }, []);
  const scope = JSON.stringify(target);
  const creation = ctx.podcastLibraryCreation.forScope(scope);
  const stamp = useChangeStamp("Libraries", "Podcasts", "Entries");
  const source = usePaneFreeServerValue({ key: step.kind === "Choose" ? `podcast-library-picker:${ctx.accountId}:${scope}` : null, stale: stamp,
    load: async signal => {
      const [catalog, detail, personalId] = await Promise.all([libraryDestinations(signal), target.kind === "Canonical" ? getPodcastDetail(target.podcast_id, signal).then(read => read.data) : Promise.resolve(null), getDefaultPodcastLibrary(signal)]);
      return { catalog, detail, personalId };
    },
  });
  const dismiss = () => { session.current.active = false; onClose(); };
  const choose = (libraryId: string, created = false) => {
    session.current.choosing = false;
    setStep({ kind: "AdditionReview", libraryId, created });
  };
  const current = source.status === "ready" ? source.data : null;
  const ready = source.status === "ready" && source.error === null && !source.refreshing;
  const loading = source.status === "loading" || (source.status === "failed" ? source.retrying : source.refreshing);
  const subscriptions = current?.detail?.destinations ?? [];
  const destinations = new Map((current?.catalog.destinations ?? []).map(item => [item.id, { id: item.id, name: item.name, writable: true }]));
  if (current !== null) destinations.set(current.personalId, { id: current.personalId, name: "all", writable: true });
  for (const item of subscriptions) if (!destinations.has(item.library_id)) destinations.set(item.library_id, { id: item.library_id, name: libraryDisplayName(item), writable: item.can_add_content });
  const rows: ChooserRow[] = [...destinations.values()].map(item => {
    const included = subscriptions.some(subscription => subscription.library_id === item.id);
    // Rows act only on fresh facts; a failed refresh says so, a wait is the chooser's busy.
    const reason = ready ? null : source.status === "ready" && source.error !== null && !loading ? "couldn’t refresh libraries." : "checking libraries";
    return { id: item.id, name: item.name, confirmed: { included: included ? 1 : 0, total: 1 }, intended: { included: 0, total: 1 }, progress: "Settled",
      note: included ? `podcast subscription${item.writable ? "" : " · read only"}` : reason === "couldn’t refresh libraries." ? reason : undefined,
      action: reason === null ? { kind: "Set", included: true, label: "choose destination" } : { kind: "Blocked", reason } };
  });
  switch (step.kind) {
    case "Choose":
      return <PickerSurface slipContent={slipContent} active title="add to library" onClose={dismiss}
        anchor={returnFocusTo} returnFocusFallback={returnFocusFallback}
        skipReturnFocus={() => !session.current.choosing}>
        <LibraryChooser scrollRef={slipContent} context={`podcast-libraries:${scope}`} membershipKind="Chosen" rows={rows} loading={loading}
          summary={null} empty="no libraries."
          failure={source.status === "failed" ? <Failed error={source.error} noun="libraries" retry={{ run: source.refetch, busy: loading }} /> : null}
          onToggle={({ id }) => {
            const row = rows.find(item => item.id === id);
            if (row?.action.kind !== "Set") return false;
            choose(id); return true;
          }}
          create={{ available: ready && !creation.creating, pendingNames: creation.pendingNames,
            onCreate: name => ctx.podcastLibraryCreation.admit({ name, scope, onCreated: destination => {
              if (!ctx.isActive()) return;
              if (session.current.active && session.current.choosing) { choose(destination.id, true); return; }
              // The chooser has closed: nothing else says the subscription still needs choosing.
              say({ fact: `created ${destination.name} without “${title}”.` });
            } }) }} />
      </PickerSurface>;
    case "AdditionReview":
      return <PodcastAcquisitionDialog target={target} title={title} mode="choose" libraryId={step.libraryId}
        createdLibrary={step.created} onUnsubscribe={target.kind === "Canonical" ? () => setStep({ kind: "UnsubscribeReview", libraryId: step.libraryId }) : undefined} onChangeDestination={() => { session.current.choosing = true; setStep({ kind: "Choose" }); }} returnFocusTo={returnFocusTo} returnFocusFallback={returnFocusFallback} onClose={dismiss} />;
    case "UnsubscribeReview":
      // justify-defect: only canonical detail supplies confirmed subscriptions.
      if (target.kind !== "Canonical") throw new Error("subscription removal requires a canonical podcast");
      return <PodcastStopDialog podcastId={target.podcast_id} title={title} libraryId={step.libraryId} episodes="keep"
        returnFocusTo={returnFocusTo} returnFocusFallback={returnFocusFallback} successFocus={successFocus} onClose={dismiss} />;
    default: return assertNever(step);
  }
}
