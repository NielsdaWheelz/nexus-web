"use client";

/**
 * Read-state writes: finish (with its exact untimed inverse), mark unread, reset progress and
 * natural-end settlement. Every write is absolute; a resend re-applies. A mounted reader or player
 * holding unsaved progress of the media flushes and pauses it first (`prepare`), and reads the
 * server's answer after (`reconcile`), so its own stale save never contradicts the write (Q7).
 * Each write publishes `Consumption` (and `Lectern` when a row moves).
 */

import { useLayoutEffect, useState, useSyncExternalStore } from "react";
import {
  useFeedback,
  useWorkspaceCondition,
  type FeedbackContextValue,
  type FeedbackOffer,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import {
  apiFetch,
  apiTransportFeedback,
  isApiError,
  isSameSystemApiDefect,
} from "@/lib/api/client";
import { ProgressPreparationError } from "@/lib/consumption/progressFence";
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

/** Await all preparations; reconcile only holder/id pairs that prepared successfully. */
export async function withProgressFence<T>(mediaIds: readonly string[], write: () => Promise<T>): Promise<T> {
  const prepared: { holder: ProgressHolder; mediaId: string }[] = [];
  try {
    const results = await Promise.allSettled([...holders].flatMap(holder =>
      mediaIds.map(async mediaId => {
        await holder.prepare(mediaId);
        prepared.push({ holder, mediaId });
      }),
    ));
    for (const result of results) if (result.status === "rejected") throw result.reason;
    return await write();
  } finally {
    await Promise.allSettled(prepared.map(({ holder, mediaId }) => holder.reconcile(mediaId)));
  }
}

const post = (mediaId: string, verb: string, body?: object) =>
  apiFetch<void>(`/api/media/${mediaId}/${verb}`, {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
  });

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
  if (error instanceof ProgressPreparationError) return { tone: "Warning", title: "progress couldn’t be saved", message: "this attempt did not send the state change. resolve the player or reader save before trying again." };
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

interface UndoEntry {
  commandKey: string;
  mediaId: string;
  receipt: ApiJson<"/media/{media_id}/finish", "post">["data"];
  offer: FeedbackOffer;
  status: "Offered" | "Sending" | "Unconfirmed";
}
interface UndoRecovery {
  commandKey: string;
  key: string;
  content: FeedbackContent;
  busy: boolean;
  retry(): void;
}

/** The finish inverse lives with the account's action owner, beyond any originating pane. */
function createConsumptionCommands(
  feedback: FeedbackContextValue,
  fail: (input: { error: unknown }) => void,
) {
  let live = true;
  const entries = new Map<string, UndoEntry>();
  const listeners = new Set<() => void>();
  let snapshot: readonly UndoRecovery[] = [];
  const publish = () => {
    snapshot = [...entries.values()]
      .filter((entry) => entry.status !== "Offered")
      .map((entry) => ({
        key: `completion-undo:${entry.mediaId}`,
        commandKey: entry.commandKey,
        content: entry.status === "Sending"
          ? { tone: "Neutral", title: "undoing finish…" }
          : {
              tone: "Warning",
              title: "undo is unconfirmed",
              message: "it may already have completed. retry uses the same finish receipt.",
            },
        busy: entry.status === "Sending",
        retry: () => void undo(entry),
      }));
    for (const listener of listeners) listener();
  };
  const invalidate = (mediaId: string) => {
    entries.get(mediaId)?.offer.withdraw();
    entries.delete(mediaId);
    publish();
  };
  async function undo(entry: UndoEntry): Promise<void> {
    if (
      !live ||
      entries.get(entry.mediaId) !== entry ||
      entry.status === "Sending"
    ) return;
    entry.offer.update({
      content: { tone: "Success", title: "marked as finished" },
      announcement: "None",
      actions: [{
        label: "undo",
        commandKey: entry.commandKey,
        onClick: () => void undo(entry),
        busy: true,
      }],
    });
    entry.status = "Sending";
    publish();
    const signal = AbortSignal.timeout(30_000);
    try {
      await withProgressFence([entry.mediaId], () =>
        apiFetch<void>(`/api/media/${entry.mediaId}/finish/undo`, {
          method: "POST",
          body: JSON.stringify(entry.receipt),
          signal,
        }),
      );
    } catch (error) {
      if (!live || entries.get(entry.mediaId) !== entry) return;
      const unknown = !(error instanceof ProgressPreparationError) && (signal.aborted || (
        isApiError(error) &&
        ["E_NETWORK", "E_UPSTREAM", "E_UPSTREAM_TIMEOUT"].includes(error.code)
      ));
      if (unknown) {
        entry.status = "Unconfirmed";
        publish();
        return;
      }
      if (handleUnauthenticatedApiError(error)) return;
      const content = undoFailure(error);
      if (content === null) return fail({ error });
      if (
        isApiError(error) &&
        (error.code === "E_RESOURCE_CONFLICT" || error.status === 404)
      ) {
        invalidate(entry.mediaId);
        feedback.offer({
          key: `completion-undo-result:${entry.mediaId}`,
          content,
          announcement: "Polite",
        });
      } else {
        entry.status = "Offered";
        entry.offer = feedback.offer({
          key: `completion-undo:${entry.mediaId}`,
          content,
          announcement: "Polite",
          actions: [{
            label: "undo",
            commandKey: entry.commandKey,
            onClick: () => void undo(entry),
          }],
        });
        publish();
      }
      return;
    }
    if (!live || entries.get(entry.mediaId) !== entry) return;
    invalidate(entry.mediaId);
    publishChange("Consumption", "Lectern");
    feedback.receipt({ tone: "Success", title: "finish undone" });
  }
  return {
    commands: {
      async finish(
        mediaId: string,
        { leaveLectern }: { leaveLectern: boolean },
      ): Promise<void> {
        if (!live) return;
        const { data: receipt } = await withProgressFence([mediaId], () =>
          apiFetch<ApiJson<"/media/{media_id}/finish", "post">>(
            `/api/media/${mediaId}/finish`,
            {
              method: "POST",
              body: JSON.stringify({ leave_lectern: leaveLectern }),
            },
          ),
        );
        if (!live) return;
        invalidate(mediaId);
        publishChange("Consumption", "Lectern");
        const commandKey = `${mediaId}:${receipt.revision}`;
        const entry: UndoEntry = {
          mediaId,
          receipt,
          commandKey,
          status: "Offered",
          offer: feedback.offer({
            key: `completion-undo:${mediaId}`,
            content: { tone: "Success", title: "marked as finished" },
            announcement: "Polite",
            actions: [{ label: "undo", commandKey, onClick: () => void undo(entry) }],
          }),
        };
        entries.set(mediaId, entry);
      },
      async markUnread(mediaId: string): Promise<void> {
        if (!live) return;
        await withProgressFence([mediaId], () => post(mediaId, "unread"));
        if (!live) return;
        invalidate(mediaId);
        publishChange("Consumption");
      },
      async resetProgress(mediaId: string): Promise<void> {
        if (!live) return;
        await withProgressFence([mediaId], () => post(mediaId, "progress/reset"));
        if (!live) return;
        invalidate(mediaId);
        publishChange("Consumption");
      },
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    snapshot: () => snapshot,
    attach() {
      live = true;
      return () => {
        live = false;
        for (const entry of entries.values()) entry.offer.withdraw();
        entries.clear();
      };
    },
  };
}

export function useConsumptionCommands() {
  const feedback = useFeedback();
  const fail = useThrowLater();
  const [owner] = useState(() => createConsumptionCommands(feedback, fail));
  const recoveries = useSyncExternalStore(
    owner.subscribe,
    owner.snapshot,
    owner.snapshot,
  );
  useLayoutEffect(() => owner.attach(), [owner]);
  return {
    commands: owner.commands,
    feedback: recoveries.map((recovery) => (
      <UndoFeedback key={recovery.key} recovery={recovery} />
    )),
  };
}

function UndoFeedback({ recovery }: { recovery: UndoRecovery }) {
  useWorkspaceCondition(recovery.key, {
    priority: "Write",
    announcement: "Polite",
    content: recovery.content,
    actions: [{
      label: "undo",
      commandKey: recovery.commandKey,
      onClick: recovery.retry,
      busy: recovery.busy,
    }],
  });
  return null;
}
