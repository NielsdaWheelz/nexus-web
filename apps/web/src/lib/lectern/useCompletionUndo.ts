"use client";

/**
 * The ten-second "Marked as finished" HUD with Undo, offered after a user's own finish (mark as
 * played, or done). Undo is one atomic command naming that finish: the server puts back the
 * override and completion it replaced, and after a done the row with its id and added time
 * behind its nearest surviving predecessor.
 */

import { useCallback, useState } from "react";
import {
  useFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import {
  apiTransportFeedback,
  isApiError,
  isSameSystemApiDefect,
} from "@/lib/api/client";
import { absent, present, type Presence } from "@/lib/api/presence";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import type {
  FinishId,
  LecternSnapshot,
  MediaId,
  UndoRestore,
} from "@/lib/lectern/contract";
import { useLectern } from "@/lib/lectern/LecternProvider";

export interface CompletionUndoInput {
  mediaId: MediaId;
  /** The Lectern before the finish. */
  before: LecternSnapshot;
  /** The finish's `finishId`; without one there is nothing to undo. */
  finishId: Presence<FinishId>;
  /** The finish was a done, which removed the row. */
  done: boolean;
}

function undoFailure(error: unknown): FeedbackContent | null {
  if (!isApiError(error) || isSameSystemApiDefect(error)) return null;
  const title = "Couldn’t undo";
  switch (error.code) {
    case "E_INVALID_REQUEST":
      return {
        tone: "Danger",
        title: "Undo is no longer available",
        requestId: error.requestId,
      };
    case "E_LIMIT":
      return {
        tone: "Danger",
        title,
        message: "Lectern is full.",
        requestId: error.requestId,
      };
    case "E_NOT_FOUND":
    case "E_MEDIA_NOT_FOUND":
      return {
        tone: "Danger",
        title,
        message: "This item is no longer available.",
      };
    default:
      return apiTransportFeedback(error, title);
  }
}

export function useCompletionUndo(
  reconcile: (mediaId: MediaId) => void,
): (input: CompletionUndoInput) => void {
  const { undoFinish, getCanonicalSnapshot } = useLectern();
  const { publish } = useFeedback();
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);

  const undo = useCallback(
    async (input: CompletionUndoInput, finishId: FinishId) => {
      let restore: Presence<UndoRestore> = absent();
      const index = input.before.items.findIndex(
        (item) => item.mediaSummary.mediaId === input.mediaId,
      );
      if (input.done && index >= 0) {
        const now = new Set(
          getCanonicalSnapshot()?.items.map((item) => item.itemId),
        );
        const after = input.before.items
          .slice(0, index)
          .reverse()
          .find((item) => now.has(item.itemId));
        const { itemId, addedAt } = input.before.items[index];
        restore = present({
          itemId,
          addedAt,
          after: after ? present(after.itemId) : absent(),
        });
      }
      try {
        await undoFinish({
          mediaId: input.mediaId,
          finishId,
          restore,
        });
      } catch (error) {
        if (handleUnauthenticatedApiError(error)) return;
        const content = undoFailure(error);
        if (content === null) setDefect({ error });
        else
          publish({
            kind: "Hud",
            key: `completion-undo-failed:${input.mediaId}`,
            content,
          });
        return;
      }
      reconcile(input.mediaId);
    },
    [getCanonicalSnapshot, publish, reconcile, undoFinish],
  );

  const offer = useCallback(
    (input: CompletionUndoInput) => {
      const { finishId } = input;
      const action = finishId.kind === "Present" && {
        label: "Undo",
        onClick: () => void undo(input, finishId.value),
      };
      publish({
        kind: "Hud",
        key: `completion-undo:${input.mediaId}`,
        content: { tone: "Success", title: "Marked as finished" },
        actions: action ? [action] : undefined,
      });
    },
    [publish, undo],
  );
  if (defect) throw defect.error;
  return offer;
}
