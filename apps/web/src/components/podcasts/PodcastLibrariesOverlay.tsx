"use client";

/** One chooser session hands off to one existing review. Choosing never writes;
 * retained creation outlives dismissal but cannot reopen or subscribe afterward.
 */
import { useLayoutEffect, useRef, useState } from "react";
import Button from "@/components/ui/Button";
import styles from "./PodcastCommands.module.css";
import PickerSurface from "@/components/ui/PickerSurface";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import type { PodcastTarget } from "@/lib/podcasts/api";
import type { ReturnFocusTarget } from "@/lib/ui/overlay";
import PodcastAcquisitionDialog from "./PodcastAcquisitionDialog";
import PodcastDestinationChooser from "./PodcastDestinationChooser";
import PodcastStopDialog from "./PodcastStopDialog";

type Step = { kind: "Choose" } | { kind: "SubscribeReview"; libraryId: string; created: boolean } | { kind: "UnsubscribeReview"; libraryId: string };

export default function PodcastLibrariesOverlay({ target, title, anchor, returnFocusFallback, successFocus, onClose }: {
  readonly target: PodcastTarget; readonly title: string; readonly anchor: ReturnFocusTarget;
  readonly returnFocusFallback: ReturnFocusTarget; readonly successFocus?: ReturnFocusTarget; readonly onClose: () => void;
}) {
  const { ctx } = useActionRuntime();
  const [step, setStep] = useState<Step>({ kind: "Choose" });
  const choosing = useRef(true);
  const handoff = useRef(false);
  const live = useRef(false);
  useLayoutEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const scope = JSON.stringify(target);
  const creation = ctx.podcastLibraryCreation.forScope(scope);
  const choose = (libraryId: string, included: boolean, created = false) => {
    choosing.current = false;
    handoff.current = true;
    setStep(included ? { kind: "UnsubscribeReview", libraryId } : { kind: "SubscribeReview", libraryId, created });
  };
  const close = () => { choosing.current = false; onClose(); };
  switch (step.kind) {
    case "Choose": return <PickerSurface active title="libraries" anchor={anchor} returnFocusFallback={returnFocusFallback} onClose={close} skipReturnFocus={() => handoff.current}>
      <PodcastDestinationChooser target={target} mode="follow" onChoose={choose} status={creation.status} creationError={creation.error}
        create={{ available: !creation.creating, pendingNames: creation.pendingNames,
          onCreate: name => ctx.podcastLibraryCreation.admit({ name, scope, onCreated: library => {
            if (!ctx.isActive()) return;
            if (live.current && choosing.current) { choose(library.id, false, true); return; }
            ctx.feedback.offer({ key: `podcast-library-created:${library.id}`, announcement: "Polite",
              content: { tone: "Success", title: "library created; subscription not started", message: library.name } });
          } }),
        }} />
      <div className={styles.actions}><Button onClick={close}>cancel</Button></div>
    </PickerSurface>;
    case "SubscribeReview": return <PodcastAcquisitionDialog target={target} title={title} mode="follow" libraryId={step.libraryId} createdLibrary={step.created}
      returnFocusTo={anchor} returnFocusFallback={returnFocusFallback} onClose={close} />;
    case "UnsubscribeReview":
      if (target.kind !== "Canonical") throw new Error("a subscribed destination requires canonical identity");
      return <PodcastStopDialog podcastId={target.podcast_id} title={title} libraryId={step.libraryId} episodes="keep"
        returnFocusTo={anchor} returnFocusFallback={() => {
          const opener = anchor();
          const element = opener instanceof HTMLElement ? opener : opener?.element;
          return (!element?.isConnected ? successFocus?.() : null) ?? returnFocusFallback();
        }} onClose={close} />;
  }
}
