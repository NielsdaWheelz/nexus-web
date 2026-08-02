"use client";

/**
 * Completion Undo (spec `docs/cutovers/lectern-player-lifecycle-hard-cutover.md`
 * §6 "Explicit exact completion offers a ten-second Undo HUD").
 *
 * A USER-invoked exact completion (Done / Mark finished — NOT a natural end)
 * offers a 10-second Undo. When that action created the first-completion fact,
 * Undo consumes its sealed handle through `UndoCompletion`; otherwise it uses
 * ordinary `SetUnread`. It then restores the Lectern row after the nearest
 * surviving pre-completion predecessor (else `First`). The FIFO promise contract
 * makes the awaited commands exact: partial failure truthfully retains Unread
 * and exposes only the remaining restore step.
 */

import { useCallback, useEffect, useState } from "react";
import {
  useFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import {
  isApiError,
  isSameSystemApiDefect,
} from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { useLectern } from "@/lib/lectern/LecternProvider";
import type {
  LecternItemId,
  LecternSnapshot,
  MediaId,
  Placement,
  CompletionHandle,
} from "@/lib/lectern/contract";
import type { Presence } from "@/lib/api/presence";

type CompletionUndoFailureStage = "MarkUnread" | "Restore";

export function completionUndoRestoreFeedbackKey(mediaId: MediaId): string {
  return `completion-undo-restore:${mediaId}`;
}

export function CompletionUndoFeedbackOwner() {
  const { resource, onCanonicalInstall } = useLectern();
  const { resolve } = useFeedback();

  useEffect(() => {
    if (resource.status !== "ready") return;
    for (const item of resource.data.items) {
      resolve(completionUndoRestoreFeedbackKey(item.mediaId));
    }
  }, [resolve, resource]);

  useEffect(
    () =>
      onCanonicalInstall((event) => {
        if (event.kind !== "snapshot") return;
        for (const item of event.snapshot.items) {
          resolve(completionUndoRestoreFeedbackKey(item.mediaId));
        }
      }),
    [onCanonicalInstall, resolve],
  );

  return null;
}

/** Exhaustive projection of the modeled failures owned by completion Undo. */
function completionUndoErrorMessage(
  error: unknown,
  stage: CompletionUndoFailureStage,
): FeedbackContent {
  if (!isApiError(error) || isSameSystemApiDefect(error)) throw error;

  const requestId = error.requestId;
  switch (error.code) {
    case "E_NETWORK":
      return {
        tone: stage === "Restore" ? "Warning" : "Danger",
        title:
          stage === "Restore"
            ? "Marked unread; Lectern wasn’t restored"
            : "Couldn’t mark this item unread",
        message: "A network problem interrupted the change. Try again from the item controls.",
        requestId,
      };
    case "E_TIMEOUT":
    case "E_UPSTREAM_TIMEOUT":
      return {
        tone: stage === "Restore" ? "Warning" : "Danger",
        title:
          stage === "Restore"
            ? "Marked unread; Lectern wasn’t restored"
            : "Couldn’t mark this item unread",
        message: "The change timed out. Try again from the item controls.",
        requestId,
      };
    case "E_NOT_FOUND":
    case "E_MEDIA_NOT_FOUND":
      return {
        tone: stage === "Restore" ? "Warning" : "Danger",
        title:
          stage === "Restore"
            ? "Marked unread; Lectern wasn’t restored"
            : "Couldn’t mark this item unread",
        message: "This item is no longer available.",
        requestId,
      };
    case "E_MEDIA_DELETING":
      return {
        tone: stage === "Restore" ? "Warning" : "Danger",
        title:
          stage === "Restore"
            ? "Marked unread; Lectern wasn’t restored"
            : "Couldn’t mark this item unread",
        message: "This item is being removed and can’t be changed.",
        requestId,
      };
    case "E_LIMIT":
      if (stage !== "Restore") throw error;
      return {
        tone: "Warning",
        title: "Marked unread; Lectern wasn’t restored",
        message: "Lectern is full. Remove an item, then restore this one from its controls.",
        requestId,
      };
    case "E_INVALID_REQUEST":
      if (stage !== "MarkUnread") throw error;
      return {
        tone: "Danger",
        title: "Undo is no longer available",
        message: "Mark this item unread from its item controls.",
        requestId,
      };
    default:
      throw error;
  }
}

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
  const { publish, resolve } = useFeedback();
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);

  // Read the freshest canonical snapshot at Undo/Restore time, not at offer time —
  // and source it from the provider (a live FIFO read) rather than a per-pane ref,
  // so it stays correct even if the offering pane unmounts during the 10s HUD.
  const currentSnapshot = useCallback(
    (): LecternSnapshot => getCanonicalSnapshot() ?? { items: [] },
    [getCanonicalSnapshot],
  );

  const runRestore = useCallback(
    async (input: CompletionUndoInput, placement: Placement) => {
      const feedbackKey = completionUndoRestoreFeedbackKey(input.mediaId);
      try {
        await placeItems({ mediaIds: [input.mediaId], placement });
        resolve(feedbackKey);
      } catch (error) {
        if (handleUnauthenticatedApiError(error)) return;
        let content: FeedbackContent;
        try {
          content = completionUndoErrorMessage(error, "Restore");
        } catch (caughtDefect) {
          setDefect({ error: caughtDefect });
          return;
        }
        // Definitive place failure after a committed Unread: truthfully retain
        // Unread and offer only the remaining restore step (freshly resolved).
        publish({
          kind: "Persistent",
          key: feedbackKey,
          content,
          announcement: "Assertive",
          actions: [
            {
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
          ],
        });
      }
    },
    [currentSnapshot, placeItems, publish, resolve],
  );

  const runUndo = useCallback(
    async (input: CompletionUndoInput) => {
      try {
        if (input.completionHandle.kind === "Present") {
          await undoCompletion(input.completionHandle.value, {
            unreadMediaId: input.mediaId,
          });
        } else {
          await setUnread(input.mediaId);
        }
      } catch (error) {
        if (handleUnauthenticatedApiError(error)) return;
        let content: FeedbackContent;
        try {
          content = completionUndoErrorMessage(error, "MarkUnread");
        } catch (caughtDefect) {
          setDefect({ error: caughtDefect });
          return;
        }
        publish({
          kind: "Hud",
          key: `completion-undo-failed:${input.mediaId}`,
          content,
        });
        return;
      }
      const placement = computeRestorePlacement(
        input.preCompletionSnapshot,
        input.completedItemId,
        currentSnapshot(),
      );
      await runRestore(input, placement);
    },
    [currentSnapshot, publish, runRestore, setUnread, undoCompletion],
  );

  const offerUndo = useCallback(
    (input: CompletionUndoInput) => {
      publish({
        kind: "Hud",
        key: `completion-undo:${input.mediaId}`,
        content: {
          tone: "Success",
          title: "Marked as finished",
        },
        actions: [{ label: "Undo", onClick: () => void runUndo(input) }],
      });
    },
    [publish, runUndo],
  );
  if (defect) throw defect.error;
  return offerUndo;
}
