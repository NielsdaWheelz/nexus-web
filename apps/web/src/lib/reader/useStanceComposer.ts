"use client";

import { useCallback, useEffect, useRef } from "react";
import { isEditableTarget } from "@/lib/ui/isEditableTarget";
import { createUserEdge, deleteUserEdge } from "@/lib/resourceGraph/edges";

export type StanceKind = "supports" | "contradicts";

/**
 * A reader-local single-key chord, parameterized on the key — the modal
 * "focus-a-passage + one dedicated key" stance shape (D-11), mirroring
 * useHighlightNoteChord. Fires only while enabled (a passage is focused), never
 * inside an editable target, never with a modifier.
 */
export function useReaderKeyChord(args: {
  enabled: boolean;
  key: string;
  onTrigger: () => void;
}): void {
  const onTriggerRef = useRef(args.onTrigger);
  onTriggerRef.current = args.onTrigger;

  useEffect(() => {
    if (!args.enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== args.key) return;
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      if (isEditableTarget(event.target)) return;
      event.preventDefault();
      onTriggerRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [args.enabled, args.key]);
}

export interface StanceEdgeRef {
  sourceHighlightId: string;
  kind: StanceKind;
  edgeId: string;
}

/**
 * Owns the two stance chords (Take a Side, §4.6): concede (`supports`) and doubt
 * (`contradicts`) mint a user-origin stance edge from the focused passage with no
 * dialog and no AI (N-2). The server upgrades the `media` target to its covering
 * evidence_span when one resolves (span-preferred, media-fallback). Pressing the
 * same key again toggles the mark off; the opposite key replaces it. createUserEdge
 * sends only source/target/kind — the server forbids any edge payload here (N-3).
 */
export function useStanceComposer({
  resolveTarget,
  stanceEdges,
  onChanged,
}: {
  /** Resolve the focused/created source highlight + its media-grain target ref. */
  resolveTarget: () => Promise<{ highlightId: string; targetRef: string } | null>;
  /** Current user stance edges anchored in this reader (derived from connections). */
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
        await deleteUserEdge(same.edgeId);
        onChanged();
        return;
      }
      const opposite = stanceEdges.find(
        (edge) => edge.sourceHighlightId === highlightId && edge.kind !== kind,
      );
      if (opposite) {
        await deleteUserEdge(opposite.edgeId);
      }
      await createUserEdge({ sourceRef: `highlight:${highlightId}`, targetRef, kind });
      onChanged();
    },
    [onChanged, resolveTarget, stanceEdges],
  );

  return { mintStance };
}
