"use client";

import { useCallback } from "react";
import { deleteStance, putStance } from "@/lib/resourceGraph/stances";

export type StanceKind = "supports" | "contradicts";

export interface StanceEdgeRef {
  sourceHighlightId: string;
  kind: StanceKind;
  stanceId: string;
}

/**
 * Owns the two stance chords (Take a Side, §4.6): concede (`supports`) and doubt
 * (`contradicts`) drive the stance command from the focused passage with no
 * dialog and no AI (N-2). The server materializes a passage anchor when the
 * focused passage resolves, falling back to durable media. Pressing the same key
 * again toggles the mark off through DELETE; the opposite key is ONE `putStance`
 * that transactionally replaces the single directed stance — never a client
 * delete-then-create (§ Stance).
 */
export function useStanceComposer({
  resolveTarget,
  stanceEdges,
  onChanged,
}: {
  /** Resolve the focused/created source highlight + its media-grain target ref. */
  resolveTarget: () => Promise<{
    highlightId: string;
    targetRef: string;
  } | null>;
  /** Current user stance edges derived from canonical Evidence associations. */
  stanceEdges: StanceEdgeRef[];
  onChanged: () => void;
}): { mintStance: (kind: StanceKind) => Promise<void> } {
  const mintStance = useCallback(
    async (kind: StanceKind) => {
      const resolved = await resolveTarget();
      if (!resolved) return;
      const { highlightId, targetRef } = resolved;

      const same = stanceEdges.find(
        (edge) => edge.sourceHighlightId === highlightId && edge.kind === kind,
      );
      if (same) {
        await deleteStance(same.stanceId);
        onChanged();
        return;
      }
      // The opposite stance is one transactional putStance, never a client
      // delete-then-create: putStance replaces the single directed stance.
      await putStance({ sourceRef: `highlight:${highlightId}`, targetRef, kind });
      onChanged();
    },
    [onChanged, resolveTarget, stanceEdges],
  );

  return { mintStance };
}
