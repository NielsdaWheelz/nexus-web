"use client";

import { useRef, useState } from "react";
import { Failed } from "@/components/feedback/Fact";
import { Ruling } from "@/components/feedback/Ruling";
import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import { useActionRuntime, useBusyActionIds } from "@/lib/actions/ResourceActionsProvider";
import { settleDeletedResourcePanes } from "@/lib/actions/settleDeletedResource";
import { usePaneFreeServerValue } from "@/lib/api/serverState";
import type { Schema } from "@/lib/api/wire";
import { deleteMedia, mediaRemovalPreview } from "@/lib/media/mediaLibraries";
import { MEDIA_REMOVAL_CONFIRMATION } from "@/lib/media/removalCopy";
import type { ReturnFocusTarget } from "@/lib/ui/overlay";

/** One frozen consequence review. The account's existing action owner retains the exact delete. */
export default function MediaRemovalDialog({ mediaId, returnFocusTo, returnFocusFallback, onClose }: {
  readonly mediaId: string;
  readonly returnFocusTo: ReturnFocusTarget;
  readonly returnFocusFallback: ReturnFocusTarget;
  readonly onClose: () => void;
}) {
  const { ctx, run } = useActionRuntime();
  const keep = useRef<HTMLButtonElement>(null);
  const ref = `media:${mediaId}`;
  const busy = useBusyActionIds(ref).has("RemoveMedia");
  const [preview, setPreview] = useState<Schema<"MediaRemovalPreviewOut"> | null>(null);
  // Retire the read once reviewed: reconnect must not replace this deletion guard.
  const source = usePaneFreeServerValue({ key: preview === null ? `media-removal:${ctx.accountId}:${mediaId}` : null, stale: "",
    load: signal => mediaRemovalPreview(mediaId, signal),
  });
  if (preview === null && source.status === "ready" && source.error === null && !source.refreshing) setPreview(source.data);
  const submit = () => {
    if (preview === null || busy) return;
    run({ ref, id: "RemoveMedia", label: "remove from nexus", feedbackLabel: "remove from nexus",
      title: preview.title, confirmation: null, tracked: true, rawWrite: true,
      afterRemoval: returnFocusFallback,
      execute: async acknowledged => {
        await deleteMedia(preview.media_id, preview.acquisition_revision);
        acknowledged();
        if (!ctx.isActive()) return;
        ctx.mediaContinuations.forgetDeletedMedia(preview.media_id);
        settleDeletedResourcePanes({ workspace: ctx.workspace(), deletedRef: ref, fallbackHref: "/libraries" });
      },
    });
    onClose();
  };
  return <Dialog open title={MEDIA_REMOVAL_CONFIRMATION.title} onClose={onClose}
    initialFocus={() => keep.current} returnFocusTo={returnFocusTo} returnFocusFallback={returnFocusFallback}>
    {preview !== null ? <p>{MEDIA_REMOVAL_CONFIRMATION.body.replaceAll("{title}", () => preview.title)}</p>
      : source.status === "failed"
      ? <Failed error={source.error} noun="removal review" retry={{ run: source.refetch }} />
      : <Ruling />}
    <Button ref={keep} onClick={onClose}>keep item</Button>{" "}
    <Button emphasis="strong" tone="danger" onClick={submit}
      disabled={preview === null || busy}
      aria-busy={busy || undefined}>remove from nexus</Button>
  </Dialog>;
}
