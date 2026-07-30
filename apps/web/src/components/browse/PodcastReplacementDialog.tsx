"use client";

import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";

export interface PodcastReplacementConflict {
  readonly libraryId: string;
  readonly libraryName: string;
  readonly episodeCount: number;
}

export default function PodcastReplacementDialog({
  open,
  conflicts,
  busy,
  onCancel,
  onConfirm,
}: {
  readonly open: boolean;
  readonly conflicts: readonly PodcastReplacementConflict[];
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  const episodeCount = conflicts.reduce(
    (total, conflict) => total + conflict.episodeCount,
    0,
  );
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title="Replace episode placements?"
      onDismissRequest={() => (busy ? "blocked" : "accepted")}
    >
      <p>
        Subscribing will replace {episodeCount} directly filed{" "}
        {episodeCount === 1 ? "episode" : "episodes"} with the Podcast in:
      </p>
      <ul>
        {conflicts.map((conflict) => (
          <li key={conflict.libraryId}>
            {conflict.libraryName} · {conflict.episodeCount}{" "}
            {conflict.episodeCount === 1 ? "episode" : "episodes"}
          </li>
        ))}
      </ul>
      <p>
        Removed episode filing intent will not be restored if the Podcast is
        removed later.
      </p>
      <div>
        <Button
          variant="danger"
          loading={busy}
          onClick={onConfirm}
        >
          Replace and subscribe
        </Button>{" "}
        <Button variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </Dialog>
  );
}
