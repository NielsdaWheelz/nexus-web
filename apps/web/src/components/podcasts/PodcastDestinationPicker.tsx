"use client";

/** Later organization chooses one named destination, then reviews acquisition
 * mode in the same panel as every other podcast admission. Choosing writes nothing.
 */
import { useRef, useState } from "react";
import Button from "@/components/ui/Button";
import PickerSurface from "@/components/ui/PickerSurface";
import DestinationChooser from "@/components/libraries/DestinationChooser";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import type { LibraryDestination } from "@/lib/libraries/api";
import { findPaneLandmarkFocusTarget } from "@/lib/workspace/paneDom";

export default function PodcastDestinationPicker({ podcastId, title }: { readonly podcastId: string; readonly title: string }) {
  const { ctx } = useActionRuntime();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<LibraryDestination | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const fallback = () => findPaneLandmarkFocusTarget(button.current?.closest<HTMLElement>("[data-pane-id]")?.dataset.paneId);
  return <>
    <Button ref={button} aria-haspopup="dialog" aria-expanded={open} onClick={() => { setSelected(null); setOpen(true); }}>add to library…</Button>
    <PickerSurface active={open} title="choose a library" anchor={() => button.current} returnFocusFallback={fallback} onClose={() => setOpen(false)}>
      {open ? <>
        <DestinationChooser selection={{ kind: "Item", chosen: selected === null ? [] : [selected] }} disabled={false} create={null}
          onSet={({ destination, included }) => { setSelected(included ? destination : null); return true; }} />
        <Button emphasis="strong" disabled={selected === null} onClick={() => {
          if (selected === null) return;
          setOpen(false);
          button.current?.focus({ preventScroll: true });
          ctx.overlays.open({ kind: "AddPodcast", target: { kind: "Canonical", podcast_id: podcastId }, title, libraryId: selected.id });
        }}>{selected === null ? "choose a library" : `add to ${selected.name}…`}</Button>
      </> : null}
    </PickerSurface>
  </>;
}
