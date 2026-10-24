"use client";

/**
 * Read-state writes: finish (with its exact untimed inverse), mark unread, reset progress and
 * natural-end settlement. Every write is absolute; a resend re-applies. A mounted reader or player
 * holding unsaved progress of the media flushes and pauses it first (`prepare`), and reads the
 * server's answer after (`reconcile`), so its own stale save never contradicts the write (Q7).
 * Each write publishes `Consumption` (and `Lectern` when a row moves).
 */

import { useLayoutEffect, useMemo, useSyncExternalStore } from "react";
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
import { useAuthenticatedAccount } from "@/lib/account/authenticatedAccount";
import { useWorkGuard, type WorkGuard } from "@/lib/unsavedWork";
import { createCollectionCommands, CollectionCommandFeedback, type StateChange } from "./collectionCommands";
import { ProgressPreparationError } from "@/lib/consumption/progressFence";
import { publishChange } from "@/lib/api/changes";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";

export interface ProgressHolder {
  prepare(mediaId: string): Promise<void>;
  reconcile(mediaId: string): Promise<void>;
}

const holders = new Set<ProgressHolder>();
const stateSettled = new Set<(change: StateChange) => void>();

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

/** 200 settled (with the canonical observation), 409 superseded (a later unread, reset or
 * finish), 404 gone; others throw. */
export async function settleNaturalEnd(
  mediaId: string,
  body: Schema<"NaturalEndIn">,
): Promise<"Settled" | "Superseded" | "Gone"> {
  const observers = [...stateSettled];
  let revision: number | null;
  try {
    revision = (await apiFetch<ApiJson<"/media/{media_id}/natural-end", "post">>(`/api/media/${mediaId}/natural-end`, { method: "POST", body: JSON.stringify(body) }))
      .data.state.consumption_override_revision;
  } catch (error) {
    if (isApiError(error) && error.status === 409) return "Superseded";
    if (isApiError(error) && error.status === 404) return "Gone";
    throw error;
  }
  if (revision !== null) for (const listener of observers) if (stateSettled.has(listener)) listener({ mediaId, revision });
  publishChange("Consumption", "Podcasts", "Lectern");
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
  uncertain: boolean;
  observed: number | null;
  unregister(): void;
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
  accountId: string,
  guard: WorkGuard,
  fail: (input: { error: unknown }) => void,
) {
  let live = true;
  const entries = new Map<string, UndoEntry>();
  const listeners = new Set<() => void>();
  const finishes = new Set<{ mediaId: string; observed: number | null }>();
  let snapshot: readonly UndoRecovery[] = [];
  const publish = () => {
    snapshot = [...entries.values()]
      .filter((entry) => entry.status !== "Offered")
      .map((entry) => ({
        key: `completion-undo:${entry.commandKey}`,
        commandKey: entry.commandKey,
        content: entry.status === "Sending"
          ? { tone: "Neutral", title: "undoing finish…" }
          : {
              tone: "Warning",
              title: "undo not confirmed",
              message: "it may already have completed. retry uses the same finish receipt.",
            },
        busy: entry.status === "Sending",
        retry: () => void undo(entry),
      }));
    for (const listener of listeners) listener();
  };
  const retire = (entry: UndoEntry) => {
    entry.offer.withdraw(); entry.unregister(); entries.delete(entry.commandKey); publish();
  };
  const invalidate = (revisions: ReadonlyMap<string, number>) => {
    for (const entry of [...entries.values()]) {
      const revision = revisions.get(entry.mediaId);
      if (revision === undefined) continue;
      if (entry.status === "Offered" && revision > entry.receipt.revision) retire(entry);
      else entry.observed = Math.max(entry.observed ?? 0, revision);
    }
    for (const pending of finishes) {
      const revision = revisions.get(pending.mediaId);
      if (revision !== undefined) pending.observed = Math.max(pending.observed ?? 0, revision);
    }
  };
  const collections = createCollectionCommands({ accountId, guard, feedback, fail, supersedeSingle: invalidate, fence: withProgressFence });
  async function undo(entry: UndoEntry): Promise<void> {
    if (
      !live ||
      entries.get(entry.commandKey) !== entry ||
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
    let restoredRevision: number;
    try {
      const response = await withProgressFence([entry.mediaId], () =>
        apiFetch<ApiJson<"/media/{media_id}/finish/undo", "post">>(`/api/media/${entry.mediaId}/finish/undo`, {
          method: "POST",
          body: JSON.stringify(entry.receipt),
          signal,
        }),
      );
      restoredRevision = response.data.override_revision;
    } catch (error) {
      if (!live || entries.get(entry.commandKey) !== entry) return;
      const unknown = !(error instanceof ProgressPreparationError) && (signal.aborted || (
        isApiError(error) &&
        ["E_NETWORK", "E_UPSTREAM", "E_UPSTREAM_TIMEOUT"].includes(error.code)
      ));
      if (unknown) {
        entry.uncertain = true;
        entry.status = "Unconfirmed";
        publish();
        return;
      }
      if (handleUnauthenticatedApiError(error)) return;
      const content = undoFailure(error);
      if (content === null) return fail({ error });
      if (entry.uncertain) {
        entry.status = "Unconfirmed";
        entry.offer.withdraw();
        entry.offer = feedback.offer({ key: `completion-undo-result:${entry.mediaId}`, content: { ...content, title: "undo not confirmed", message: "these items changed; this attempt changed nothing. earlier undo outcome remains unconfirmed." }, announcement: "Polite" });
        publish();
      } else if (
        isApiError(error) &&
        (error.code === "E_RESOURCE_CONFLICT" || error.status === 404)
      ) {
        retire(entry);
        feedback.offer({
          key: `completion-undo-result:${entry.mediaId}`,
          content,
          announcement: "Polite",
        });
      } else if (entry.observed !== null && entry.observed > entry.receipt.revision) {
        retire(entry);
        feedback.offer({ key: `completion-undo-result:${entry.commandKey}`, announcement: "Polite", content: { tone: "Warning", title: "these items changed; this attempt changed nothing." } });
      } else {
        entry.status = "Offered";
        entry.offer = feedback.offer({
          key: `completion-undo:${entry.commandKey}`,
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
    if (!live || entries.get(entry.commandKey) !== entry) return;
    retire(entry);
    collections.supersede([{ mediaId: entry.mediaId, revision: restoredRevision }]);
    publishChange("Consumption", "Podcasts", "Lectern");
    feedback.settleCondition({ key: `completion-undo:${entry.commandKey}`, content: { tone: "Success", title: "finish undone" } });
  }
  return {
    collections,
    commands: {
      ...collections.commands,
      async finish(
        mediaId: string,
        { leaveLectern }: { leaveLectern: boolean },
      ): Promise<void> {
        if (!live) return;
        const pending: { mediaId: string; observed: number | null } = { mediaId, observed: null };
        finishes.add(pending);
        let receipt: UndoEntry["receipt"];
        try {
          receipt = (await withProgressFence([mediaId], () =>
            apiFetch<ApiJson<"/media/{media_id}/finish", "post">>(`/api/media/${mediaId}/finish`, {
              method: "POST", body: JSON.stringify({ leave_lectern: leaveLectern }),
            }),
          )).data;
        } finally { finishes.delete(pending); }
        if (!live) return;
        collections.supersede([{ mediaId, revision: receipt.revision }]);
        publishChange("Consumption", "Podcasts", "Lectern");
        if (pending.observed !== null && pending.observed > receipt.revision) {
          feedback.receipt({ tone: "Success", title: "finish acknowledged; undo is unavailable after overlapping state changes" });
          return;
        }
        const commandKey = `${mediaId}:${receipt.revision}:${crypto.randomUUID()}`;
        const entry: UndoEntry = {
          mediaId,
          receipt,
          commandKey,
          status: "Offered",
          uncertain: false,
          observed: null,
          unregister: () => {},
          offer: feedback.offer({
            key: `completion-undo:${commandKey}`,
            content: { tone: "Success", title: "marked as finished" },
            announcement: "Polite",
            actions: [{ label: "undo", commandKey, onClick: () => void undo(entry) }],
          }),
        };
        entry.unregister = guard.register({ id: `completion-undo:${commandKey}`, scope: { kind: "account" }, subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, read: () => ({ changed: false, unconfirmed: entry.status !== "Offered", stopsBrowserWork: false }) });
        entries.set(commandKey, entry);
      },
      async markUnread(mediaId: string): Promise<void> {
        if (!live) return;
        const response = await withProgressFence([mediaId], () => apiFetch<ApiJson<"/media/{media_id}/unread", "post">>(`/api/media/${mediaId}/unread`, { method: "POST" }));
        if (!live) return;
        collections.supersede([{ mediaId, revision: response.data.override_revision }]);
        publishChange("Consumption", "Podcasts");
      },
      async resetProgress(mediaId: string): Promise<void> {
        if (!live) return;
        const response = await withProgressFence([mediaId], () => apiFetch<ApiJson<"/media/{media_id}/progress/reset", "post">>(`/api/media/${mediaId}/progress/reset`, { method: "POST" }));
        if (!live) return;
        collections.supersede([{ mediaId, revision: response.data.override_revision }]);
        publishChange("Consumption", "Podcasts");
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
      const stopCollections = collections.start();
      const settled = (change: StateChange) => collections.supersede([change]);
      stateSettled.add(settled);
      return () => {
        live = false;
        stopCollections();
        stateSettled.delete(settled);
        for (const entry of entries.values()) { entry.offer.withdraw(); entry.unregister(); }
        entries.clear();
        finishes.clear();
      };
    },
  };
}

export function useConsumptionCommands(reportDefect: (failure: { error: unknown }) => void) {
  const feedback = useFeedback();
  const { accountId } = useAuthenticatedAccount();
  const guard = useWorkGuard();
  const owner = useMemo(() => createConsumptionCommands(feedback, accountId, guard, reportDefect), [feedback, accountId, guard, reportDefect]);
  const bulk = useSyncExternalStore(owner.collections.subscribe, owner.collections.snapshot, owner.collections.snapshot);
  const recoveries = useSyncExternalStore(
    owner.subscribe,
    owner.snapshot,
    owner.snapshot,
  );
  useLayoutEffect(() => owner.attach(), [owner]);
  return {
    commands: owner.commands,
    feedback: <>
      {recoveries.map(recovery => <UndoFeedback key={recovery.key} recovery={recovery} />)}
      {bulk.map(entry => <CollectionCommandFeedback key={entry.key} entry={entry} commands={owner.collections.commands} />)}
    </>,
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
