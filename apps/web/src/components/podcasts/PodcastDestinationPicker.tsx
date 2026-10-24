"use client";

/** The detail card opens the same account-owned manager as every shortcut. */
import { useRef } from "react";
import Button from "@/components/ui/Button";
import { ACTION_CATALOG } from "@/lib/actions/catalog";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { findPaneLandmarkFocusTarget } from "@/lib/workspace/paneDom";
import type { ReturnFocusTarget } from "@/lib/ui/overlay";

export default function PodcastDestinationPicker({ podcastId, title, returnFocusFallback }: {
  readonly podcastId: string; readonly title: string; readonly returnFocusFallback?: ReturnFocusTarget;
}) {
  const { ctx } = useActionRuntime();
  const button = useRef<HTMLButtonElement>(null);
  const fallback = returnFocusFallback ?? (() => findPaneLandmarkFocusTarget(button.current?.closest<HTMLElement>("[data-pane-id]")?.dataset.paneId));
  const Icon = ACTION_CATALOG.PodcastLibraries.icon;
  return <Button ref={button} iconOnly icon={<Icon />} aria-label={`manage libraries: ${title}`} aria-haspopup="dialog" onClick={() => {
    const trigger = button.current;
    ctx.overlays.open({ kind: "PodcastLibraries", target: { kind: "Canonical", podcast_id: podcastId }, title, successFocus: fallback },
      { anchor: () => trigger, returnFocusFallback: fallback });
  }} />;
}
