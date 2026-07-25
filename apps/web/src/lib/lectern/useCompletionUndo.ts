"use client";

/**
 * Completion Undo (spec `docs/cutovers/lectern-player-lifecycle-hard-cutover.md`
 * §6 "Explicit exact completion offers a ten-second Undo toast").
 *
 * A USER-invoked exact completion (Done / Mark finished — NOT a natural end)
 * offers a 10-second Undo. When that action created the first-completion fact,
 * Undo consumes its sealed handle through `UndoCompletion`; otherwise it uses
 * ordinary `SetUnread`. It then restores the Lectern row after the nearest
 * surviving pre-completion predecessor (else `First`). The FIFO promise contract
 * makes the awaited commands exact: partial failure truthfully retains Unread
 * and exposes only the remaining restore step.
 */

import { useCallback } from "react";
import { useFeedback } from "@/components/feedback/Feedback";
import { useLectern } from "@/lib/lectern/LecternProvider";
import type {
  LecternItemId,
  LecternSnapshot,
  MediaId,
  Placement,
  CompletionHandle,
} from "@/lib/lectern/contract";
import type { Presence } from "@/lib/api/presence";

const UNDO_DURATION_MS = 10_000;

/** Placement restoring `mediaId` after the nearest pre-completion predecessor
 * that still exists in the current canonical snapshot; else `First`. */
function computeRestorePlacement(
  preCompletionSnapshot: LecternSnapshot,
  completedItemId: LecternItemId | null,
  currentSnapshot: LecternSnapshot,
): Placement {
  if (completedItemId !== null) {
    const currentIds = new Set<string>(currentSnapshot.items.map((item) => item.itemId));
    const index = preCompletionSnapshot.items.findIndex((item) => item.itemId === completedItemId);
    if (index >= 0) {
      for (let predecessor = index - 1; predecessor >= 0; predecessor -= 1) {
        const candidate = preCompletionSnapshot.items[predecessor].itemId;
        if (currentIds.has(candidate)) {
          return { kind: "After", itemId: candidate };
        }
      }
    }
  }
  return { kind: "First" };
}

export interface CompletionUndoInput {
  mediaId: MediaId;
  /** The Lectern snapshot BEFORE the completion removed the row. */
  preCompletionSnapshot: LecternSnapshot;
  /** The exact item that was completed, or null when the media had no Lectern row. */
  completedItemId: LecternItemId | null;
  completionHandle: Presence<CompletionHandle>;
}

export function useCompletionUndo(): (input: CompletionUndoInput) => void {
  const { setUnread, undoCompletion, placeItems, getCanonicalSnapshot } = useLectern();
  const { show } = useFeedback();

  // Read the freshest canonical snapshot at Undo/Restore time, not at offer time —
  // and source it from the provider (a live FIFO read) rather than a per-pane ref,
  // so it stays correct even if the offering pane unmounts during the 10s toast.
  const currentSnapshot = useCallback(
    (): LecternSnapshot => getCanonicalSnapshot() ?? { items: [] },
    [getCanonicalSnapshot],
  );

  const runRestore = useCallback(
    async (input: CompletionUndoInput, placement: Placement) => {
      try {
        await placeItems({ mediaIds: [input.mediaId], placement });
      } catch {
        // Definitive place failure after a committed Unread: truthfully retain
        // Unread and offer only the remaining restore step (freshly resolved).
        show({
          severity: "warning",
          title: "Marked unread; could not restore to Lectern",
          dedupeKey: `completion-undo-restore:${input.mediaId}`,
          duration: 0,
          action: {
            label: "Restore",
            onClick: () => {
              const fresh = computeRestorePlacement(
                input.preCompletionSnapshot,
                input.completedItemId,
                currentSnapshot(),
              );
              void runRestore(input, fresh);
            },
          },
        });
      }
    },
    [currentSnapshot, placeItems, show],
  );

  const runUndo = useCallback(
    async (input: CompletionUndoInput) => {
      try {
        if (input.completionHandle.kind === "Present") {
          await undoCompletion(input.completionHandle.value);
        } else {
          await setUnread(input.mediaId);
        }
      } catch {
        show({ severity: "error", title: "Could not mark unread" });
        return;
      }
      const placement = computeRestorePlacement(
        input.preCompletionSnapshot,
        input.completedItemId,
        currentSnapshot(),
      );
      await runRestore(input, placement);
    },
    [currentSnapshot, runRestore, setUnread, show, undoCompletion],
  );

  return useCallback(
    (input: CompletionUndoInput) => {
      show({
        severity: "success",
        title: "Marked as finished",
        dedupeKey: `completion-undo:${input.mediaId}`,
        duration: UNDO_DURATION_MS,
        action: { label: "Undo", onClick: () => void runUndo(input) },
      });
    },
    [runUndo, show],
  );
}
