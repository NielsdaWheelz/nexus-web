"use client";

/**
 * Read-state writes: finish (with its ten-second Undo), mark unread, reset progress and the
 * natural-end settle. Every write is absolute; a resend re-applies. A mounted reader or player
 * holding unsaved progress of the media flushes and pauses it first (`prepare`), and reads the
 * server's answer after (`reconcile`), so its own stale save never contradicts the write (Q7).
 * Each write publishes `Consumption` (and `Lectern` when a row moves).
 */

import { useCallback } from "react";
import {
  useFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import {
  apiFetch,
  apiTransportFeedback,
  isApiError,
  isSameSystemApiDefect,
} from "@/lib/api/client";
import { publishChange } from "@/lib/api/changes";
import { useThrowLater } from "@/lib/api/serverState";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";

export interface ProgressHolder {
  prepare(mediaId: string): Promise<void>;
  reconcile(mediaId: string): Promise<void>;
}

const holders = new Set<ProgressHolder>();

/** Register a mounted reader or player; returns its unregister. */
export function holdProgress(holder: ProgressHolder): () => void {
  holders.add(holder);
  return () => holders.delete(holder);
}

/** A refused preparation sends nothing; every holder reconciles either way. */
async function fenced<T>(mediaId: string, write: () => Promise<T>): Promise<T> {
  const held = [...holders];
  try {
    await Promise.all(held.map((holder) => holder.prepare(mediaId)));
    return await write();
  } finally {
    await Promise.allSettled(held.map((holder) => holder.reconcile(mediaId)));
  }
}

const post = (mediaId: string, verb: string, body?: object) =>
  apiFetch<void>(`/api/media/${mediaId}/${verb}`, {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
  });

export async function markUnread(mediaId: string): Promise<void> {
  await fenced(mediaId, () => post(mediaId, "unread"));
  publishChange("Consumption");
}

export async function resetProgress(mediaId: string): Promise<void> {
  await fenced(mediaId, () => post(mediaId, "progress/reset"));
  publishChange("Consumption");
}

/** 204 settled, 409 superseded (a later unread, reset or finish), 404 gone; others throw. */
export async function settleNaturalEnd(
  mediaId: string,
  body: Schema<"NaturalEndIn">,
): Promise<"Settled" | "Superseded" | "Gone"> {
  try {
    await post(mediaId, "natural-end", body);
  } catch (error) {
    if (isApiError(error) && error.status === 409) return "Superseded";
    if (isApiError(error) && error.status === 404) return "Gone";
    throw error;
  }
  publishChange("Consumption", "Lectern");
  return "Settled";
}

function undoFailure(error: unknown): FeedbackContent | null {
  if (!isApiError(error) || isSameSystemApiDefect(error)) return null;
  if (error.code === "E_RESOURCE_CONFLICT")
    return {
      tone: "Danger",
      title: "Undo is no longer available",
      requestId: error.requestId,
    };
  const title = "Couldn’t undo";
  if (error.code === "E_LIMIT")
    return {
      tone: "Danger",
      title,
      message: "Lectern is full.",
      requestId: error.requestId,
    };
  if (error.status === 404)
    return {
      tone: "Danger",
      title,
      message: "This item is no longer available.",
    };
  return apiTransportFeedback(error, title);
}

/** Finish (leaving the Lectern when asked) and offer "Marked as finished" with Undo. */
export function useFinish(): (
  mediaId: string,
  options: { leaveLectern: boolean },
) => Promise<void> {
  const { publish } = useFeedback();
  const fail = useThrowLater();
  return useCallback(
    async (mediaId, { leaveLectern }) => {
      const { data: finish } = await apiFetch<
        ApiJson<"/media/{media_id}/finish", "post">
      >(`/api/media/${mediaId}/finish`, {
        method: "POST",
        body: JSON.stringify({ leave_lectern: leaveLectern }),
      });
      publishChange("Consumption", "Lectern");
      const undo = async () => {
        try {
          await fenced(mediaId, () => post(mediaId, "finish/undo", finish));
          publishChange("Consumption", "Lectern");
        } catch (error) {
          if (handleUnauthenticatedApiError(error)) return;
          const content = undoFailure(error);
          if (content === null) return fail({ error });
          publish({
            kind: "Hud",
            key: `completion-undo-failed:${mediaId}`,
            content,
          });
        }
      };
      publish({
        kind: "Hud",
        key: `completion-undo:${mediaId}`,
        content: { tone: "Success", title: "Marked as finished" },
        actions: [{ label: "Undo", onClick: () => void undo() }],
      });
    },
    [fail, publish],
  );
}
