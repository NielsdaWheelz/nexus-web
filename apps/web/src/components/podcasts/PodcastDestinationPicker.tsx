"use client";

/** Named organization chooses a destination, then reviews a fixed subscription.
 * Choosing writes nothing; the anchored picker hands focus to the review.
 */
import { useRef, useState } from "react";
import Button from "@/components/ui/Button";
import PickerSurface from "@/components/ui/PickerSurface";
import { ACTION_CATALOG } from "@/lib/actions/catalog";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { findPaneLandmarkFocusTarget } from "@/lib/workspace/paneDom";
import PodcastDestinationChooser from "./PodcastDestinationChooser";

export default function PodcastDestinationPicker({ podcastId, title }: { readonly podcastId: string; readonly title: string }) {
  const { ctx } = useActionRuntime();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const fallback = () => findPaneLandmarkFocusTarget(button.current?.closest<HTMLElement>("[data-pane-id]")?.dataset.paneId);
  const Icon = ACTION_CATALOG.LibraryPlacement.icon;
  const target = { kind: "Canonical" as const, podcast_id: podcastId };
  return <>
    <Button ref={button} iconOnly icon={<Icon />} aria-label={`add to library: ${title}`} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)} />
    <PickerSurface active={open} title="choose a library" anchor={() => button.current} returnFocusFallback={fallback} onClose={() => setOpen(false)}>
      {open ? <PodcastDestinationChooser target={target} mode="follow" onChoose={libraryId => {
        setOpen(false);
        button.current?.focus({ preventScroll: true });
        ctx.overlays.open({ kind: "SubscribePodcast", target, title, libraryId });
      }} /> : null}
    </PickerSurface>
  </>;
}
